const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, sampleProblem, assessment, memoryStorage } = require('./helpers/fixtures.cjs');

function elements(type, node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(item => elements(type, item));
  return [...(node.type === type ? [node] : []), ...elements(type, node.props?.children)];
}
function renderComponents(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(renderComponents);
  if (typeof node.type === 'function') return renderComponents(node.type(node.props));
  return { ...node, props: { ...node.props, children: renderComponents(node.props?.children) } };
}
const native = {
  ...Object.fromEntries(['Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])),
  StyleSheet: { create: value => value }, useWindowDimensions: () => ({ width: 320 }),
};
const captured = { code: '', language: 'Python', problem: sampleProblem, messages: [], submittedAt: '2026-10-10T10:00:00Z' };

test('Results shows available feedback during grading and offers retry only after grading stops', () => {
  const Results = load('src/features/interview/components/ResultsPanel.tsx', {}, { 'react-native': native }).default;
  let retries = 0, opens = 0, cancels = 0;
  const props = { retryConfigured: true, onRetry: () => { retries++; }, onOpenSettings: () => { opens++; }, onCancel: () => { cancels++; } };
  const judgment = { status: 'failed', phase: null, submission: captured, code: assessment('code'), interview: null, errors: { interview: 'Interview timed out.' } };
  let tree = renderComponents(Results({ ...props, judgment }));
  const alert = elements('Text', tree).find(item => item.props.children === 'Interview timed out.');
  assert.equal(alert.props.accessibilityRole, 'alert');
  assert.ok(elements('Text', tree).some(text => text.props.children === 'Code feedback'));
  assert.ok(elements('Text', tree).some(text => text.props.children === 'Interview feedback'));
  elements('Pressable', tree)[0].props.onPress();
  assert.equal(retries, 1);
  tree = renderComponents(Results({ ...props, retryConfigured: false, judgment }));
  elements('Pressable', tree)[0].props.onPress();
  assert.equal(opens, 1);
  tree = renderComponents(Results({ ...props, judgment: { ...judgment, status: 'running', phase: 'interview' } }));
  assert.ok(elements('Text', tree).some(item => item.props.accessibilityLiveRegion === 'polite'));
  assert.ok(elements('Text', tree).some(text => text.props.children === 'code feedback'));
  assert.equal(elements('Pressable', tree).length, 1);
  elements('Pressable', tree)[0].props.onPress();
  assert.equal(cancels, 1);
  tree = renderComponents(Results({ ...props, judgment: { ...judgment, status: 'completed', interview: assessment('interview'), errors: {} } }));
  assert.equal(elements('Pressable', tree).length, 0);
});

test('workspace keyboard navigation covers only visible tabs and wraps at both ends', () => {
  let selected, focused;
  const Tabs = load('src/features/editor/components/EditorTabs/EditorTabs.web.tsx', {}, { react: { useRef: () => ({ current: {} }) } }).default;
  const props = { value: 'workspace', onChange: tab => { selected = tab; } };
  let buttons = elements('button', Tabs({ ...props, showResults: false }));
  assert.deepEqual(buttons.map(button => button.props.children), ['Workspace']);
  buttons.forEach(button => button.props.ref({ focus: () => { focused = button.props.id; } }));
  function key(index, name, expected) {
    let prevented = false;
    buttons[index].props.onKeyDown({ key: name, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true); assert.equal(selected, expected); assert.equal(focused, `${expected}-tab`);
  }
  for (const name of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) key(0, name, 'workspace');
  buttons = elements('button', Tabs({ ...props, showResults: true }));
  assert.deepEqual(buttons.map(button => button.props.children), ['Workspace', 'Results']);
  assert.deepEqual(buttons.map(button => button.props.tabIndex), [0, -1]);
  buttons.forEach(button => button.props.ref({ focus: () => { focused = button.props.id; } }));
  key(0, 'ArrowRight', 'results'); key(1, 'ArrowRight', 'workspace'); key(0, 'ArrowLeft', 'results');
  key(1, 'Home', 'workspace'); key(0, 'End', 'results');
});

for (const language of load('src/features/editor/model/types.ts').editorLanguages) test(`App restores ${language} for grading and quitting, opens Results, and locks Settings`, () => {
  const states = [], deps = [], pendingEffects = []; let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    },
    useEffect(callback, dependencies) {
      const index = cursor++;
      if (!deps[index] || dependencies.some((value, i) => !Object.is(value, deps[index][i]))) {
        deps[index] = dependencies;
        pendingEffects.push(callback);
      }
    },
  };
  let settings = { ...config, problemSource: 'stored', saveInterviewState: true };
  const ends = [], retries = [], sends = []; let quits = 0;
  const session = {
    status: 'connected', problem: sampleProblem, storedProblemCount: 1, judgment: { status: 'idle' },
    discussion: '', setDiscussion: value => { session.discussion = value; },
    send: (...args) => { sends.push(plain(args)); return true; },
    endInterview: (...args) => { ends.push(plain(args)); }, retry: value => { retries.push(value); },
    connect() {}, retryJudgment() {}, cancelJudgment() {},
    quit() { quits++; session.status = 'disconnected'; session.problem = null; session.discussion = ''; session.judgment = { status: 'idle' }; },
    configureRecovery() {},
  };
  const EditorWorkspace = () => null, ChatPanel = () => null, ResultsPanel = () => null, SettingsDialog = () => null, CredentialsDialog = () => null;
  const storage = memoryStorage();
  storage.setItem('interview-practice.editor.document', JSON.stringify({ version: 1, text: 'restored code\n😀', language }));
  const useEditorDocument = load('src/features/editor/hooks/useEditorDocument.web.ts', { window: { localStorage: storage } }, { react }).default;
  const App = load('src/App.tsx', {}, {
    react, 'react-native': native, 'expo-status-bar': { StatusBar: () => null },
    './features/editor': { EditorWorkspace, useEditorDocument },
    './features/interview': { ChatPanel, ResultsPanel, useInterviewSession: () => session, formatProblem: () => 'Problem' },
    './features/settings': { SettingsDialog, CredentialsDialog, useSettingsPreferences: () => ({ config: settings, saveConfig() {}, storageStatus: 'session' }) },
  }).default;
  const render = () => { cursor = 0; const tree = App(); pendingEffects.splice(0).forEach(effect => effect()); return tree; };
  let tree = render(); tree = render();
  assert.equal(elements(EditorWorkspace, tree)[0].props.language, language);
  assert.equal(elements(EditorWorkspace, tree)[0].props.text, 'restored code\n😀');
  assert.equal(elements(EditorWorkspace, tree)[0].props.showResults, false);
  elements(EditorWorkspace, tree)[0].props.onDiscussionChange('Use a map.');
  tree = render();
  assert.equal(elements(EditorWorkspace, tree)[0].props.discussion, 'Use a map.');
  assert.equal(elements(EditorWorkspace, tree)[0].props.canSendDiscussion, true);
  elements(EditorWorkspace, tree)[0].props.onDiscussionSend();
  assert.deepEqual(sends, [['Use a map.', { kind: 'discussion' }]]);
  assert.equal(elements(EditorWorkspace, render())[0].props.discussion, 'Use a map.');
  elements(ChatPanel, tree)[0].props.onEnd();
  assert.deepEqual(ends.shift(), [{ code: 'restored code\n😀', language }, config.thinking]);
  elements(EditorWorkspace, tree)[0].props.onTextChange('exact submitted code\n');
  elements(EditorWorkspace, tree)[0].props.onLanguageChange('C++');
  tree = render();
  elements(ChatPanel, tree)[0].props.onEnd();
  assert.deepEqual(ends, [[{ code: 'exact submitted code\n', language: 'C++' }, config.thinking]]);
  elements(ChatPanel, tree)[0].props.onRetry();
  assert.equal(retries[0], settings);
  elements('Pressable', tree)[0].props.onPress();
  session.status = 'judging'; session.judgment = { status: 'running', phase: 'code' };
  tree = render();
  assert.equal(elements(SettingsDialog, tree)[0].props.locked, true);
  assert.equal(elements(EditorWorkspace, tree)[0].props.canSendDiscussion, false);
  assert.equal(elements(EditorWorkspace, tree)[0].props.showResults, false);
  session.judgment = { status: 'running', phase: 'interview', code: assessment('code') };
  render(); tree = render();
  assert.equal(elements(EditorWorkspace, tree)[0].props.tab, 'results');
  assert.equal(elements(EditorWorkspace, tree)[0].props.showResults, true);
  elements(EditorWorkspace, tree)[0].props.onTabChange('workspace');
  session.status = 'disconnected'; session.judgment = { status: 'completed', code: assessment('code'), interview: assessment('interview') };
  tree = render();
  assert.equal(elements(EditorWorkspace, tree)[0].props.tab, 'workspace');
  assert.equal(elements(EditorWorkspace, tree)[0].props.text, 'exact submitted code\n');
  assert.equal(elements(SettingsDialog, tree)[0].props.locked, false);
  assert.equal(elements(EditorWorkspace, tree)[0].props.canSendDiscussion, false);
  for (const status of ['idle', 'failed', 'canceled']) {
    session.judgment = { status, code: null, interview: null };
    render(); tree = render();
    assert.equal(elements(EditorWorkspace, tree)[0].props.showResults, false);
    assert.equal(elements(EditorWorkspace, tree)[0].props.tab, 'workspace');
  }
  session.judgment = { status: 'failed', code: null, interview: assessment('interview') };
  render(); tree = render();
  assert.equal(elements(EditorWorkspace, tree)[0].props.tab, 'results');
  assert.equal(elements(EditorWorkspace, tree)[0].props.showResults, true);
  settings = { ...settings, thinking: { ...settings.thinking, apiKey: '' } };
  assert.equal(elements(ChatPanel, render())[0].props.configured, false);
  assert.equal(elements(ChatPanel, render())[0].props.retryConfigured, false);
  elements(EditorWorkspace, render())[0].props.onLanguageChange(language);
  const beforeQuit = render();
  elements(ChatPanel, beforeQuit)[0].props.onEnd();
  assert.equal(elements(CredentialsDialog, render()).length, 1);
  const gradingCount = ends.length;
  elements(ChatPanel, render())[0].props.onQuit();
  render(); tree = render();
  assert.equal(quits, 1); assert.equal(ends.length, gradingCount);
  const workspace = elements(EditorWorkspace, tree)[0];
  assert.equal(workspace.props.text, ''); assert.equal(workspace.props.language, language);
  assert.equal(workspace.props.problemText, 'Start an interview to select a problem.');
  assert.equal(workspace.props.discussion, ''); assert.equal(workspace.props.tab, 'workspace');
  assert.equal(workspace.props.showResults, false); assert.equal(elements(CredentialsDialog, tree).length, 0);
  assert.notEqual(workspace.key, elements(EditorWorkspace, beforeQuit)[0].key);
  assert.notEqual(elements(ChatPanel, tree)[0].key, elements(ChatPanel, beforeQuit)[0].key);
  assert.deepEqual(JSON.parse(storage.getItem('interview-practice.editor.document')), { version: 1, text: '', language });
  assert.equal(storage.getItem('interview-practice.editor.text'), null);
  workspace.props.onTextChange('Another draft');
  tree = render();
  storage.setItem = () => { throw new Error('Blocked'); };
  assert.doesNotThrow(() => elements(ChatPanel, tree)[0].props.onQuit());
  tree = render();
  assert.equal(elements(EditorWorkspace, tree)[0].props.text, '');
  assert.equal(elements(EditorWorkspace, tree)[0].props.language, language);
  assert.ok(elements('Text', tree).some(item => item.props.accessibilityRole === 'alert'
    && item.props.children.includes('Editor progress could not be saved')));
});

test('Chat keeps grading failures and cancellation retryable before any feedback exists', () => {
  const Chat = load('src/features/interview/components/ChatPanel/ChatPanel.tsx', {}, {
    'react-native': native, react: { useState: () => ['', () => {}], useRef: () => ({ current: null }) },
  }).default;
  let retries = 0;
  const props = { configured: true, retryConfigured: false, onRetryJudgment: () => { retries++; },
    live: { status: 'disconnected', messages: [], judgment: { submission: captured, code: null, interview: null, errors: {} } } };
  for (const status of ['failed', 'canceled']) {
    const tree = Chat({ ...props, live: { ...props.live, judgment: { ...props.live.judgment, status, errors: { code: 'Code unfinished.', interview: 'Interview unfinished.' } } } });
    assert.equal(elements('Text', tree).filter(item => item.props.accessibilityRole === 'alert').length, 2);
    const button = elements('Pressable', tree).find(item => elements('Text', item).some(label => label.props.children === 'Retry grading'));
    button.props.onPress();
    assert.equal(elements('Text', tree).some(item => typeof item.props.children === 'string' && item.props.children.includes('Review your Results')), false);
  }
  assert.equal(retries, 2);
  const tree = Chat({ ...props, live: { ...props.live, judgment: { ...props.live.judgment, status: 'failed', interview: assessment('interview') } } });
  assert.equal(elements('Pressable', tree).some(item => elements('Text', item).some(label => label.props.children === 'Retry grading')), false);
});

test('Chat displays discussion notices in order without rendering their text or changing normal messages', () => {
  const Chat = load('src/features/interview/components/ChatPanel/ChatPanel.tsx', {}, {
    'react-native': native, react: { useState: () => ['', () => {}], useRef: () => ({ current: null }) },
  }).default;
  const tree = Chat({ configured: true, retryConfigured: true, live: {
    status: 'connected', judgment: { status: 'idle' }, messages: [
      { id: 1, role: 'model', text: 'Explain the approach.' },
      { id: 2, role: 'user', kind: 'discussion', text: 'private sent discussion sentinel' },
      { id: 3, role: 'user', text: 'A normal chat answer.' },
      { id: 4, role: 'user', kind: 'discussion', text: 'another private discussion sentinel' },
    ],
  } });
  const history = elements('ScrollView', tree)[0];
  assert.deepEqual(elements('Text', history).map(item => item.props.children), [
    'Gemini', 'Explain the approach.', 'Discussion sent', 'You', 'A normal chat answer.', 'Discussion sent',
  ]);
  assert.doesNotMatch(JSON.stringify(history), /private sent discussion sentinel|another private discussion sentinel/);
});

test('native tabs hide Results until feedback is available', () => {
  const Tabs = load('src/features/editor/components/EditorTabs/EditorTabs.tsx', {}, { 'react-native': native }).default;
  const props = { value: 'workspace', onChange() {} };
  assert.equal(elements('Pressable', Tabs({ ...props, showResults: false })).length, 1);
  assert.equal(elements('Pressable', Tabs({ ...props, showResults: true })).length, 2);
});

test('Chat offers End and Quit while connected, resets on connection cancellation, and shows grading controls while judging', () => {
  const Chat = load('src/features/interview/components/ChatPanel/ChatPanel.tsx', {}, {
    'react-native': native, react: { useState: () => ['', () => {}], useRef: () => ({ current: null }) },
  }).default;
  let ends = 0, quits = 0;
  const props = { configured: true, retryConfigured: true, onEnd: () => { ends++; }, onQuit: () => { quits++; }, onStart() {}, onRetry() {}, onOpenSettings() {},
    live: { status: 'connected', messages: [], error: '', listening: false, canRetry: false, judgment: { status: 'idle' },
      send() {}, toggleMic() {}, cancelJudgment() {} } };
  let tree = Chat(props);
  const button = text => elements('Pressable', tree).find(item => elements('Text', item).some(label => label.props.children === text));
  assert.equal(button('Disconnect'), undefined);
  assert.match(button('Quit interview').props.accessibilityHint, /without evaluation/);
  button('End interview').props.onPress(); button('Quit interview').props.onPress();
  assert.equal(ends, 1); assert.equal(quits, 1);
  for (const status of ['selecting', 'connecting']) {
    tree = Chat({ ...props, live: { ...props.live, status } });
    button('Cancel connection').props.onPress();
  }
  assert.equal(quits, 3); assert.equal(ends, 1);
  tree = Chat({ ...props, live: { ...props.live, status: 'judging', judgment: { status: 'running', phase: 'interview' } } });
  assert.equal(button('End interview'), undefined); assert.equal(button('Start interview'), undefined);
  assert.equal(button('Quit interview'), undefined);
  assert.ok(button('Cancel grading'));
});
