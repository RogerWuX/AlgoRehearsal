const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, sampleProblem, assessment } = require('./helpers/fixtures.cjs');

const native = Object.fromEntries(['Modal', 'Pressable', 'Text', 'TextInput', 'View', 'ScrollView'].map(name => [name, name]));
native.StyleSheet = { create: value => value };
native.useWindowDimensions = () => ({ width: 1000 });
function elements(type, node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(item => elements(type, item));
  return [...(node.type === type ? [node] : []), ...elements(type, node.props?.children)];
}
function reactHarness() {
  let cursor = 0;
  const states = [], dependencies = [], effects = [];
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!dependencies[index] || deps.some((value, i) => !Object.is(value, dependencies[index][i]))) {
        dependencies[index] = deps;
        effects.push(callback);
      }
    },
  };
  return { react, render: callback => { cursor = 0; const result = callback(); effects.splice(0).forEach(effect => effect()); return result; } };
}
function appHarness(initial) {
  const hooks = reactHarness(), resumes = [], saves = [], grades = [], recoveryFlags = [], editorPersistence = [];
  let settings = initial;
  const session = {
    problem: sampleProblem, storedProblemCount: 0, status: 'disconnected', judgment: { status: 'idle' },
    messages: [{ id: 1, role: 'user', text: 'saved discussion' }], shouldResume: true, canResume: true,
    discussion: 'Saved written discussion', setDiscussion: text => { session.discussion = text; },
    configureRecovery: enabled => recoveryFlags.push(enabled), acknowledgeRecovery: () => { session.shouldResume = false; },
    resume: (value, automatic = false) => resumes.push({ config: plain(value), automatic }),
    disconnect: () => { session.shouldResume = false; session.canResume = true; },
    retryJudgment: value => grades.push(plain(value)), endInterview() {}, cancelJudgment() {}, connect() {}, retry() {},
  };
  const ChatPanel = () => null, ResultsPanel = () => null, CredentialsDialog = () => null, SettingsDialog = () => null, EditorWorkspace = () => null;
  const App = load('src/App.tsx', {}, {
    react: hooks.react, 'react-native': native, 'expo-status-bar': { StatusBar: () => null },
    './features/editor': { EditorWorkspace, useEditorDocument: enabled => { editorPersistence.push(enabled); return { text: 'code', language: 'C++', setText() {}, setLanguage() {}, storageStatus: 'saved' }; } },
    './features/interview': { ChatPanel, ResultsPanel, useInterviewSession: () => ({ ...session }), formatProblem: () => 'Problem' },
    './features/settings': { CredentialsDialog, SettingsDialog, useSettingsPreferences: () => ({ config: settings,
      saveConfig: value => { settings = value; saves.push(plain(value)); }, storageStatus: 'saved' }) },
  }).default;
  return { render: () => hooks.render(App), session, resumes, saves, grades, recoveryFlags, editorPersistence, ChatPanel, ResultsPanel, CredentialsDialog, EditorWorkspace, SettingsDialog };
}

test('App makes editor persistence follow saved interview settings', () => {
  const h = appHarness({ ...config, saveInterviewState: false });
  h.session.shouldResume = false;
  let tree = h.render();
  assert.equal(h.editorPersistence.at(-1), false);
  elements('Pressable', tree)[0].props.onPress();
  tree = h.render();
  elements(h.SettingsDialog, tree)[0].props.onSave({ ...config, saveInterviewState: true });
  tree = h.render();
  assert.equal(h.editorPersistence.at(-1), true);
  elements('Pressable', tree)[0].props.onPress();
  tree = h.render();
  elements(h.SettingsDialog, tree)[0].props.onSave({ ...config, saveInterviewState: false });
  h.render();
  assert.equal(h.editorPersistence.at(-1), false);
});

test('App resumes automatically once when credentials are available', () => {
  const initial = { ...config, saveInterviewState: true, rememberApiKeys: true };
  const h = appHarness(initial);
  h.render();
  const tree = h.render();
  assert.deepEqual(h.resumes, [{ config: initial, automatic: true }]);
  assert.deepEqual(h.recoveryFlags, [true]);
  assert.equal(elements(h.CredentialsDialog, tree).length, 0);
  h.render();
  assert.equal(h.resumes.length, 1);
});

test('new controller snapshots do not repeat recovery configuration or automatic resumption', () => {
  const initial = { ...config, saveInterviewState: true };
  const h = appHarness(initial);
  h.session.shouldResume = false;
  const first = elements(h.ChatPanel, h.render())[0].props.live;
  h.session.messages = [...h.session.messages, { id: 2, role: 'assistant', text: 'Restored response' }];
  const second = elements(h.ChatPanel, h.render())[0].props.live;
  assert.notEqual(first, second);
  assert.deepEqual(h.recoveryFlags, [true]);
  assert.equal(h.resumes.length, 0);

  h.session.shouldResume = true;
  h.render();
  h.session.status = 'connecting';
  h.render();
  h.session.status = 'connected';
  h.render();
  assert.deepEqual(h.recoveryFlags, [true]);
  assert.deepEqual(h.resumes, [{ config: initial, automatic: true }]);
});

test('missing credentials prompt before resumption, support cancellation, and continue after re-entry', () => {
  const initial = { ...config, saveInterviewState: true, rememberApiKeys: false,
    live: { ...config.live, credential: '' }, thinking: { ...config.thinking, apiKey: '' } };
  const h = appHarness(initial);
  h.render();
  let tree = h.render();
  assert.equal(h.resumes.length, 0);
  let dialog = elements(h.CredentialsDialog, tree)[0];
  assert.equal(dialog.props.requireLive, true);
  dialog.props.onCancel();
  tree = h.render();
  assert.equal(elements(h.CredentialsDialog, tree).length, 0);
  assert.equal(h.session.canResume, true);
  elements(h.ChatPanel, tree)[0].props.onResume();
  tree = h.render();
  dialog = elements(h.CredentialsDialog, tree)[0];
  const entered = { ...config, saveInterviewState: true, rememberApiKeys: true };
  dialog.props.onContinue(entered);
  tree = h.render();
  assert.deepEqual(h.saves, [entered]);
  assert.deepEqual(h.resumes, [{ config: entered, automatic: false }]);
  assert.equal(elements(h.CredentialsDialog, tree).length, 0);
});

test('retrying restored grading prompts only for Thinking and does not resume Live', () => {
  const initial = { ...config, saveInterviewState: true, thinking: { ...config.thinking, apiKey: '' } };
  const h = appHarness(initial);
  h.session.shouldResume = false;
  h.session.canResume = false;
  h.session.judgment = { status: 'failed' };
  let tree = h.render();
  assert.equal(elements(h.EditorWorkspace, tree)[0].props.showResults, false);
  elements(h.ChatPanel, tree)[0].props.onRetryJudgment();
  tree = h.render();
  const dialog = elements(h.CredentialsDialog, tree)[0];
  assert.equal(dialog.props.requireLive, false);
  dialog.props.onContinue(config);
  assert.deepEqual(h.grades, [config.thinking]);
  assert.equal(h.resumes.length, 0);
});

test('App opens restored partial Results and preserves the saved discussion in Workspace', () => {
  const h = appHarness({ ...config, saveInterviewState: true });
  h.session.shouldResume = false;
  h.session.judgment = { status: 'canceled', code: assessment('code'), interview: null };
  h.render();
  let tree = h.render();
  const workspace = elements(h.EditorWorkspace, tree)[0].props;
  assert.equal(workspace.showResults, true);
  assert.equal(workspace.tab, 'results');
  assert.equal(workspace.discussion, 'Saved written discussion');
  workspace.onTabChange('workspace');
  workspace.onDiscussionChange('Updated written discussion');
  tree = h.render();
  assert.equal(elements(h.EditorWorkspace, tree)[0].props.tab, 'workspace');
  assert.equal(elements(h.EditorWorkspace, tree)[0].props.discussion, 'Updated written discussion');
});

test('credential dialog validates independent keys and retains keys only by explicit toggle', () => {
  const hooks = reactHarness(), saved = [], canceled = [];
  const Dialog = load('src/features/settings/components/CredentialsDialog.tsx', {}, { react: hooks.react, 'react-native': native }).default;
  const props = { config: { ...config, live: { ...config.live, credential: '' }, thinking: { ...config.thinking, apiKey: '' } },
    requireLive: true, onContinue: next => saved.push(plain(next)), onCancel: () => canceled.push(true) };
  const render = () => hooks.render(() => Dialog(props));
  let tree = render();
  const continueButton = () => elements('Pressable', tree).find(item => item.props.accessibilityLabel === 'Continue');
  const remember = () => elements('Pressable', tree).find(item => item.props.accessibilityLabel === 'Remember API keys for this session');
  assert.equal(remember().props.accessibilityState.selected, false);
  assert.equal(continueButton().props.disabled, true);
  elements('TextInput', tree)[0].props.onChangeText(' live replacement ');
  tree = render();
  elements('TextInput', tree)[1].props.onChangeText('auth_tokens/not-a-thinking-key');
  tree = render();
  assert.equal(continueButton().props.disabled, true);
  continueButton().props.onPress();
  assert.equal(saved.length, 0);
  elements('TextInput', tree)[1].props.onChangeText(' thinking replacement ');
  tree = render();
  assert.equal(continueButton().props.disabled, false);
  remember().props.onPress();
  tree = render();
  continueButton().props.onPress();
  assert.equal(saved[0].rememberApiKeys, true);
  assert.equal(saved[0].live.credential, 'live replacement');
  assert.equal(saved[0].thinking.apiKey, 'thinking replacement');
  elements('Pressable', tree).find(item => item.props.accessibilityLabel === 'Cancel').props.onPress();
  assert.equal(canceled.length, 1);
});

test('restored chat offers Resume without credentials and audio activation when connected', () => {
  let resumed = 0, enabled = 0;
  const Chat = load('src/features/interview/components/ChatPanel/ChatPanel.tsx', {}, {
    'react-native': native, react: { useState: () => ['', () => {}], useRef: () => ({ current: null }) },
  }).default;
  const props = { configured: false, retryConfigured: false, onResume: () => { resumed++; }, onStart() {}, onRetry() {}, onEnd() {}, onOpenSettings() {},
    live: { status: 'disconnected', messages: [], judgment: { status: 'idle' }, canResume: true, enableAudio: () => { enabled++; } } };
  let tree = Chat(props);
  const button = label => elements('Pressable', tree).find(item => elements('Text', item).some(text => text.props.children === label));
  button('Resume interview').props.onPress();
  assert.equal(resumed, 1);
  tree = Chat({ ...props, live: { ...props.live, status: 'connected', canResume: false, audioNeedsInteraction: true } });
  button('Enable audio').props.onPress();
  assert.equal(enabled, 1);
});
