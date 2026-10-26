const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { sampleProblem, config, testRuntime, formatDiscussionMessage } = require('./helpers/fixtures.cjs');
const { createJudgmentWorkflow } = load('src/features/interview/judgment/createJudgmentWorkflow.ts');

test('React session bridge resubscribes and reconnects after Strict Mode effect cleanup', async () => {
  let value, effect, cleanup, unsubscribe, getter, creates = 0, closes = 0, events;
  const react = {
    useState(initial) { value ??= initial(); return [value]; },
    useSyncExternalStore(subscribe, getSnapshot) {
      getter = getSnapshot;
      unsubscribe ??= subscribe(() => {});
      return getSnapshot();
    },
    useEffect(callback) { effect = callback; },
  };
  const createDependencies = () => {
    creates++;
    return {
      formatDiscussionMessage,
      selection: {
        getBankInfo: () => ({ storedProblemCount: 0, questionImportWarning: '' }),
        prepare: () => ({ initialStatus: 'selecting', logContext: { source: 'agent', saveSearchedProblems: false, storedProblemCount: 0 },
          getProblem: async () => ({ problem: sampleProblem, problemStorageStatus: 'session', storedProblemCount: 0 }) }),
      },
      judgment: createJudgmentWorkflow({ thinking: testRuntime({}, { google: () => ({}) }) }),
      createAudio: () => ({ resume: async () => {}, play() {}, stopPlayback() {}, startMicrophone: async () => true, stopMicrophone: () => false, close() { closes++; } }),
      createTransport: (_config, _problem, callbacks) => { events = callbacks; return { sendText: () => true, sendAudio() {}, endAudio() {}, close() {} }; },
    };
  };
  const hook = load('src/features/interview/hooks/useSessionController.ts', {}, { react }).default;
  const render = () => hook(createDependencies);
  let controller = render(); cleanup = effect();
  await controller.connect(config); events.ready();
  assert.equal(getter().status, 'connected');
  unsubscribe(); unsubscribe = null; cleanup();
  assert.equal(getter().status, 'disconnected');
  assert.equal(closes, 1);
  controller = render(); cleanup = effect();
  await controller.connect(config); events.ready();
  assert.equal(getter().status, 'connected');
  assert.equal(creates, 1);
  render().quit();
  assert.equal(getter().status, 'disconnected');
  assert.equal(getter().problem, null);
  unsubscribe(); cleanup();
  assert.equal(closes, 2);
});

test('native interview fallback reports availability without accessing browser APIs', async () => {
  const states = []; let cursor = 0;
  const react = { useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], next => { states[index] = next; }];
  } };
  const hook = load('src/features/interview/hooks/useInterviewSession.ts', {}, { react }).default;
  const render = () => { cursor = 0; return hook(); };
  render().setDiscussion('  Native notes\n😀');
  await render().connect(config);
  assert.match(render().error, /web app/);
  assert.equal(render().discussion, '  Native notes\n😀');
  assert.equal(render().status, 'disconnected');
  assert.equal(render().problemStorageStatus, 'session');
  assert.equal(render().send('hello'), false);
  assert.equal(render().send(render().discussion, { kind: 'discussion' }), false);
  assert.equal(render().discussion, '  Native notes\n😀');
  render().quit();
  assert.equal(render().discussion, '');
  assert.equal(render().error, '');
});
