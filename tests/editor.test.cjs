const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { memoryStorage } = require('./helpers/fixtures.cjs');

function stateHarness() {
  const states = []; let cursor = 0;
  const dependencies = [], effects = [];
  return {
    react: { useEffect(effect, deps) {
      const index = cursor++;
      if (!dependencies[index] || deps.some((value, i) => !Object.is(value, dependencies[index][i]))) {
        dependencies[index] = deps;
        effects.push(effect);
      }
    }, useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    }, useRef(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = { current: initial };
      return states[index];
    } },
    render(component, props) { cursor = 0; const result = component(props); effects.splice(0).forEach(effect => effect()); return result; },
  };
}

function elements(type, node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(item => elements(type, item));
  return [...(node.type === type ? [node] : []), ...elements(type, node.props?.children)];
}

test('workspace shows a read-only problem above discussion and code, preserving drafts across tabs and problems', () => {
  const h = stateHarness(), storage = memoryStorage();
  const CodeEditor = () => null, DiscussionInput = () => null, EditorTabs = () => null, LanguageSelector = () => null;
  const useEditorDocument = load('src/features/editor/hooks/useEditorDocument.web.ts', { window: { localStorage: storage } }, { react: h.react }).default;
  const WorkspaceView = load('src/features/editor/components/EditorWorkspace.tsx', {}, {
    react: h.react,
    'react-native': { View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Platform: { OS: 'web' }, StyleSheet: { create: value => value } },
    './CodeEditor/CodeEditor': { default: CodeEditor },
    './DiscussionInput/DiscussionInput': { default: DiscussionInput },
    './EditorTabs/EditorTabs': { default: EditorTabs },
    './LanguageSelector/LanguageSelector': { default: LanguageSelector },
    '../hooks/useEditorDocument': { default: useEditorDocument },
  }).default;
  const Workspace = props => {
    const document = useEditorDocument(true);
    const [discussion, onDiscussionChange] = h.react.useState('');
    return WorkspaceView({ ...props, text: document.text, onTextChange: document.setText,
      language: document.language, onLanguageChange: document.setLanguage, discussion, onDiscussionChange, results: 'Assessment report' });
  };
  const props = { tab: 'workspace', onTabChange: () => {}, problemText: 'Problem one', showResults: false };
  let tree = h.render(Workspace, props);
  assert.equal(elements('View', tree).some(item => item.props.nativeID === 'results-panel'), false);
  assert.deepEqual(elements('Text', tree).filter(item => item.props.accessibilityRole === 'header').map(item => item.props.children), ['Problem', 'Discussion', 'Code']);
  elements(CodeEditor, tree)[0].props.onChange('const answer = "😀";');
  elements(DiscussionInput, tree)[0].props.onChange('  My mindset\nUse a map 😀');
  tree = h.render(Workspace, props);
  elements(LanguageSelector, tree)[0].props.onChange('Python');
  tree = h.render(Workspace, { ...props, problemText: 'Problem two' });
  const editors = elements(CodeEditor, tree);
  assert.equal(editors.length, 1);
  assert.ok(elements('Text', tree).some(item => item.props.children === 'Problem two' && item.props.selectable));
  assert.equal(editors[0].props.value, 'const answer = "😀";');
  assert.equal(editors[0].props.language, 'Python');
  assert.equal(elements(DiscussionInput, tree)[0].props.value, '  My mindset\nUse a map 😀');
  const panel = () => elements('View', tree).find(item => item.props.nativeID === 'workspace-panel');
  assert.equal(panel().props.style, false);
  tree = h.render(Workspace, props);
  assert.equal(elements(CodeEditor, tree)[0].props.language, 'Python');
  assert.ok(elements('Text', tree).some(item => item.props.children === '19 characters'));
  assert.deepEqual(saved(storage), { version: 1, text: 'const answer = "😀";', language: 'Python' });
  tree = h.render(Workspace, { ...props, tab: 'results', showResults: true });
  assert.equal(panel().props.style.display, 'none');
  assert.equal(elements(CodeEditor, tree).length, 1);
  assert.equal(elements(CodeEditor, tree)[0].props.value, 'const answer = "😀";');
  assert.equal(elements(DiscussionInput, tree)[0].props.value, '  My mindset\nUse a map 😀');
  const resultsPanel = elements('View', tree).find(item => item.props.nativeID === 'results-panel');
  assert.equal(resultsPanel.props.style, false);
  assert.equal(resultsPanel.props.children, 'Assessment report');
  tree = h.render(Workspace, { ...props, tab: 'results', showResults: false });
  assert.equal(panel().props.style, false);
  assert.equal(elements(EditorTabs, tree)[0].props.value, 'workspace');
});

const DOCUMENT_KEY = 'interview-practice.editor.document';
const LEGACY_KEY = 'interview-practice.editor.text';
const saved = storage => JSON.parse(storage.getItem(DOCUMENT_KEY));

test('discussion sends through the button and input callback only when connected with nonempty notes', () => {
  const DiscussionInput = () => null;
  for (const platform of ['web', 'ios', 'android']) {
    let sends = 0;
    const Workspace = load('src/features/editor/components/EditorWorkspace.tsx', {}, {
      'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', Platform: { OS: platform }, StyleSheet: { create: value => value } },
      './CodeEditor/CodeEditor': { default: () => null },
      './DiscussionInput/DiscussionInput': { default: DiscussionInput },
      './EditorTabs/EditorTabs': { default: () => null },
      './LanguageSelector/LanguageSelector': { default: () => null },
    }).default;
    for (const [connected, discussion, enabled] of [[false, 'Notes', false], [true, '', false], [true, ' \n ', false], [true, '  Use a map.\n😀', true]]) {
      const tree = Workspace({ tab: 'workspace', text: '', discussion, canSendDiscussion: connected,
        onDiscussionSend: () => { sends++; }, onDiscussionChange() {} });
      const button = elements('Pressable', tree)[0];
      const input = elements(DiscussionInput, tree)[0];
      assert.equal(button.props.disabled, !enabled);
      assert.equal(button.props.accessibilityState.disabled, !enabled);
      assert.equal(input.props.sendDisabled, !enabled);
      assert.equal(input.props.value, discussion);
      const before = sends;
      button.props.onPress(); input.props.onSend();
      assert.equal(sends, before + (enabled ? 2 : 0));
      assert.equal(input.props.value, discussion);
      const hint = elements('Text', tree).some(item => item.props.children === 'Ctrl/Cmd+Enter to send. Enter adds a new line.');
      assert.equal(hint, platform === 'web');
    }
  }
});

test('web discussion shortcut sends once, preserves newlines, and ignores composition and other modifiers', () => {
  let sends = 0;
  const DiscussionInput = load('src/features/editor/components/DiscussionInput/DiscussionInput.web.tsx', {}, {
    react: { useRef: () => ({ current: null }), useEffect() {} },
  }).default;
  const props = { value: '  Notes\n😀', onChange() {}, onSend: () => { sends++; }, sendDisabled: false };
  const key = (field, overrides) => {
    let prevented = false;
    const before = sends;
    field.props.onKeyDown({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      repeat: false, nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault: () => { prevented = true; }, ...overrides });
    return { prevented, sends: sends - before };
  };
  const field = DiscussionInput(props);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.deepEqual(key(field, { [modifier]: true }), { prevented: true, sends: 1 });
    for (const extra of [{ shiftKey: true }, { altKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
      assert.deepEqual(key(field, { [modifier]: true, ...extra }), { prevented: false, sends: 0 });
    }
    assert.deepEqual(key(field, { [modifier]: true, repeat: true }), { prevented: true, sends: 0 });
    for (const unavailable of [{ sendDisabled: true }, { value: '' }, { value: ' \n ' }]) {
      assert.deepEqual(key(DiscussionInput({ ...props, ...unavailable }), { [modifier]: true }), { prevented: true, sends: 0 });
    }
  }
  for (const other of [{}, { shiftKey: true }, { key: 'a', ctrlKey: true }, { key: 'Escape', metaKey: true }]) {
    assert.deepEqual(key(field, other), { prevented: false, sends: 0 });
  }
  assert.equal(field.props.value, props.value);
});

test('web discussion disables drag resizing, caps long content with scrolling, and shrinks after deletion without losing scroll or hidden-panel size', () => {
  const effects = []; let resized, disconnected = false, edited;
  let contentHeight = 300;
  const input = { clientWidth: 600, scrollTop: 0, value: '  Mindset\n😀', style: {},
    get offsetHeight() { return Math.min(520, Math.max(120, Number.parseFloat(this.style.height) || 120)); },
    get scrollHeight() { return Math.max(contentHeight, this.offsetHeight - 2); } };
  const DiscussionInput = load('src/features/editor/components/DiscussionInput/DiscussionInput.web.tsx', {
    ResizeObserver: class {
      constructor(callback) { resized = callback; }
      observe(element) { assert.equal(element, input); }
      disconnect() { disconnected = true; }
    },
  }, { react: { useRef: () => ({ current: input }), useEffect: effect => effects.push(effect) } }).default;
  const field = DiscussionInput({ value: input.value, onChange: value => { edited = value; } });
  const cleanups = effects.map(effect => effect());
  assert.equal(input.style.height, '302px');
  assert.equal(field.props.style.resize, 'none');
  assert.equal(field.props.style.maxHeight, '65vh');
  assert.equal(field.props.style.overflow, 'auto');
  field.props.onChange({ currentTarget: input });
  assert.equal(edited, '  Mindset\n😀');
  contentHeight = 1000; input.scrollTop = 300;
  field.props.onChange({ currentTarget: input });
  assert.equal(input.offsetHeight, 520);
  assert.ok(input.scrollHeight > input.offsetHeight);
  assert.equal(input.scrollTop, 300);
  contentHeight = 200;
  field.props.onChange({ currentTarget: input });
  assert.equal(input.style.height, '202px');
  contentHeight = 0;
  field.props.onChange({ currentTarget: input });
  assert.equal(input.style.height, '120px');
  input.style.height = '400px';
  input.clientWidth = 0;
  resized();
  field.props.onChange({ currentTarget: input });
  assert.equal(input.style.height, '400px');
  input.clientWidth = 400; contentHeight = 640;
  resized();
  assert.equal(input.style.height, '642px');
  assert.equal(input.offsetHeight, 520);
  cleanups.forEach(cleanup => cleanup?.());
  assert.equal(disconnected, true);
});

test('native discussion caps content to the viewport, scrolls when needed, and shrinks after deletion', () => {
  const h = stateHarness(); let edited;
  let windowHeight = 800;
  const DiscussionInput = load('src/features/editor/components/DiscussionInput/DiscussionInput.tsx', {}, {
    react: h.react, 'react-native': { TextInput: 'TextInput', StyleSheet: { create: value => value }, useWindowDimensions: () => ({ height: windowHeight }) },
  }).default;
  const props = { value: '  Native mindset\n😀', onChange: value => { edited = value; } };
  let field = h.render(DiscussionInput, props);
  field.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 420 } } });
  field = h.render(DiscussionInput, props);
  assert.equal(field.props.style[1].height, 422);
  assert.equal(field.props.scrollEnabled, false);
  assert.equal(field.props.value, props.value);
  field.props.onChangeText('More notes\n😀');
  assert.equal(edited, 'More notes\n😀');
  field.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 1000 } } });
  field = h.render(DiscussionInput, props);
  assert.equal(field.props.style[1].height, 520);
  assert.equal(field.props.scrollEnabled, true);
  windowHeight = 400;
  field = h.render(DiscussionInput, props);
  assert.equal(field.props.style[1].height, 260);
  field.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 40 } } });
  field = h.render(DiscussionInput, props);
  assert.equal(field.props.style[1].height, 120);
  assert.equal(field.props.scrollEnabled, false);
});

function webHarness(storage, globals = { window: { localStorage: storage } }) {
  const h = stateHarness();
  const hook = load('src/features/editor/hooks/useEditorDocument.web.ts', globals, { react: h.react }).default;
  return { render: persist => h.render(hook, persist) };
}

test('fresh sessions default to empty C++ and supported languages survive reload with exact code', () => {
  const languages = load('src/features/editor/model/types.ts').editorLanguages;
  for (const language of languages) {
    const storage = memoryStorage(), h = webHarness(storage);
    const initial = h.render(true);
    assert.equal(initial.language, 'C++');
    assert.equal(initial.text, '');
    initial.setText('  exact code\n😀\n');
    initial.setLanguage(language);
    const restored = webHarness(storage).render(true);
    assert.equal(restored.language, language);
    assert.equal(restored.text, '  exact code\n😀\n');
    assert.equal(restored.storageStatus, 'saved');
    restored.setText('');
    assert.equal(webHarness(storage).render(true).text, '');
    assert.equal(webHarness(storage).render(true).language, language);
  }
});

test('legacy drafts are ignored and remain untouched when saving or clearing current documents', () => {
  for (const text of ['', '  legacy\r\n😀\n']) {
    const storage = memoryStorage();
    storage.setItem(LEGACY_KEY, text);
    const original = { ...storage };
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      storage[method] = (key, ...args) => {
        assert.equal(key, DOCUMENT_KEY, 'Only current documents may be accessed');
        return original[method](key, ...args);
      };
    }
    const h = webHarness(storage);
    assert.equal(h.render(true).text, '');
    assert.deepEqual(saved(storage), { version: 1, text: '', language: 'C++' });
    h.render(true).setText('Current code');
    h.render(true).setLanguage('Python');
    assert.deepEqual(saved(storage), { version: 1, text: 'Current code', language: 'Python' });
    h.render(false);
    assert.equal(original.getItem(DOCUMENT_KEY), null);
    assert.equal(original.getItem(LEGACY_KEY), text);
  }
});

test('valid documents with missing or unsupported languages preserve their text with C++', () => {
  for (const language of [undefined, null, 'Plain text', 'Rust', 1, {}, 'python', 'Python']) {
    const storage = memoryStorage();
    storage.setItem(LEGACY_KEY, 'older draft');
    storage.setItem(DOCUMENT_KEY, JSON.stringify({ version: 1, text: 'current\n', language }));
    const document = webHarness(storage).render(true);
    assert.equal(document.text, 'current\n');
    assert.equal(document.language, language === 'Python' ? language : 'C++');
    assert.equal(storage.getItem(LEGACY_KEY), 'older draft');
    assert.equal(saved(storage).text, 'current\n');
  }
});

test('malformed and unsupported documents restore an empty C++ document even with legacy drafts', () => {
  for (const malformed of ['{', 'null', '[]', '"text"', '{}', '{"version":2,"text":"future"}',
    '{"version":"1","text":"wrong version"}', '{"version":1,"text":null}', '{"version":1,"text":42}']) {
    for (const legacy of [null, '', 'older\n😀']) {
      const storage = memoryStorage();
      storage.setItem(DOCUMENT_KEY, malformed);
      if (legacy !== null) storage.setItem(LEGACY_KEY, legacy);
      const document = webHarness(storage).render(true);
      assert.equal(document.text, '');
      assert.equal(storage.getItem(LEGACY_KEY), legacy);
      assert.equal(document.language, 'C++');
      assert.equal(document.storageStatus, 'saved');
      assert.deepEqual(saved(storage), { version: 1, text: '', language: 'C++' });
    }
  }
});

test('successive setters save both fields immediately without a rerender', () => {
  const storage = memoryStorage(), h = webHarness(storage);
  const document = h.render(true);
  document.setLanguage('Python');
  document.setText('first\n');
  assert.deepEqual(saved(storage), { version: 1, text: 'first\n', language: 'Python' });
  document.setText('second');
  document.setLanguage('Java');
  assert.deepEqual(saved(storage), { version: 1, text: 'second', language: 'Java' });
  assert.equal(h.render(true).text, 'second');
  assert.equal(h.render(true).language, 'Java');
});

test('recovery toggles preserve memory, clear the document, and save the current code and language on enable', () => {
  const storage = memoryStorage();
  storage.setItem(DOCUMENT_KEY, JSON.stringify({ version: 1, text: 'old code', language: 'Python' }));
  storage.setItem(LEGACY_KEY, 'older code');
  const h = webHarness(storage);
  const initial = h.render(false);
  assert.equal(initial.text, '');
  assert.equal(initial.language, 'C++');
  assert.equal(storage.getItem(DOCUMENT_KEY), null);
  assert.equal(storage.getItem(LEGACY_KEY), 'older code');
  initial.setText('current draft'); initial.setLanguage('TypeScript');
  assert.equal(storage.getItem(DOCUMENT_KEY), null);
  h.render(true);
  assert.deepEqual(saved(storage), { version: 1, text: 'current draft', language: 'TypeScript' });
  storage.setItem(LEGACY_KEY, 'stale draft');
  h.render(false);
  assert.equal(h.render(false).text, 'current draft');
  assert.equal(h.render(false).language, 'TypeScript');
  assert.equal(h.render(false).storageStatus, 'session');
  assert.equal(storage.getItem(DOCUMENT_KEY), null);
  assert.equal(storage.getItem(LEGACY_KEY), 'stale draft');
  assert.equal(webHarness(storage).render(false).language, 'C++');
  assert.equal(webHarness(storage).render(false).text, '');
  h.render(false).setText('unsaved change'); h.render(false).setLanguage('Java');
  h.render(true);
  assert.deepEqual(saved(storage), { version: 1, text: 'unsaved change', language: 'Java' });
});

test('failed saves keep editing usable, retry on either setter, and never retry on unrelated renders', () => {
  const storage = memoryStorage(), h = webHarness(storage);
  const write = storage.setItem;
  let blocked = true, writes = 0;
  storage.setItem = (key, text) => {
    writes++;
    if (blocked) throw new Error('Full');
    write(key, text);
  };
  h.render(true);
  assert.equal(h.render(true).storageStatus, 'unavailable');
  assert.equal(writes, 1);
  const document = h.render(true);
  document.setText('session draft'); document.setLanguage('Python');
  assert.equal(h.render(true).text, 'session draft');
  assert.equal(h.render(true).language, 'Python');
  assert.equal(h.render(true).storageStatus, 'unavailable');
  assert.equal(writes, 3);
  blocked = false;
  h.render(true);
  assert.equal(writes, 3);
  h.render(true).setLanguage('Java');
  assert.deepEqual(saved(storage), { version: 1, text: 'session draft', language: 'Java' });
  assert.equal(h.render(true).storageStatus, 'saved');
  h.render(true);
  assert.equal(writes, 4);
});

test('storage access and removal failures keep defaults and editing usable', () => {
  const cleared = [];
  const storage = {
    getItem: () => { throw new Error('Blocked'); },
    setItem: () => { throw new Error('Blocked'); },
    removeItem: key => { cleared.push(key); throw new Error('Blocked'); },
  };
  const h = webHarness(storage);
  h.render(true);
  assert.equal(h.render(true).storageStatus, 'unavailable');
  h.render(false);
  assert.deepEqual(cleared, [DOCUMENT_KEY]);
  const document = h.render(false);
  document.setText('still editable'); document.setLanguage('Python');
  assert.equal(h.render(false).text, 'still editable');
  assert.equal(h.render(false).language, 'Python');
  assert.equal(h.render(false).storageStatus, 'unavailable');
  h.render(false);
  assert.equal(cleared.length, 1);
  const blockedWindow = {};
  Object.defineProperty(blockedWindow, 'localStorage', { get() { throw new Error('Blocked'); } });
  const blocked = webHarness(null, { window: blockedWindow });
  assert.equal(blocked.render(true).text, '');
  assert.equal(blocked.render(true).language, 'C++');
  assert.equal(blocked.render(true).storageStatus, 'unavailable');
});

test('disabled recovery never reads saved content and repeated renders never duplicate storage operations', () => {
  const storage = memoryStorage(), cleared = [], writes = [];
  storage.getItem = () => assert.fail('Disabled recovery must not read storage');
  storage.removeItem = key => cleared.push(key);
  storage.setItem = (key, value) => writes.push([key, JSON.parse(value)]);
  const h = webHarness(storage);
  h.render(false).setText('draft'); h.render(false).setLanguage('Python');
  h.render(false); h.render(false);
  assert.deepEqual(cleared, [DOCUMENT_KEY]);
  assert.equal(writes.length, 0);
  h.render(true); h.render(true); h.render(true);
  assert.deepEqual(writes, [[DOCUMENT_KEY, { version: 1, text: 'draft', language: 'Python' }]]);
  h.render(false); h.render(false);
  assert.deepEqual(cleared, [DOCUMENT_KEY, DOCUMENT_KEY]);
  assert.equal(h.render(false).text, 'draft');
});

test('native and browserless editing default to C++ and remain session-only', () => {
  for (const file of ['useEditorDocument.ts', 'useEditorDocument.web.ts']) {
    const h = stateHarness();
    const hook = load(`src/features/editor/hooks/${file}`, {}, { react: h.react }).default;
    const document = h.render(hook, true);
    assert.equal(document.language, 'C++');
    assert.equal(document.text, '');
    document.setText('session code'); document.setLanguage('Python');
    assert.equal(h.render(hook, true).text, 'session code');
    assert.equal(h.render(hook, true).language, 'Python');
    assert.equal(h.render(hook, false).language, 'Python');
    assert.equal(h.render(hook, false).storageStatus, 'session');
  }
});
