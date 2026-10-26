const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { config, harness, plain } = require('./helpers/fixtures.cjs');

const native = {
  ...Object.fromEntries(['Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])),
  StyleSheet: { create: value => value },
};
function elements(type, node) {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(item => elements(type, item));
  return [...(node.type === type ? [node] : []), ...elements(type, node.props?.children)];
}
const Chat = load('src/features/interview/components/ChatPanel/ChatPanel.tsx', {}, {
  'react-native': native, react: { useState: () => ['', () => {}], useRef: () => ({ current: null }) },
}).default;
function history(h) {
  return elements('ScrollView', Chat({ configured: true, retryConfigured: true, live: h.snapshot }))[0];
}
function historyText(h) {
  return elements('Text', history(h)).map(item => item.props.children);
}
async function connected(h) {
  await h.session.connect(config);
  const socket = h.liveSessions.at(-1);
  await socket.receive({ setupComplete: {} });
  return socket;
}

test('discussion echoes show only the event during streaming, across model turns, and with whitespace differences', async () => {
  const h = harness();
  try {
    const socket = await connected(h);
    const notes = 'Use a map.\nCheck duplicates 😀';
    h.session.setDiscussion(notes);
    h.session.send(notes, { kind: 'discussion' });
    assert.deepEqual(historyText(h), ['Discussion sent']);
    await socket.receive({ serverContent: { inputTranscription: { text: '  Use', finished: false } } });
    assert.deepEqual(historyText(h), ['Discussion sent']);
    await socket.receive({ serverContent: { outputTranscription: { text: 'Explain its complexity.' }, turnComplete: true } });
    await socket.receive({ serverContent: { inputTranscription: { text: ' a map.\r\n', finished: false } } });
    assert.deepEqual(historyText(h), ['Discussion sent', 'Gemini', 'Explain its complexity.']);
    await socket.receive({ serverContent: { inputTranscription: { text: 'Check duplicates 😀  ', finished: true } } });
    assert.deepEqual(historyText(h), ['Discussion sent', 'Gemini', 'Explain its complexity.']);
    assert.equal(h.snapshot.messages.length, 2);
    assert.equal(h.snapshot.messages[0].text, notes);
    assert.equal(h.snapshot.discussion, notes);
    assert.doesNotMatch(JSON.stringify(history(h)), /Use a map|Check duplicates/);
    h.session.send(notes, { kind: 'discussion' });
    await socket.receive({ serverContent: { inputTranscription: { text: 'Use a map. Check duplicates 😀' } } });
    await socket.receive({ serverContent: { inputTranscription: { text: ' \n', finished: true } } });
    assert.deepEqual(historyText(h), ['Discussion sent', 'Gemini', 'Explain its complexity.', 'Discussion sent']);
    await socket.receive({ serverContent: { inputTranscription: { text: 'I would test an empty array.', finished: true } } });
    assert.deepEqual(historyText(h).slice(-2), ['You', 'I would test an empty array.']);
  } finally { h.session.disconnect(); }
});

test('raw and marked discussion echoes consume the same pending send and preserve subsequent speech', async () => {
  for (const marked of [false, true]) {
    const h = harness();
    try {
      const socket = await connected(h);
      const notes = 'Use a map.\nCheck duplicates 😀';
      h.session.setDiscussion(notes);
      assert.equal(h.session.send(notes, { kind: 'discussion' }), true);
      const echo = `  ${marked ? '[Discussion notes]\r\n' : ''}Use a map.\r\nCheck duplicates 😀  `;
      await socket.receive({ serverContent: { inputTranscription: { text: echo.slice(0, 9), finished: false } } });
      assert.deepEqual(historyText(h), ['Discussion sent']);
      await socket.receive({ serverContent: { outputTranscription: { text: 'Which edge cases matter?' }, turnComplete: true } });
      await socket.receive({ serverContent: { inputTranscription: { text: echo.slice(9), finished: true } } });
      assert.deepEqual(historyText(h), ['Discussion sent', 'Gemini', 'Which edge cases matter?']);
      assert.equal(h.snapshot.messages[0].text, notes);
      assert.equal(h.snapshot.discussion, notes);
      await socket.receive({ serverContent: { inputTranscription: { text: notes, finished: true } } });
      assert.deepEqual(historyText(h).slice(-2), ['You', notes], 'matching either variant removes all alternatives for that send');
    } finally { h.session.disconnect(); }
  }
});

test('speech that diverges from a discussion prefix clears pending notes and preserves subsequent identical speech', async () => {
  const h = harness();
  try {
    const socket = await connected(h);
    const notes = 'Use a map to find duplicates.';
    h.session.send(notes, { kind: 'discussion' });
    await socket.receive({ serverContent: { inputTranscription: { text: 'Use a ', finished: false } } });
    assert.deepEqual(historyText(h), ['Discussion sent']);
    await socket.receive({ serverContent: { inputTranscription: { text: 'heap instead.', finished: true } } });
    assert.deepEqual(historyText(h), ['Discussion sent', 'You', 'Use a heap instead.']);
    await socket.receive({ serverContent: { inputTranscription: { text: 'Use a map', finished: false } } });
    assert.deepEqual(historyText(h).slice(-2), ['You', 'Use a map']);
    await socket.receive({ serverContent: { inputTranscription: { finished: true } } });
    await socket.receive({ serverContent: { inputTranscription: { text: notes, finished: true } } });
    assert.deepEqual(historyText(h).slice(-2), ['You', notes]);
  } finally { h.session.disconnect(); }
});

test('multiple discussion sends reconcile independently, including repeated text and out-of-order echoes', async () => {
  const h = harness();
  try {
    const socket = await connected(h);
    for (const text of ['First approach.', 'Second approach.', 'First approach.']) h.session.send(text, { kind: 'discussion' });
    for (const text of ['[Discussion notes]\nSecond approach.', 'First approach.', '[Discussion notes]\nFirst approach.']) {
      await socket.receive({ serverContent: { inputTranscription: { text, finished: true } } });
      assert.deepEqual(historyText(h), ['Discussion sent', 'Discussion sent', 'Discussion sent']);
    }
    const send = socket.send;
    socket.send = () => { throw new Error('Send failed'); };
    assert.equal(h.session.send('An unsent approach.', { kind: 'discussion' }), false);
    socket.send = send;
    await socket.receive({ serverContent: { inputTranscription: { text: 'An unsent approach.', finished: true } } });
    assert.deepEqual(historyText(h).slice(-2), ['You', 'An unsent approach.']);
  } finally { h.session.disconnect(); }
});

test('grading captures unresolved spoken prefixes and cleanup clears matching state for a new interview', async () => {
  const h = harness();
  try {
    const socket = await connected(h);
    const notes = 'Use a map to find duplicates.';
    h.session.send(notes, { kind: 'discussion' });
    await socket.receive({ serverContent: { inputTranscription: { text: 'Use a map', finished: false } } });
    assert.equal(h.snapshot.messages.length, 1);
    await h.session.endInterview({ code: '', language: 'C++' }, config.thinking);
    const request = h.judgments.find(call => call[1].kind === 'interview')[1];
    assert.deepEqual(plain(request.messages).map(message => ({ text: message.text, kind: message.kind })), [
      { text: notes, kind: 'discussion' }, { text: 'Use a map', kind: undefined },
    ]);
    const fresh = await connected(h);
    await fresh.receive({ serverContent: { inputTranscription: { text: notes, finished: true } } });
    assert.deepEqual(historyText(h), ['You', notes]);
    h.session.send(notes, { kind: 'discussion' });
    await fresh.receive({ serverContent: { inputTranscription: { text: `[Discussion notes]\n${notes}`, finished: false } } });
    const count = h.snapshot.messages.length;
    h.session.disconnect();
    assert.equal(h.snapshot.messages.length, count, 'a complete buffered echo is not flushed as speech');
  } finally { h.session.disconnect(); }
});

test('held speech is released after two turns and all subsequent speech reaches grading', async () => {
  const h = harness();
  try {
    const socket = await connected(h);
    h.session.send('Use a map to find duplicates.', { kind: 'discussion' });
    await socket.receive({ serverContent: { inputTranscription: { text: 'Use a map', finished: false } } });
    await socket.receive({ serverContent: { turnComplete: true } });
    assert.equal(h.snapshot.messages.length, 1, 'one turn late echoes are still eligible');
    await socket.receive({ serverContent: { turnComplete: true } });
    assert.deepEqual(historyText(h), ['Discussion sent', 'You', 'Use a map']);
    await socket.receive({ serverContent: { inputTranscription: { text: ' instead of sorting.', finished: true } } });
    assert.deepEqual(historyText(h).slice(-2), ['You', ' instead of sorting.']);
    await h.session.endInterview({ code: '', language: 'C++' }, config.thinking);
    const request = h.judgments.find(call => call[1].kind === 'interview')[1];
    assert.deepEqual(plain(request.messages).map(message => message.text), ['Use a map to find duplicates.', 'Use a map', ' instead of sorting.']);
  } finally { h.session.disconnect(); }
});

test('speech identical to notes is kept after expiry, including a fully buffered match', async () => {
  for (const held of [false, true]) {
    const h = harness();
    try {
      const socket = await connected(h);
      const notes = 'Use a map.';
      h.session.send(notes, { kind: 'discussion' });
      if (held) await socket.receive({ serverContent: { inputTranscription: { text: notes, finished: false } } });
      await socket.receive({ serverContent: { turnComplete: true } });
      assert.equal(h.snapshot.messages.length, 1);
      await socket.receive({ serverContent: { turnComplete: true } });
      if (!held) await socket.receive({ serverContent: { inputTranscription: { text: notes, finished: true } } });
      assert.deepEqual(historyText(h), ['Discussion sent', 'You', notes]);
    } finally { h.session.disconnect(); }
  }
});

test('unrelated speech clears every pending note and a finished prefix counts as speech', () => {
  const { DiscussionEchoMatcher } = load('src/features/interview/session/discussionEchoMatcher.ts');
  for (const speech of ['Check empty inputs.', 'Use a']) {
    const matcher = new DiscussionEchoMatcher();
    matcher.register('Use a map.');
    matcher.register('Use a heap.');
    assert.equal(matcher.read(speech, false), speech.startsWith('Use') ? '' : speech);
    if (speech.startsWith('Use')) assert.equal(matcher.read('', true), speech);
    assert.equal(matcher.read('Use a map.', true), 'Use a map.');
    assert.equal(matcher.read('Use a heap.', true), 'Use a heap.');
  }
});

test('pending notes age independently and hold speech only while a matching note remains', () => {
  const { DiscussionEchoMatcher } = load('src/features/interview/session/discussionEchoMatcher.ts');
  const matcher = new DiscussionEchoMatcher();
  matcher.register('Use a map.');
  assert.equal(matcher.endTurn(), '');
  matcher.register('Use a heap.');
  assert.equal(matcher.read('Use a ', false), '');
  assert.equal(matcher.endTurn(), '', 'the newer note still matches the buffered prefix');
  assert.equal(matcher.endTurn(), 'Use a ', 'the newer note expires on its second turn');
  assert.equal(matcher.read('Use a heap.', true), 'Use a heap.');
});

test('web chat Ctrl/Cmd+Enter sends once without inserting a newline; other keys, composition, and repeats do not send', () => {
  let sends = 0, edited;
  const ChatInput = load('src/features/interview/components/ChatInput/ChatInput.web.tsx', {}, {
    react: { useRef: () => ({ current: null }), useEffect() {} },
  }).default;
  const props = { value: 'Typed chat\n😀', onChange: value => { edited = value; }, onSend: () => { sends++; }, sendDisabled: false };
  const tree = ChatInput(props);
  const field = elements('textarea', tree)[0];
  assert.equal(field.props['aria-label'], 'Chat message');
  assert.equal(field.props['aria-describedby'], elements('span', tree)[0].props.id);
  field.props.onChange({ currentTarget: { value: 'Edited chat\n😀' } });
  assert.equal(edited, 'Edited chat\n😀');
  const key = (input, overrides) => {
    let prevented = false;
    const before = sends;
    input.props.onKeyDown({ key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false,
      nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault: () => { prevented = true; }, ...overrides });
    return { prevented, sends: sends - before };
  };
  for (const modifier of ['ctrlKey', 'metaKey']) {
    assert.deepEqual(key(field, { [modifier]: true }), { prevented: true, sends: 1 });
    assert.deepEqual(key(field, { [modifier]: true, repeat: true }), { prevented: true, sends: 0 });
    for (const extra of [{ shiftKey: true }, { altKey: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
      assert.deepEqual(key(field, { [modifier]: true, ...extra }), { prevented: false, sends: 0 });
    }
    for (const unavailable of [{ sendDisabled: true }, { value: '' }, { value: ' \n ' }]) {
      const disabled = elements('textarea', ChatInput({ ...props, ...unavailable }))[0];
      assert.deepEqual(key(disabled, { [modifier]: true }), { prevented: true, sends: 0 });
    }
  }
  for (const other of [{}, { shiftKey: true }, { key: 'a', ctrlKey: true }]) {
    assert.deepEqual(key(field, other), { prevented: false, sends: 0 });
  }
});

test('chat button and input shortcut share sending, clearing only successful nonempty drafts', () => {
  let draft = '', accept = true;
  const sends = [];
  const ChatInput = () => null;
  const ChatPanel = load('src/features/interview/components/ChatPanel/ChatPanel.tsx', {}, {
    'react-native': native,
    react: { useState: () => [draft, value => { draft = value; }], useRef: () => ({ current: null }) },
    '../ChatInput/ChatInput': { default: ChatInput },
  }).default;
  const live = { status: 'connected', messages: [], judgment: { status: 'idle' },
    send: text => { sends.push(text); return accept; } };
  const render = () => ChatPanel({ configured: true, retryConfigured: true, live });
  const input = () => elements(ChatInput, render())[0];
  const button = () => elements('Pressable', render()).find(item => elements('Text', item).some(label => label.props.children === 'Send'));
  assert.equal(input().props.sendDisabled, true);
  input().props.onSend(); button().props.onPress();
  assert.deepEqual(sends, []);
  input().props.onChange('Typed approach\n😀');
  assert.equal(input().props.sendDisabled, false);
  input().props.onSend();
  assert.equal(draft, '');
  assert.deepEqual(sends, ['Typed approach\n😀']);
  accept = false;
  input().props.onChange('Retry this draft');
  button().props.onPress();
  assert.equal(draft, 'Retry this draft');
  assert.deepEqual(sends, ['Typed approach\n😀', 'Retry this draft']);
  accept = true;
  input().props.onSend();
  assert.equal(draft, '');
  input().props.onChange(' \n ');
  input().props.onSend(); button().props.onPress();
  assert.equal(sends.length, 3);
  live.status = 'disconnected';
  assert.equal(elements(ChatInput, render()).length, 0);
});

test('native chat input keeps multiline editing without browser shortcut handlers', () => {
  let edited;
  const ChatInput = load('src/features/interview/components/ChatInput/ChatInput.tsx', {}, {
    'react-native': native, react: { useState: () => [40, () => {}] },
  }).default;
  const input = ChatInput({ value: 'Native\n😀', onChange: value => { edited = value; }, onSend() {}, sendDisabled: false });
  assert.equal(input.props.multiline, true);
  assert.equal(input.props.value, 'Native\n😀');
  input.props.onChangeText('Edited\nnotes');
  assert.equal(edited, 'Edited\nnotes');
  assert.equal(input.props.onKeyDown, undefined);
  assert.equal(input.props.onSubmitEditing, undefined);
});

test('microphone toggle is the first composer action and exposes its enabled state', async () => {
  const h = harness();
  try {
    await connected(h);
    const render = () => Chat({ configured: true, retryConfigured: true, live: { ...h.snapshot, toggleMic: h.session.toggleMic } });
    const controls = () => elements('Pressable', render()).slice(-2);
    const labels = () => controls().map(button => button.props.accessibilityLabel ?? elements('Text', button)[0].props.children);
    assert.deepEqual(labels(), ['Disable microphone', 'Send']);
    assert.equal(elements('Text', controls()[0]).length, 0);
    assert.equal(controls()[0].props.accessibilityState.selected, true);
    await controls()[0].props.onPress();
    assert.deepEqual(labels(), ['Enable microphone', 'Send']);
    assert.equal(controls()[0].props.accessibilityState.selected, false);
    await controls()[0].props.onPress();
    assert.deepEqual(labels(), ['Disable microphone', 'Send']);
    assert.equal(controls()[1].props.disabled, true);
    h.session.disconnect();
    assert.equal(elements('Pressable', render()).some(button =>
      ['Enable microphone', 'Disable microphone'].includes(button.props.accessibilityLabel)
      || elements('Text', button).some(text => text.props.children === 'Send')), false);
  } finally { h.session.disconnect(); }
});

test('web chat grows with content and width changes, caps long messages, and shrinks when cleared', () => {
  const effects = []; let resized, disconnected = false, contentHeight = 38;
  const input = { clientWidth: 240, scrollTop: 0, style: {}, get scrollHeight() { return contentHeight; } };
  const ChatInput = load('src/features/interview/components/ChatInput/ChatInput.web.tsx', {
    ResizeObserver: class {
      constructor(callback) { resized = callback; }
      observe(element) { assert.equal(element, input); }
      disconnect() { disconnected = true; }
    },
  }, { react: { useRef: () => ({ current: input }), useEffect: effect => effects.push(effect) } }).default;
  const props = { value: '', onChange() {}, onSend() {}, sendDisabled: false };
  let field = elements('textarea', ChatInput(props))[0];
  const cleanups = effects.splice(0).map(effect => effect());
  assert.equal(field.props.rows, 1);
  assert.equal(input.style.height, '40px');
  contentHeight = 82;
  ChatInput({ ...props, value: 'First line\nSecond line\nThird line' });
  effects.splice(0)[0]();
  assert.equal(input.style.height, '84px');
  contentHeight = 450; input.scrollTop = 160;
  ChatInput({ ...props, value: 'Long message' });
  effects.splice(0)[0]();
  assert.equal(input.style.height, '140px');
  assert.equal(field.props.style.overflow, 'auto');
  assert.equal(input.scrollTop, 160);
  contentHeight = 60; input.clientWidth = 400;
  resized();
  assert.equal(input.style.height, '62px');
  contentHeight = 38;
  field = elements('textarea', ChatInput(props))[0];
  effects.splice(0)[0]();
  assert.equal(input.style.height, '40px');
  assert.equal(field.props.style.resize, 'none');
  cleanups.forEach(cleanup => cleanup?.());
  assert.equal(disconnected, true);
});

test('native chat grows with multiline content, scrolls at its cap, and collapses after clearing', () => {
  let contentHeight = 40;
  const ChatInput = load('src/features/interview/components/ChatInput/ChatInput.tsx', {}, {
    'react-native': native, react: { useState: () => [contentHeight, value => { contentHeight = value; }] },
  }).default;
  const props = { value: 'First line\nSecond line', onChange() {}, onSend() {}, sendDisabled: false };
  let field = ChatInput(props);
  assert.equal(field.props.style[1].height, 40);
  field.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 60 } } });
  field = ChatInput(props);
  assert.equal(field.props.style[1].height, 62);
  assert.equal(field.props.scrollEnabled, false);
  field.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 450 } } });
  field = ChatInput(props);
  assert.equal(field.props.style[1].height, 140);
  assert.equal(field.props.scrollEnabled, true);
  field = ChatInput({ ...props, value: '' });
  assert.equal(field.props.style[1].height, 40);
  assert.equal(field.props.scrollEnabled, false);
  field.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 38 } } });
  field = ChatInput({ ...props, value: 'Short message' });
  assert.equal(field.props.style[1].height, 40);
});
