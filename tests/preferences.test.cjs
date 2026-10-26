const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, memoryStorage } = require('./helpers/fixtures.cjs');

const { defaultApiConfig } = load('src/shared/apiConfig.ts');
const { SETTINGS_STORAGE_KEY, readPreferences, writePreferences } = load('src/features/settings/storage/preferencesStorage.ts');
const { CREDENTIALS_STORAGE_KEY, restoreCredentials } = load('src/features/settings/storage/credentialsStorage.ts');

test('recovery preferences migrate safely and keys are retained only within the current tab when enabled', () => {
  const local = memoryStorage(), tab = memoryStorage();
  const browser = { localStorage: local, sessionStorage: tab };
  const edited = { ...config, saveInterviewState: true, rememberApiKeys: true };
  const h = preferencesHarness(local, defaultApiConfig(), false, browser);
  h.render().saveConfig(edited);
  assert.equal(h.render().credentialStorageStatus, 'saved');
  assert.deepEqual(JSON.parse(tab.getItem(CREDENTIALS_STORAGE_KEY)), { live: config.live.credential, thinking: config.thinking.apiKey });
  assert.doesNotMatch(local.getItem(SETTINGS_STORAGE_KEY), /live-key|thinking-key|credential/);
  const reloaded = preferencesHarness(local, defaultApiConfig(), false, browser).render();
  assert.equal(reloaded.config.live.credential, config.live.credential);
  assert.equal(reloaded.config.thinking.apiKey, config.thinking.apiKey);
  assert.equal(reloaded.config.saveInterviewState, true);
  const newTab = preferencesHarness(local, defaultApiConfig(), false, { localStorage: local, sessionStorage: memoryStorage() }).render();
  assert.equal(newTab.config.live.credential, '');
  assert.equal(newTab.config.thinking.apiKey, '');
  h.render().saveConfig({ ...edited, rememberApiKeys: false });
  assert.equal(tab.getItem(CREDENTIALS_STORAGE_KEY), null);
  assert.equal(h.render().config.live.credential, config.live.credential);
  for (const value of [undefined, null, 'true', 1]) {
    local.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ saveInterviewState: value, rememberApiKeys: value }));
    const restored = preferencesHarness(local, defaultApiConfig(), false, browser).render();
    assert.equal(restored.config.saveInterviewState, false);
    assert.equal(restored.config.rememberApiKeys, false);
  }
});

test('blocked key storage keeps credentials in memory and malformed key records restore safely', () => {
  const local = memoryStorage();
  const browser = { localStorage: local, get sessionStorage() { throw new Error('Blocked'); } };
  const h = preferencesHarness(local, defaultApiConfig(), false, browser);
  h.render().saveConfig({ ...config, rememberApiKeys: true });
  assert.equal(h.render().config.live.credential, config.live.credential);
  assert.equal(h.render().credentialStorageStatus, 'unavailable');
  const tab = memoryStorage();
  for (const raw of ['{broken', 'null', '[]', '42']) {
    tab.setItem(CREDENTIALS_STORAGE_KEY, raw);
    assert.deepEqual(plain(restoreCredentials(tab, { ...config, rememberApiKeys: true })), { ...config, rememberApiKeys: true });
  }
  tab.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify({ live: ' remembered-live ', thinking: 42 }));
  const restored = restoreCredentials(tab, { ...config, rememberApiKeys: true });
  assert.equal(restored.live.credential, 'remembered-live');
  assert.equal(restored.thinking.apiKey, config.thinking.apiKey);
  assert.deepEqual(plain(restoreCredentials({ getItem: () => assert.fail('Do not read unrequested keys') }, config)), config);
});

test('preferences round-trip only whitelisted fields and ignore stored credentials', () => {
  const storage = memoryStorage();
  const edited = {
    ...config, problemSource: 'stored', credential: 'future-secret',
    live: { ...config.live, token: 'another-secret' },
    thinking: { ...config.thinking, model: 'antigravity-preview-09-2026' },
  };
  writePreferences(storage, edited);
  const raw = storage.getItem(SETTINGS_STORAGE_KEY);
  assert.deepEqual(JSON.parse(raw), {
    problemSource: 'stored', problemSearchDescription: '', saveSearchedProblems: false, saveInterviewState: false, rememberApiKeys: false, live: { model: 'gemini-3.8-live' },
    thinking: { provider: 'google', model: 'antigravity-preview-09-2026' },
  });
  assert.doesNotMatch(raw, /live-key|thinking-key|secret|credential|apiKey|token/);
  const defaults = defaultApiConfig();
  const restored = readPreferences(storage, defaults);
  assert.equal(restored.live.model, 'gemini-3.8-live');
  assert.equal(restored.problemSource, 'stored');
  assert.equal('requestsPerMinute' in restored.thinking, false);
  assert.equal(restored.live.credential, '');
  assert.equal(restored.thinking.apiKey, '');
  assert.equal(defaults.live.model, 'gemini-3.8-live-extended-thinking');
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(edited));
  const sanitized = readPreferences(storage, defaults);
  assert.equal(sanitized.live.credential, '');
  assert.equal(sanitized.thinking.apiKey, '');
  assert.equal(sanitized.credential, undefined);
  assert.equal(sanitized.live.token, undefined);
});

test('missing, malformed, and invalid preferences fall back per field without losing valid values', () => {
  const storage = memoryStorage(), defaults = defaultApiConfig();
  assert.deepEqual(plain(readPreferences(storage, defaults)), plain(defaults));
  for (const raw of ['{broken', 'null', '[]', '"text"', '42', '{"live":null,"thinking":[]}']) {
    storage.setItem(SETTINGS_STORAGE_KEY, raw);
    assert.deepEqual(plain(readPreferences(storage, defaults)), plain(defaults));
  }
  for (const rpm of [-1, 2.5, '10', null, 1e308]) {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      problemSource: 'unknown', live: { model: 'custom' },
      thinking: { provider: 'custom', model: 'gemini-3.8-flash', requestsPerMinute: rpm },
    }));
    const restored = readPreferences(storage, defaults);
    assert.equal(restored.problemSource, 'agent');
    assert.equal(restored.live.model, defaults.live.model);
    assert.equal(restored.thinking.provider, 'google');
    assert.equal(restored.thinking.model, 'gemini-3.8-flash');
    assert.equal('requestsPerMinute' in restored.thinking, false);
  }
  for (const model of ['removed-model', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']) {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ thinking: { model } }));
    const restored = readPreferences(storage, defaults);
    assert.equal(restored.thinking.model, defaults.thinking.model);
    assert.equal('requestsPerMinute' in restored.thinking, false);
  }
});

test('problem descriptions persist and clear safely while older or invalid preferences default to empty', () => {
  const storage = memoryStorage();
  const description = 'Medium graphs\n最短路徑 {{literal}} $&';
  const h = preferencesHarness(storage);
  h.render().saveConfig({ ...config, problemSearchDescription: description });
  assert.equal(preferencesHarness(storage).render().config.problemSearchDescription, description);
  assert.doesNotMatch(storage.getItem(SETTINGS_STORAGE_KEY), /live-key|thinking-key|credential|apiKey/);
  writePreferences(storage, { ...config, problemSearchDescription: ' \n\t ' });
  assert.equal(readPreferences(storage, defaultApiConfig()).problemSearchDescription, '');
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ problemSearchDescription: `  ${description}\n ` }));
  assert.equal(readPreferences(storage, defaultApiConfig()).problemSearchDescription, description);
  for (const value of [undefined, null, 42, false, [], {}]) {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ problemSearchDescription: value, saveSearchedProblems: true }));
    const restored = readPreferences(storage, defaultApiConfig());
    assert.equal(restored.problemSearchDescription, '');
    assert.equal(restored.saveSearchedProblems, true);
  }
  const native = preferencesHarness(null, defaultApiConfig(), true);
  native.render().saveConfig({ ...config, problemSearchDescription: description });
  assert.equal(native.render().config.problemSearchDescription, description);
  assert.equal(preferencesHarness(null, defaultApiConfig(), true).render().config.problemSearchDescription, '');
});

test('legacy interval and RPM preferences are ignored and omitted from future writes', () => {
  const storage = memoryStorage(), defaults = defaultApiConfig();
  for (const rpm of [0, 12, -1, 'invalid']) {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ thinking: { requestsPerMinute: rpm, requestIntervalSeconds: 15 } }));
    const restored = readPreferences(storage, defaults);
    assert.equal('requestsPerMinute' in restored.thinking, false);
    assert.equal('requestIntervalSeconds' in restored.thinking, false);
    writePreferences(storage, restored);
    assert.doesNotMatch(storage.getItem(SETTINGS_STORAGE_KEY), /requestsPerMinute|requestIntervalSeconds/);
  }
});

test('thinking effort persists without credentials and older or unsupported values restore safely', () => {
  const storage = memoryStorage();
  const extended = { ...config, live: { ...config.live, model: 'gemini-3.8-live-extended-thinking', thinkingEffort: 'high' } };
  writePreferences(storage, extended);
  assert.doesNotMatch(storage.getItem(SETTINGS_STORAGE_KEY), /credential|apiKey|live-key|thinking-key/);
  assert.deepEqual(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).live, { model: extended.live.model, thinkingEffort: 'high' });
  assert.equal(readPreferences(storage, defaultApiConfig()).live.thinkingEffort, 'high');
  for (const effort of [undefined, 'minimal', 'bad', null, 2]) {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ live: { model: extended.live.model, thinkingEffort: effort } }));
    assert.equal(readPreferences(storage, defaultApiConfig()).live.thinkingEffort, 'medium');
  }
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ live: { model: 'gemini-3.8-live', thinkingEffort: 'high' } }));
  assert.equal('thinkingEffort' in readPreferences(storage, defaultApiConfig()).live, false);
  writePreferences(storage, { ...extended, live: { ...extended.live, model: 'gemini-3.8-live' } });
  assert.equal('thinkingEffort' in JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).live, false);
});

function preferencesHarness(storage, initial = defaultApiConfig(), native = false, browser = { localStorage: storage }) {
  let state, initialized = false, initializations = 0;
  const react = {
    useState(value) {
      if (!initialized) { state = typeof value === 'function' ? value() : value; initialized = true; }
      return [state, next => { state = typeof next === 'function' ? next(state) : next; }];
    },
  };
  const hook = load(`src/features/settings/hooks/useSettingsPreferences${native ? '' : '.web'}.ts`, { window: browser }, {
    react,
    '../../../shared/apiConfig': { ...load('src/shared/apiConfig.ts'), defaultApiConfig: () => { initializations++; return plain(initial); } },
  }).default;
  return { render: storedProblemCount => hook(storedProblemCount), get initializations() { return initializations; } };
}

test('source defaults use the initial bank count while valid saved choices take precedence', () => {
  for (const count of [0, 2]) {
    const expected = count ? 'stored' : 'agent';
    for (const raw of [null, '{broken', '{}', '{"problemSource":"unknown"}']) {
      const storage = memoryStorage();
      if (raw !== null) storage.setItem(SETTINGS_STORAGE_KEY, raw);
      const h = preferencesHarness(storage);
      assert.equal(h.render(count).config.problemSource, expected);
      assert.equal(h.render(count ? 0 : 2).config.problemSource, expected);
      assert.equal(h.initializations, 1);
      assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), raw);
    }
    for (const problemSource of ['stored', 'agent']) {
      const storage = memoryStorage();
      writePreferences(storage, { ...config, problemSource });
      assert.equal(preferencesHarness(storage).render(count).config.problemSource, problemSource);
    }
    const blocked = { get localStorage() { throw new Error('Blocked'); } };
    assert.equal(preferencesHarness(null, defaultApiConfig(), false, blocked).render(count).config.problemSource, expected);
    assert.equal(preferencesHarness(null, defaultApiConfig(), true).render(count).config.problemSource, expected);
  }
});

test('searched-problem saving is opt-in, restores valid booleans, and falls back for older preferences', () => {
  const storage = memoryStorage();
  assert.equal(preferencesHarness(storage).render().config.saveSearchedProblems, false);
  for (const saveSearchedProblems of [true, false]) {
    const h = preferencesHarness(storage);
    h.render().saveConfig({ ...config, saveSearchedProblems });
    assert.equal(preferencesHarness(storage).render().config.saveSearchedProblems, saveSearchedProblems);
    assert.doesNotMatch(storage.getItem(SETTINGS_STORAGE_KEY), /live-key|thinking-key|credential|apiKey/);
  }
  for (const value of [undefined, null, 'true', 1]) {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ saveSearchedProblems: value, problemSource: 'agent' }));
    assert.equal(preferencesHarness(storage).render(2).config.saveSearchedProblems, false);
  }
});

test('browser settings restore once, save partial configuration, and lose session credentials on reload', () => {
  const storage = memoryStorage(), h = preferencesHarness(storage);
  assert.equal(h.render().config.live.model, 'gemini-3.8-live-extended-thinking');
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
  const edited = { ...config, problemSource: 'stored', thinking: { ...config.thinking, apiKey: '' } };
  h.render().saveConfig(edited);
  assert.deepEqual(plain(h.render().config), edited);
  assert.equal(h.render().storageStatus, 'saved');
  assert.equal(h.initializations, 1);
  const reloaded = preferencesHarness(storage).render();
  assert.equal(reloaded.config.live.model, 'gemini-3.8-live');
  assert.equal(reloaded.config.problemSource, 'stored');
  assert.equal('requestsPerMinute' in reloaded.config.thinking, false);
  assert.equal(reloaded.config.live.credential, '');
  assert.equal(reloaded.config.thinking.apiKey, '');
});

test('browser reload restores the selected effort while keeping Live credentials session-only', () => {
  const storage = memoryStorage(), h = preferencesHarness(storage);
  const edited = { ...config, live: { ...config.live, model: 'gemini-3.8-live-extended-thinking', thinkingEffort: 'low' } };
  h.render().saveConfig(edited);
  const reloaded = preferencesHarness(storage).render();
  assert.equal(reloaded.config.live.thinkingEffort, 'low');
  assert.equal(reloaded.config.live.credential, '');
  assert.equal(reloaded.storageStatus, 'saved');
});

test('blocked and full browser storage keep settings usable and recover on a later save', () => {
  let blocked = true;
  const storage = memoryStorage();
  const browser = { get localStorage() { if (blocked) throw new Error('Blocked'); return storage; } };
  const h = preferencesHarness(storage, defaultApiConfig(), false, browser);
  assert.equal(h.render().storageStatus, 'unavailable');
  h.render().saveConfig(config);
  assert.equal(h.render().config.live.credential, 'live-key');
  assert.equal(h.render().storageStatus, 'unavailable');
  blocked = false;
  h.render().saveConfig(config);
  assert.equal(h.render().storageStatus, 'saved');
  const full = preferencesHarness({ getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } });
  full.render().saveConfig(config);
  assert.deepEqual(plain(full.render().config), config);
  assert.equal(full.render().storageStatus, 'unavailable');
});

test('native and server rendering remain session-only without accessing browser storage', () => {
  const browser = { get localStorage() { assert.fail('Native must not access browser storage'); } };
  const native = preferencesHarness(null, defaultApiConfig(), true, browser);
  const react = { useState: initial => [initial(), () => {}] };
  const serverHook = load('src/features/settings/hooks/useSettingsPreferences.web.ts', {}, {
    react,
  }).default;
  assert.equal(serverHook().storageStatus, 'session');
  serverHook().saveConfig(config);
  assert.equal(native.render().storageStatus, 'session');
  native.render().saveConfig(config);
  assert.deepEqual(plain(native.render().config), config);
  assert.equal(native.render().storageStatus, 'session');
});

function appHarness(storage, initial = defaultApiConfig()) {
  let cursor = 0;
  const states = [], connects = [];
  const react = {
    useEffect() {},
    useState(value) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof value === 'function' ? value() : value;
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
  };
  const useSettingsPreferences = load('src/features/settings/hooks/useSettingsPreferences.web.ts', { window: { localStorage: storage } }, {
    react, '../../../shared/apiConfig': { ...load('src/shared/apiConfig.ts'), defaultApiConfig: () => plain(initial) },
  }).default;
  const ChatPanel = () => null, SettingsDialog = () => null;
  const native = Object.fromEntries(['Pressable', 'ScrollView', 'Text', 'View'].map(name => [name, name]));
  native.StyleSheet = { create: value => value };
  native.useWindowDimensions = () => ({ width: 320 });
  const App = load('src/App.tsx', {}, {
    react, 'react-native': native, 'expo-status-bar': { StatusBar: () => null },
    './features/editor': { EditorWorkspace: () => null, useEditorDocument: () => ({ text: '', language: 'C++', setText() {}, setLanguage() {}, storageStatus: 'session' }) },
    './features/interview': { ChatPanel, formatProblem: () => '', useInterviewSession: () => ({
      judgment: { status: 'idle' }, status: 'disconnected', problem: null, storedProblemCount: 1,
      connect: value => connects.push(plain(value)), retry() {},
    }) },
    './features/settings': { SettingsDialog, useSettingsPreferences },
  }).default;
  function find(type, node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(child => find(type, child));
    return [...(node.type === type ? [node] : []), ...find(type, node.props?.children)];
  }
  function render() { cursor = 0; return App(); }
  function openSettings() {
    find('Pressable', render())[0].props.onPress();
    return find(SettingsDialog, render())[0].props;
  }
  return { render, find, openSettings, connects, ChatPanel };
}

test('App omits the page title, persists only Save, restores without connecting, and reports storage failure', () => {
  const storage = memoryStorage(), h = appHarness(storage, config);
  assert.equal(h.find('Text', h.render()).some(item => item.props.children === 'AlgoRehearsal'), false);
  assert.equal(h.connects.length, 0);
  assert.equal(h.openSettings().config.problemSource, 'stored');
  assert.equal(h.find(h.ChatPanel, h.render())[0].props.useStoredQuestions, true);
  h.openSettings().onClose();
  assert.equal(storage.getItem(SETTINGS_STORAGE_KEY), null);
  const edited = { ...config, problemSource: 'stored', thinking: { ...config.thinking } };
  h.openSettings().onSave(edited);
  assert.equal(h.connects.length, 0);
  assert.equal(h.openSettings().preferenceStorageStatus, 'saved');
  h.find(h.ChatPanel, h.render())[0].props.onStart();
  assert.deepEqual(h.connects, [edited]);
  const reloaded = appHarness(storage), restored = reloaded.openSettings();
  assert.equal(restored.config.problemSource, 'stored');
  assert.equal('requestsPerMinute' in restored.config.thinking, false);
  assert.equal(restored.config.live.credential, '');
  assert.equal(reloaded.connects.length, 0);
  assert.equal(reloaded.find(reloaded.ChatPanel, reloaded.render())[0].props.configured, false);
  const unavailable = appHarness({ getItem: () => null, setItem: () => { throw new Error('Full'); } });
  unavailable.openSettings().onSave(edited);
  assert.ok(unavailable.find('Text', unavailable.render()).some(item => item.props.accessibilityRole === 'alert'));
});
