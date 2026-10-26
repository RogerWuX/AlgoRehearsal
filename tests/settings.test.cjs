const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, memoryStorage } = require('./helpers/fixtures.cjs');

function settingsHarness(initialConfig = config, locked = false, platform = 'web', storedProblemCount = 0, questionImportWarning = '', preferenceStorageStatus = 'session', apiConfigOverride, logTools, { width = 1024, height = 800, credentialStorageStatus = 'session' } = {}) {
  let cursor = 0, tree;
  const states = [];
  const effects = [];
  const saved = [], closed = [], accessibilityFocus = [];
  const react = {
    useState: initial => { const index = cursor++; if (states[index] === undefined) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: current => { const index = cursor++; if (states[index] === undefined) states[index] = { current }; return states[index]; }, useEffect: effect => { effects.push(effect); },
  };
  const native = Object.fromEntries(['Modal', 'Pressable', 'ScrollView', 'Switch', 'Text', 'TextInput', 'View'].map(name => [name, name]));
  const viewport = { width, height };
  native.useWindowDimensions = () => viewport;
  native.findNodeHandle = element => element.handle;
  native.AccessibilityInfo = { setAccessibilityFocus: handle => accessibilityFocus.push(handle) };
  native.StyleSheet = { create: value => value };
  const dependencies = { react, 'react-native': native };
  if (logTools) dependencies['../../../../shared/logStorage'] = logTools;
  if (apiConfigOverride) {
    dependencies['../../../../shared/apiConfig'] = apiConfigOverride;
    dependencies['../../../shared/apiConfig'] = apiConfigOverride;
  }
  const Settings = load(platform === 'web' ? 'src/features/settings/components/SettingsDialog/SettingsDialog.web.tsx' : 'src/features/settings/components/SettingsDialog/SettingsDialog.tsx', {}, dependencies).default;
  function render() {
    cursor = 0;
    tree = Settings({ config: initialConfig, locked, storedProblemCount, questionImportWarning, preferenceStorageStatus, credentialStorageStatus, onSave: next => saved.push(next), onClose: () => closed.push(true) });
    return tree;
  }
  function elements(type, node) {
    if (arguments.length < 2) node = tree;
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(item => elements(type, item));
    return [...(node.type === type || (typeof node.type === 'function' && node.type.name === type) ? [node] : []), ...elements(type, node.props?.children)];
  }
  function openCategory(label) {
    const button = elements(platform === 'web' ? 'button' : 'Pressable').find(item =>
      (item.props['aria-label'] ?? item.props.accessibilityLabel ?? item.props.children) === label);
    assert.ok(button, `Category ${label} is available`);
    if (platform === 'web') button.props.onClick();
    else button.props.onPress();
    render();
  }
  function resize(nextWidth, nextHeight) {
    viewport.width = nextWidth;
    viewport.height = nextHeight;
    render();
  }
  function setWarnings(importWarning, credentialStatus) {
    questionImportWarning = importWarning;
    credentialStorageStatus = credentialStatus;
    render();
  }
  render();
  return { render, elements, openCategory, resize, setWarnings, saved, closed, accessibilityFocus,
    subscribeLogs: () => effects[0](), focusCategory: () => effects.at(-1)() };
}

function categoryHarness(category, ...args) {
  const h = settingsHarness(...args);
  h.openCategory(category);
  return h;
}

test('settings opens with Interview selected and navigation immediately available on both platforms', () => {
  for (const platform of ['web', 'native']) {
    const h = settingsHarness(config, false, platform);
    const buttons = () => h.elements(platform === 'web' ? 'button' : 'Pressable');
    const tabs = () => buttons().filter(item => (item.props.role ?? item.props.accessibilityRole) === 'tab');
    const selected = () => tabs().find(item => item.props['aria-selected'] ?? item.props.accessibilityState?.selected);
    const label = item => item.props.accessibilityLabel ?? item.props.children;
    assert.deepEqual(tabs().map(label), platform === 'web' ? ['Interview', 'Model', 'Diagnostics'] : ['Interview', 'Model']);
    assert.equal(label(selected()), 'Interview');
    assert.ok(buttons().every(item => (item.props.accessibilityLabel ?? item.props.children) !== 'All categories'));
    assert.equal(h.elements(platform === 'web' ? 'input' : 'Switch').filter(item => item.props.type === 'checkbox' || item.type === 'Switch').length, 2);
    assert.equal(h.elements(platform === 'web' ? 'textarea' : 'TextInput').length, 1);
    assert.equal(h.elements('select').length, 0);
    h.openCategory('Model');
    assert.equal(label(selected()), 'Model');
    assert.equal(h.elements(platform === 'web' ? 'input' : 'TextInput').filter(item => item.props.type === 'password' || item.type === 'TextInput').length, 2);
    assert.equal(h.elements(platform === 'web' ? 'input' : 'Switch').filter(item => item.props.type === 'checkbox' || item.type === 'Switch').length, 1);
    assert.equal(tabs().filter(item => item.props['aria-selected'] ?? item.props.accessibilityState?.selected).length, 1);
    h.openCategory('Interview');
    assert.equal(label(selected()), 'Interview');
    h.openCategory('Model');
    h.openCategory('Cancel');
    assert.equal(h.closed.length, 1);
    const reopened = settingsHarness(config, false, platform);
    assert.ok(reopened.elements(platform === 'web' ? 'button' : 'Pressable').some(item =>
      (item.props['aria-selected'] ?? item.props.accessibilityState?.selected) &&
      (item.props.accessibilityLabel ?? item.props.children) === 'Interview'));
    assert.equal(h.saved.length, 0);
  }
});

test('dialog dimensions stay constant across categories, model controls, and warnings', () => {
  for (const platform of ['web', 'native']) {
    for (const [width, height] of [[1024, 800], [360, 500]]) {
      const h = settingsHarness(config, false, platform, 0, '', 'session', undefined, undefined, { width, height });
      const dimensions = () => {
        if (platform === 'web') {
          const { width: dialogWidth, height: dialogHeight } = h.elements('dialog')[0].props.style;
          return { width: dialogWidth, height: dialogHeight };
        }
        const dialog = h.elements('View').find(item => item.props.accessibilityViewIsModal);
        const style = Object.assign({}, ...dialog.props.style);
        return { width: style.width, maxWidth: style.maxWidth, height: style.height };
      };
      const initial = dimensions();
      assert.deepEqual(initial, platform === 'web'
        ? { width: 'min(760px, calc(100vw - 40px))', height: 'min(640px, calc(100dvh - 40px))' }
        : { width: '100%', maxWidth: 760, height: height === 800 ? 640 : 460 });
      for (const category of platform === 'web' ? ['Model', 'Diagnostics', 'Interview'] : ['Model', 'Interview']) {
        h.openCategory(category);
        assert.deepEqual(dimensions(), initial);
      }
      h.openCategory('Model');
      const model = () => platform === 'web' ? h.elements('select')[0]
        : h.elements('ModelDropdown').find(item => item.props.label === 'Live model');
      for (const value of ['gemini-3.8-live-extended-thinking', 'gemini-3.8-live']) {
        if (platform === 'web') model().props.onChange({ target: { value } });
        else model().props.onChange(value);
        h.render();
        const effort = platform === 'web' ? h.elements('select').find(item => item.props['aria-label'] === 'Thinking effort')
          : h.elements('ModelDropdown').find(item => item.props.label === 'Thinking effort');
        assert.equal(!!effort, value === 'gemini-3.8-live-extended-thinking');
        assert.deepEqual(dimensions(), initial);
      }
      h.setWarnings('Question import failed. '.repeat(12), 'unavailable');
      assert.deepEqual(dimensions(), initial);
      const alerts = h.elements(platform === 'web' ? 'p' : 'Text').filter(item =>
        (item.props.role ?? item.props.accessibilityRole) === 'alert');
      assert.equal(alerts.length, 2);
      h.resize(360, 440);
      if (platform === 'native') assert.equal(dimensions().height, 400);
      else assert.deepEqual(dimensions(), initial);
      h.openCategory('Interview');
      if (platform === 'native') assert.equal(dimensions().height, 400);
      else assert.deepEqual(dimensions(), initial);
      assert.equal(h.saved.length, 0);
    }
  }
});

test('switching categories preserves edits until a single save or cancellation', () => {
  for (const platform of ['web', 'native']) {
    for (const action of ['Save', 'Cancel']) {
      const h = settingsHarness(config, false, platform);
      h.openCategory('Interview');
      const recovery = h.elements(platform === 'web' ? 'input' : 'Switch').find(item =>
        (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Save interview progress');
      if (platform === 'web') recovery.props.onChange({ target: { checked: true } });
      else recovery.props.onValueChange(true);
      h.render();
      h.openCategory('Model');
      const live = h.elements(platform === 'web' ? 'input' : 'TextInput')[0];
      if (platform === 'web') live.props.onChange({ target: { value: ' replacement key ' } });
      else live.props.onChangeText(' replacement key ');
      h.render();
      h.openCategory('Interview');
      const restored = h.elements(platform === 'web' ? 'input' : 'Switch').find(item =>
        (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Save interview progress');
      assert.equal(platform === 'web' ? restored.props.checked : restored.props.value, true);
      h.openCategory('Model');
      assert.equal(h.elements(platform === 'web' ? 'input' : 'TextInput')[0].props.value, ' replacement key ');
      if (action === 'Save' && platform === 'web') h.elements('form')[0].props.onSubmit({ preventDefault() {} });
      else h.openCategory(action);
      assert.equal(h.saved.length, action === 'Save' ? 1 : 0);
      assert.equal(h.closed.length, action === 'Cancel' ? 1 : 0);
      if (h.saved.length) {
        assert.equal(h.saved[0].saveInterviewState, true);
        assert.equal(h.saved[0].live.credential, 'replacement key');
      }
      assert.equal(config.live.credential, 'live-key');
      assert.equal(config.saveInterviewState, false);
    }
  }
});

test('web category tabs focus Interview on opening and support orientation-aware keyboard navigation', () => {
  for (const width of [360, 767, 768, 1024]) {
    const h = settingsHarness(config, true, 'web', 0, '', 'session', undefined, undefined, { width });
    const focused = [];
    const tabs = () => h.elements('button').filter(item => item.props.role === 'tab');
    const commitFocus = () => {
      h.elements('button').filter(item => item.props.ref).forEach(item => item.props.ref({
        focus: () => focused.push(item.props['aria-label'] ?? item.props.children),
      }));
      h.focusCategory();
    };
    const selected = () => tabs().find(item => item.props['aria-selected']);
    const key = value => {
      let prevented = false;
      selected().props.onKeyDown({ key: value, preventDefault: () => { prevented = true; } });
      h.render(); commitFocus();
      return prevented;
    };
    commitFocus();
    assert.equal(focused.at(-1), 'Interview');
    h.openCategory('Model'); commitFocus();
    assert.equal(focused.at(-1), 'Model');
    assert.equal(h.elements('div').find(item => item.props.role === 'tablist').props['aria-orientation'], width >= 768 ? 'vertical' : 'horizontal');
    assert.equal(key(width >= 768 ? 'ArrowDown' : 'ArrowRight'), true);
    assert.equal(selected().props.children, 'Diagnostics');
    assert.equal(key(width >= 768 ? 'ArrowDown' : 'ArrowRight'), true);
    assert.equal(selected().props.children, 'Interview');
    assert.equal(key(width >= 768 ? 'ArrowUp' : 'ArrowLeft'), true);
    assert.equal(selected().props.children, 'Diagnostics');
    assert.equal(key('Home'), true); assert.equal(selected().props.children, 'Interview');
    assert.equal(key('End'), true); assert.equal(selected().props.children, 'Diagnostics');
    assert.equal(key(width >= 768 ? 'ArrowRight' : 'ArrowDown'), false);
    assert.equal(selected().props.children, 'Diagnostics');
    assert.deepEqual(tabs().map(item => item.props.tabIndex), [-1, -1, 0]);
    const panel = h.elements('div').find(item => item.props.role === 'tabpanel');
    assert.ok(tabs().every(item => item.props['aria-controls'] === panel.props.id));
    assert.equal(panel.props['aria-labelledby'], selected().props.id);
    h.openCategory('Interview'); commitFocus();
    assert.equal(focused.at(-1), 'Interview');
    assert.equal(h.saved.length, 0);
  }
});

test('native navigation focuses the selected tab and changes layout for wide screens', () => {
  for (const width of [360, 768]) {
    const h = settingsHarness(config, true, 'native', 0, '', 'session', undefined, undefined, { width });
    const initialTab = h.elements('Pressable').find(item => item.props.accessibilityRole === 'tab' && item.props.accessibilityState.selected);
    initialTab.props.ref({ handle: 41 }); h.focusCategory();
    h.openCategory('Model');
    const tab = h.elements('Pressable').find(item => item.props.accessibilityRole === 'tab' && item.props.accessibilityState.selected);
    tab.props.ref({ handle: 42 }); h.focusCategory();
    assert.deepEqual(h.accessibilityFocus, [41, 42]);
    const navigation = h.elements('ScrollView').find(item => item.props.horizontal !== undefined);
    assert.equal(navigation.props.horizontal, width < 768);
    assert.equal(h.elements('TextInput').every(item => item.props.editable === false), true);
    h.openCategory('Interview');
    const category = h.elements('Pressable').find(item => item.props.accessibilityLabel === 'Interview');
    category.props.ref({ handle: 43 }); h.focusCategory();
    assert.deepEqual(h.accessibilityFocus, [41, 42, 43]);
    h.elements('Modal')[0].props.onRequestClose();
    assert.equal(h.closed.length, 1);
    assert.equal(h.saved.length, 0);
  }
});

test('import and credential-retention warnings remain visible across categories', () => {
  for (const platform of ['web', 'native']) {
    const h = settingsHarness(config, false, platform, 0, 'Question import failed.', 'unavailable', undefined, undefined,
      { credentialStorageStatus: 'unavailable' });
    const alerts = () => h.elements(platform === 'web' ? 'p' : 'Text').filter(item =>
      (item.props.role ?? item.props.accessibilityRole) === 'alert').map(item => item.props.children);
    const expected = ['Question import failed.', 'API keys could not be remembered. Re-enter them when needed.'];
    assert.deepEqual(alerts(), expected);
    for (const category of ['Interview', 'Model', 'Interview']) {
      h.openCategory(category);
      assert.deepEqual(alerts(), expected);
    }
    if (platform === 'web') {
      let prevented = false;
      h.elements('dialog')[0].props.onCancel({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
      assert.equal(h.closed.length, 1);
    }
  }
});

test('recovery and key retention default off, save independently, cancel, and lock on both platforms', () => {
  for (const platform of ['web', 'native']) {
    const recovery = h => {
      h.openCategory('Interview');
      return h.elements(platform === 'web' ? 'input' : 'Switch').find(item =>
        (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Save interview progress');
    };
    const remember = h => {
      h.openCategory('Model');
      return h.elements(platform === 'web' ? 'input' : 'Switch').find(item =>
        (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Remember API keys');
    };
    const toggleRecovery = h => {
      if (platform === 'web') recovery(h).props.onChange({ target: { checked: true } });
      else recovery(h).props.onValueChange(true);
      h.render();
    };
    const toggleRemember = h => {
      if (platform === 'web') remember(h).props.onChange({ target: { checked: true } });
      else remember(h).props.onValueChange(true);
      h.render();
    };
    const save = h => platform === 'web' ? h.elements('form')[0].props.onSubmit({ preventDefault() {} }) : h.elements('Pressable').at(-1).props.onPress();
    const h = categoryHarness('Model', config, false, platform);
    assert.equal(platform === 'web' ? recovery(h).props.checked : recovery(h).props.value, false);
    assert.equal(platform === 'web' ? remember(h).props.checked : remember(h).props.value, false);
    toggleRecovery(h); save(h);
    assert.equal(h.saved[0].saveInterviewState, true);
    assert.equal(h.saved[0].rememberApiKeys, false);
    toggleRemember(h); save(h);
    assert.equal(h.saved[1].rememberApiKeys, true);
    assert.equal(h.saved[1].live.credential, config.live.credential);
    assert.equal(h.saved[1].thinking.apiKey, config.thinking.apiKey);
    const canceled = categoryHarness('Model', config, false, platform);
    toggleRecovery(canceled); toggleRemember(canceled);
    if (platform === 'web') canceled.elements('button').find(item => item.props.children === 'Cancel').props.onClick();
    else canceled.elements('Pressable').find(item => item.props.accessibilityLabel === 'Cancel').props.onPress();
    assert.equal(canceled.saved.length, 0);
    assert.equal(canceled.closed.length, 1);
    const locked = categoryHarness('Model', config, true, platform);
    toggleRecovery(locked); toggleRemember(locked); save(locked);
    assert.equal(platform === 'web' ? recovery(locked).props.checked : recovery(locked).props.value, false);
    assert.equal(locked.saved.length, 0);
  }
});

test('web settings independently edit keys and dropdowns and save trimmed values', () => {
  const h = categoryHarness('Model');
  let inputs = h.elements('input').filter(item => item.props.type !== 'checkbox');
  assert.equal(inputs.length, 2); assert.ok(inputs.every(input => input.props.type === 'password'));
  inputs[0].props.onChange({ target: { value: ' live replacement ' } }); h.render();
  h.elements('input').filter(item => item.props.type === 'password')[1].props.onChange({ target: { value: ' thinking replacement ' } }); h.render();
  const selects = h.elements('select');
  assert.equal(h.elements('option', selects[0]).length, 2);
  assert.equal(h.elements('option', selects[1]).length, 2);
  selects[1].props.onChange({ target: { value: 'antigravity-preview-09-2026' } }); h.render();
  h.elements('form')[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(plain(h.saved), [{ problemSource: 'agent', problemSearchDescription: '', saveSearchedProblems: false, saveInterviewState: false, rememberApiKeys: false, live: { credential: 'live replacement', model: 'gemini-3.8-live' }, thinking: { provider: 'google', apiKey: 'thinking replacement', model: 'antigravity-preview-09-2026' } }]);
  assert.equal(config.live.credential, 'live-key'); assert.equal(config.thinking.apiKey, 'thinking-key');
});

test('web settings select either Live model and explain preference storage status', () => {
  for (const model of ['gemini-3.8-live-extended-thinking', 'gemini-3.8-live']) {
    const h = categoryHarness('Model');
    h.elements('select')[0].props.onChange({ target: { value: model } }); h.render();
    h.elements('form')[0].props.onSubmit({ preventDefault() {} });
    assert.equal(h.saved[0].live.model, model);
  }
  const saved = categoryHarness('Model', config, false, 'web', 0, '', 'saved');
  assert.ok(saved.elements('p').some(item => /remembered in this browser.*API keys and tokens/.test(item.props.children)));
  const unavailable = categoryHarness('Model', config, false, 'web', 0, '', 'unavailable');
  assert.ok(unavailable.elements('p').some(item => /Browser storage is unavailable/.test(item.props.children)));
});

test('web and native effort controls default, save, cancel, switch models, and lock consistently', () => {
  const extended = { ...config, live: { ...config.live, model: 'gemini-3.8-live-extended-thinking' } };
  for (const platform of ['web', 'native']) {
    const effort = h => platform === 'web'
      ? h.elements('select').find(item => item.props['aria-label'] === 'Thinking effort')
      : h.elements('ModelDropdown').find(item => item.props.label === 'Thinking effort');
    const model = h => platform === 'web' ? h.elements('select')[0]
      : h.elements('ModelDropdown').find(item => item.props.label === 'Live model');
    const change = (h, control, value) => {
      if (platform === 'web') control(h).props.onChange({ target: { value } });
      else control(h).props.onChange(value);
      h.render();
    };
    const save = h => platform === 'web' ? h.elements('form')[0].props.onSubmit({ preventDefault() {} })
      : h.elements('Pressable').at(-1).props.onPress();
    assert.equal(effort(categoryHarness('Model', config, false, platform)), undefined);
    const h = categoryHarness('Model', extended, false, platform);
    assert.equal(effort(h).props.value, 'medium');
    const options = platform === 'web' ? h.elements('option', effort(h)).map(item => ({ label: item.props.children, value: item.props.value }))
      : plain(effort(h).props.options);
    assert.deepEqual(options, [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }]);
    for (const value of ['low', 'medium', 'high']) {
      change(h, effort, value); save(h);
      assert.equal(h.saved.at(-1).live.thinkingEffort, value);
    }
    change(h, model, 'gemini-3.8-live');
    assert.equal(effort(h), undefined); save(h);
    assert.equal('thinkingEffort' in h.saved.at(-1).live, false);
    change(h, model, 'gemini-3.8-live-extended-thinking');
    assert.equal(effort(h).props.value, 'medium');
    const canceled = categoryHarness('Model', extended, false, platform);
    change(canceled, effort, 'high');
    if (platform === 'web') canceled.elements('button').find(item => ['Cancel', 'Close'].includes(item.props.children)).props.onClick();
    else canceled.elements('Pressable').find(item => item.props.accessibilityLabel === 'Cancel').props.onPress();
    assert.equal(canceled.saved.length, 0); assert.equal(canceled.closed.length, 1);
    assert.equal(extended.live.thinkingEffort, undefined);
    const locked = categoryHarness('Model', extended, true, platform);
    if (platform === 'web') {
      const section = locked.elements('fieldset').find(item => locked.elements('legend', item)[0].props.children === 'Live API');
      assert.equal(section.props.disabled, true);
    } else assert.equal(effort(locked).props.locked, true);
    change(locked, effort, 'high'); save(locked);
    assert.equal(effort(locked).props.value, 'medium'); assert.equal(locked.saved.length, 0);
    const stored = categoryHarness('Model', { ...extended, problemSource: 'stored' }, false, platform, 1);
    change(stored, effort, 'high'); save(stored);
    assert.equal(stored.saved[0].live.thinkingEffort, 'high');
  }
});

test('effort controls render different model-provided lists on both platforms', () => {
  const apiConfig = load('src/shared/apiConfig.ts');
  apiConfig.LIVE_MODELS.push({ label: 'Future model', value: 'future-model', thinkingEffort: {
    options: [{ label: 'Quick', value: 'quick' }, { label: 'Deep', value: 'deep' }], defaultValue: 'quick',
  } });
  for (const platform of ['web', 'native']) {
    const initial = { ...config, live: { ...config.live, model: 'future-model', thinkingEffort: 'medium' } };
    const h = categoryHarness('Model', initial, false, platform, 0, '', 'session', apiConfig);
    const effort = platform === 'web' ? h.elements('select').find(item => item.props['aria-label'] === 'Thinking effort')
      : h.elements('ModelDropdown').find(item => item.props.label === 'Thinking effort');
    assert.equal(effort.props.value, 'quick');
    if (platform === 'web') {
      assert.deepEqual(h.elements('option', effort).map(item => item.props.children), ['Quick', 'Deep']);
      effort.props.onChange({ target: { value: 'deep' } }); h.render();
      h.elements('form')[0].props.onSubmit({ preventDefault() {} });
    } else {
      assert.deepEqual(plain(effort.props.options).map(item => item.label), ['Quick', 'Deep']);
      effort.props.onChange('deep'); h.render(); h.elements('Pressable').at(-1).props.onPress();
    }
    assert.equal(h.saved[0].live.thinkingEffort, 'deep');
  }
});

test('web settings support partial saves, cancel without saving, and lock all controls', () => {
  const partial = categoryHarness('Model', { ...config, thinking: { ...config.thinking, apiKey: '' } });
  assert.equal(partial.elements('button').at(-1).props.disabled, false);
  partial.elements('form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(partial.saved[0].thinking.apiKey, '');
  const canceled = categoryHarness('Model');
  canceled.elements('input').find(item => item.props.type === 'password').props.onChange({ target: { value: 'discarded' } }); canceled.render();
  canceled.elements('button').find(item => ['Cancel', 'Close'].includes(item.props.children)).props.onClick();
  assert.equal(canceled.closed.length, 1); assert.equal(canceled.saved.length, 0);
  const locked = categoryHarness('Model', config, true);
  assert.ok(locked.elements('fieldset').every(section => section.props.disabled));
  assert.equal(locked.elements('button').at(-1).props.disabled, true);
  locked.elements('form')[0].props.onSubmit({ preventDefault() {} });
  assert.equal(locked.saved.length, 0);
});

test('web and native settings omit RPM and discard legacy values when saved', () => {
  for (const platform of ['web', 'native']) {
    const h = categoryHarness('Model', { ...config, thinking: { ...config.thinking, requestsPerMinute: -1 } }, false, platform);
    assert.equal(h.elements(platform === 'web' ? 'input' : 'TextInput').some(item => item.props.type === 'number' || item.props.keyboardType === 'number-pad'), false);
    if (platform === 'web') h.elements('form')[0].props.onSubmit({ preventDefault() {} });
    else h.elements('Pressable').at(-1).props.onPress();
    assert.equal(h.saved.length, 1);
    assert.equal('requestsPerMinute' in h.saved[0].thinking, false);
  }
});

function sourceControl(h, platform, label) {
  return h.elements(platform === 'web' ? 'input' : 'Pressable').find(item =>
    (item.props['aria-label'] ?? item.props.accessibilityLabel) === label);
}

function selectSource(h, platform, label) {
  const control = sourceControl(h, platform, label);
  if (platform === 'web') control.props.onChange();
  else control.props.onPress();
  h.render();
}

function saveSettings(h, platform) {
  if (platform === 'web') h.elements('form')[0].props.onSubmit({ preventDefault() {} });
  else h.openCategory('Save');
}

function descriptionControl(h, platform) {
  return h.elements(platform === 'web' ? 'textarea' : 'TextInput').find(item =>
    (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Problem description (optional)');
}

function editDescription(h, platform, value) {
  const control = descriptionControl(h, platform);
  if (platform === 'web') control.props.onChange({ target: { value } });
  else control.props.onChangeText(value);
  h.render();
}

test('problem descriptions are optional multiline preferences retained across sources, categories, saves and reloads', () => {
  const { readPreferences, writePreferences } = load('src/features/settings/storage/preferencesStorage.ts');
  const description = '  Medium graph problem\n最短路徑 {{literal}} $&  ';
  for (const platform of ['web', 'native']) {
    const h = settingsHarness(config, false, platform, 2);
    const control = () => descriptionControl(h, platform);
    assert.equal(control().props.value, '');
    assert.match(control().props.placeholder, /medium graph problem/);
    if (platform === 'web') {
      assert.equal(control().props.rows, 4);
      assert.ok(h.elements('p').some(item => item.props.id === control().props['aria-describedby']));
    } else {
      assert.equal(control().props.multiline, true);
      assert.equal(Object.assign({}, ...control().props.style).textAlignVertical, 'top');
    }
    editDescription(h, platform, description);
    h.resize(360, 500);
    assert.equal(control().props.value, description);
    h.openCategory('Model');
    assert.equal(control(), undefined);
    h.openCategory('Interview');
    assert.equal(control().props.value, description);
    selectSource(h, platform, 'Local questions');
    assert.equal(control(), undefined);
    saveSettings(h, platform);
    assert.equal(h.saved[0].problemSearchDescription, description.trim());
    const storage = memoryStorage();
    writePreferences(storage, h.saved[0]);
    const reopened = settingsHarness(readPreferences(storage, config), false, platform, 2);
    assert.equal(descriptionControl(reopened, platform), undefined);
    selectSource(reopened, platform, 'Web search');
    assert.equal(descriptionControl(reopened, platform).props.value, description.trim());
    selectSource(h, platform, 'Web search');
    assert.equal(control().props.value, description);
    editDescription(h, platform, ' \n\t ');
    saveSettings(h, platform);
    assert.equal(h.saved.at(-1).problemSearchDescription, '');
    writePreferences(storage, h.saved.at(-1));
    assert.equal(readPreferences(storage, config).problemSearchDescription, '');
    assert.equal(config.problemSearchDescription, '');
  }
});

test('problem-description edits cancel without saving and cannot change locked settings', () => {
  for (const platform of ['web', 'native']) {
    const initial = { ...config, problemSearchDescription: 'Easy tree traversal' };
    const canceled = settingsHarness(initial, false, platform);
    editDescription(canceled, platform, 'Hard dynamic programming');
    canceled.openCategory('Cancel');
    assert.equal(canceled.saved.length, 0);
    assert.equal(descriptionControl(settingsHarness(initial, false, platform), platform).props.value, initial.problemSearchDescription);
    const locked = settingsHarness(initial, true, platform);
    const control = descriptionControl(locked, platform);
    assert.equal(platform === 'web' ? control.props.disabled : !control.props.editable, true);
    editDescription(locked, platform, 'Hard dynamic programming');
    assert.equal(descriptionControl(locked, platform).props.value, initial.problemSearchDescription);
    saveSettings(locked, platform);
    assert.equal(locked.saved.length, 0);
  }
});

test('question sources select one mode and preserve Save/Cancel and locking on both platforms', () => {
  for (const platform of ['web', 'native']) {
    const checked = (h, label) => platform === 'web' ? sourceControl(h, platform, label).props.checked
      : sourceControl(h, platform, label).props.accessibilityState.checked;
    for (const initialSource of ['agent', 'stored']) {
      const h = categoryHarness('Interview', { ...config, problemSource: initialSource }, false, platform, 2);
      assert.equal(checked(h, 'Local questions'), initialSource === 'stored');
      assert.equal(checked(h, 'Web search'), initialSource !== 'stored');
      const group = h.elements(platform === 'web' ? 'div' : 'View').find(item =>
        (item.props.role ?? item.props.accessibilityRole) === 'radiogroup');
      assert.equal(group.props['aria-label'] ?? group.props.accessibilityLabel, 'Question source');
      if (platform === 'web') {
        const radios = h.elements('input', group);
        assert.deepEqual(radios.map(item => item.props.type), ['radio', 'radio']);
        assert.deepEqual(radios.map(item => item.props.name), ['question-source', 'question-source']);
      }
      selectSource(h, platform, 'Local questions'); saveSettings(h, platform);
      assert.equal(h.saved[0].problemSource, 'stored');
      selectSource(h, platform, 'Web search'); saveSettings(h, platform);
      assert.equal(h.saved[1].problemSource, 'agent');
    }
    assert.equal(config.problemSource, 'agent');
    const canceled = categoryHarness('Interview', config, false, platform, 2);
    selectSource(canceled, platform, 'Local questions');
    canceled.openCategory('Cancel');
    assert.equal(canceled.closed.length, 1);
    assert.equal(canceled.saved.length, 0);
    for (const initialSource of ['agent', 'stored']) {
      const locked = categoryHarness('Interview', { ...config, problemSource: initialSource }, true, platform, 2);
      for (const label of ['Local questions', 'Web search']) {
        assert.equal(sourceControl(locked, platform, label).props.disabled, true);
        selectSource(locked, platform, label);
      }
      saveSettings(locked, platform);
      assert.equal(checked(locked, 'Local questions'), initialSource === 'stored');
      assert.equal(locked.saved.length, 0);
    }
  }
});

test('empty local banks disable the local choice and allow escaping a restored local selection', () => {
  for (const platform of ['web', 'native']) {
    for (const initialSource of ['agent', 'stored']) {
      const h = categoryHarness('Interview', { ...config, problemSource: initialSource }, false, platform);
      const local = sourceControl(h, platform, 'Local questions');
      assert.equal(local.props.disabled, true);
      assert.equal(sourceControl(h, platform, 'Web search').props.disabled, false);
      assert.equal(h.elements(platform === 'web' ? 'p' : 'Text').some(item => item.props.children === 'No local questions yet.'), true);
      if (platform === 'web') assert.equal(local.props['aria-describedby'], 'settings-local-empty');
      else assert.equal(local.props.accessibilityHint, 'No local questions yet.');
      selectSource(h, platform, 'Local questions'); saveSettings(h, platform);
      assert.equal(h.saved.length, initialSource === 'stored' ? 0 : 1);
      if (h.saved.length) assert.equal(h.saved[0].problemSource, 'agent');
      selectSource(h, platform, 'Web search'); saveSettings(h, platform);
      assert.equal(h.saved.at(-1).problemSource, 'agent');
    }
  }
});

test('mode-specific settings hide irrelevant content and retain hidden web-saving preferences across categories and reloads', () => {
  const { readPreferences, writePreferences } = load('src/features/settings/storage/preferencesStorage.ts');
  for (const platform of ['web', 'native']) {
    for (const count of [1, 2]) {
      const h = categoryHarness('Interview', config, false, platform, count);
      const control = () => h.elements(platform === 'web' ? 'input' : 'Switch').find(item =>
        (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Save found questions');
      const notes = () => h.elements(platform === 'web' ? 'p' : 'Text').map(item => item.props.children);
      const available = `${count} ${count === 1 ? 'question' : 'questions'} available`;
      assert.equal(notes().includes(available), false);
      if (platform === 'web') control().props.onChange({ target: { checked: true } });
      else control().props.onValueChange(true);
      h.render();
      selectSource(h, platform, 'Local questions');
      assert.equal(control(), undefined);
      assert.equal(notes().includes('Add web questions to your local collection for future interviews.'), false);
      assert.equal(notes().includes(available), true);
      assert.equal(notes().includes('Pick a random question from your local collection.'), true);
      h.openCategory('Model'); h.openCategory('Interview');
      assert.equal(control(), undefined);
      saveSettings(h, platform);
      assert.equal(h.saved[0].saveSearchedProblems, true);
      const storage = memoryStorage();
      writePreferences(storage, h.saved[0]);
      const restored = readPreferences(storage, config);
      const reopened = categoryHarness('Interview', restored, false, platform, count);
      selectSource(reopened, platform, 'Web search');
      const restoredControl = reopened.elements(platform === 'web' ? 'input' : 'Switch').find(item =>
        (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Save found questions');
      assert.equal(platform === 'web' ? restoredControl.props.checked : restoredControl.props.value, true);
      selectSource(h, platform, 'Web search');
      assert.equal(platform === 'web' ? control().props.checked : control().props.value, true);
      assert.equal(notes().includes(available), false);
      assert.equal(notes().includes('Pick a random question from your local collection.'), false);
      assert.equal(notes().includes('Add web questions to your local collection for future interviews.'), true);
    }
  }
});

test('searched-question saving defaults off, edits independently, cancels, and locks on both platforms', () => {
  for (const platform of ['web', 'native']) {
    const control = h => h.elements(platform === 'web' ? 'input' : 'Switch').find(item =>
      (item.props['aria-label'] ?? item.props.accessibilityLabel) === 'Save found questions');
    const checked = h => platform === 'web' ? control(h).props.checked : control(h).props.value;
    const toggle = (h, value) => {
      if (platform === 'web') control(h).props.onChange({ target: { checked: value } });
      else control(h).props.onValueChange(value);
      h.render();
    };
    const h = categoryHarness('Interview', config, false, platform);
    assert.equal(checked(h), false);
    toggle(h, true); saveSettings(h, platform);
    assert.equal(h.saved[0].saveSearchedProblems, true);
    assert.equal(config.saveSearchedProblems, false);
    toggle(h, false); saveSettings(h, platform);
    assert.equal(h.saved[1].saveSearchedProblems, false);
    const canceled = categoryHarness('Interview', config, false, platform);
    toggle(canceled, true); canceled.openCategory('Cancel');
    assert.equal(canceled.saved.length, 0);
    assert.equal(canceled.closed.length, 1);
    const locked = categoryHarness('Interview', { ...config, problemSource: 'agent', saveSearchedProblems: true }, true, platform, 1);
    assert.equal(control(locked).props.disabled, true);
    toggle(locked, false); saveSettings(locked, platform);
    assert.equal(checked(locked), true);
    assert.equal(locked.saved.length, 0);
  }
});

test('stored settings keep Thinking credentials editable and reject an empty bank', () => {
  for (const platform of ['web', 'native']) {
    const initial = { ...config, problemSource: 'stored', thinking: { ...config.thinking, apiKey: '' } };
    const h = categoryHarness('Model', initial, false, platform, 1);
    if (platform === 'web') {
      const thinking = h.elements('fieldset').find(section => h.elements('legend', section)[0].props.children === 'Thinking API');
      assert.equal(thinking.props.disabled, false);
      h.elements('input').filter(item => item.props.type === 'password')[1].props.onChange({ target: { value: 'grading-key' } });
      h.render();
      h.elements('form')[0].props.onSubmit({ preventDefault() {} });
    } else {
      assert.equal(h.elements('TextInput')[1].props.editable, true);
      h.elements('TextInput')[1].props.onChangeText('grading-key');
      h.render();
      h.elements('Pressable').at(-1).props.onPress();
    }
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].problemSource, 'stored');
    assert.equal(h.saved[0].thinking.apiKey, 'grading-key');
    const empty = categoryHarness('Model', initial, false, platform);
    if (platform === 'web') empty.elements('form')[0].props.onSubmit({ preventDefault() {} });
    else empty.elements('Pressable').at(-1).props.onPress();
    assert.equal(empty.saved.length, 0);
  }
});

test('import warnings are visible even when there are no valid questions', () => {
  for (const platform of ['web', 'native']) {
    const h = categoryHarness('Model', config, false, platform, 0, 'Question database could not be imported.');
    const alerts = h.elements(platform === 'web' ? 'p' : 'Text').filter(item => item.props.role === 'alert' || item.props.accessibilityRole === 'alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].props.children, 'Question database could not be imported.');
  }
});

test('web log controls remain usable while interview settings are locked and report operation errors', async () => {
  const { deferred } = require('./helpers/fixtures.cjs');
  const pending = deferred();
  let downloads = 0, clears = 0;
  const logTools = {
    downloadLogs: () => { downloads++; return pending.promise; },
    logStorage: {
      getStatus: () => ({ mode: 'session', message: 'Logs are kept for this session only.', omittedRecords: 2 }),
      subscribe: () => () => {},
      clearLogs: async () => { clears++; throw new Error('Saved logs could not be cleared.'); },
    },
  };
  const h = categoryHarness('Diagnostics', config, true, 'web', 0, '', 'session', undefined, logTools);
  const button = text => h.elements('button').find(item => item.props.children === text);
  assert.ok(h.elements('fieldset').every(item => item.props.disabled));
  assert.equal(button('Save').props.disabled, true);
  assert.equal(button('Download logs').props.disabled, false);
  assert.equal(button('Clear logs').props.disabled, false);
  assert.ok(h.elements('p').some(item => item.props.role === 'status' && /session only/.test(item.props.children)));
  const downloading = button('Download logs').props.onClick(); h.render();
  assert.equal(button('Downloading…').props.disabled, true);
  assert.equal(button('Clear logs').props.disabled, true);
  h.openCategory('Model');
  assert.ok(h.elements('fieldset').length > 0);
  assert.ok(h.elements('fieldset').every(item => item.props.disabled));
  h.openCategory('Diagnostics');
  assert.equal(button('Downloading…').props.disabled, true);
  await button('Downloading…').props.onClick();
  assert.equal(downloads, 1);
  pending.resolve(); await downloading; h.render();
  assert.equal(downloads, 1);
  await button('Clear logs').props.onClick(); h.render();
  assert.equal(clears, 1);
  assert.ok(h.elements('p').some(item => item.props.role === 'alert' && item.props.children === 'Saved logs could not be cleared.'));
  h.openCategory('Interview');
  h.openCategory('Diagnostics');
  assert.ok(h.elements('p').some(item => item.props.role === 'alert' && item.props.children === 'Saved logs could not be cleared.'));
  assert.equal(h.saved.length, 0);
  assert.equal(settingsHarness(config, true, 'native').elements('button').length, 0);
});

test('web settings show download errors and allow another operation afterward', async () => {
  const h = categoryHarness('Diagnostics', config, false, 'web', 0, '', 'session', undefined, {
    downloadLogs: async () => { throw new Error('Download unavailable.'); },
    logStorage: { getStatus: () => ({ mode: 'persistent', message: 'Logs saved.', omittedRecords: 0 }),
      subscribe: () => () => {}, clearLogs: async () => {} },
  });
  const button = text => h.elements('button').find(item => item.props.children === text);
  await button('Download logs').props.onClick(); h.render();
  assert.ok(h.elements('p').some(item => item.props.role === 'alert' && item.props.children === 'Download unavailable.'));
  await button('Clear logs').props.onClick(); h.render();
  assert.equal(h.elements('p').filter(item => item.props.role === 'alert').length, 0);
});

test('web settings observe storage status changes and unsubscribe on cleanup', () => {
  let status = { mode: 'loading', message: 'Checking storage…', omittedRecords: 0 };
  let listener, unsubscribed = false;
  const h = categoryHarness('Diagnostics', config, true, 'web', 0, '', 'session', undefined, {
    downloadLogs: async () => {},
    logStorage: {
      getStatus: () => status,
      subscribe(callback) { listener = callback; return () => { unsubscribed = true; }; },
      clearLogs: async () => {},
    },
  });
  const cleanup = h.subscribeLogs();
  status = { mode: 'session', message: 'Session-only logs.', omittedRecords: 1 };
  listener(); h.render();
  assert.ok(h.elements('p').some(item => item.props.role === 'status' && item.props.children === 'Session-only logs.'));
  assert.ok(h.elements('p').some(item => Array.isArray(item.props.children) && item.props.children[0] === 1));
  cleanup(); assert.equal(unsubscribed, true);
});
