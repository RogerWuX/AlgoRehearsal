const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { thinkingModel } = require('./helpers/fixtures.cjs');
const { judgeSubmission } = load('src/features/interview/agents/judgment/judgeSubmission.ts');
const { stampRetryable } = require('@langchain/core/errors');
const { config, flush, plain, selector, testRuntime, scriptedProvider, submission, sampleProblem, messages, ScriptedChatModel, assessment, fakeClock, harness } = require('./helpers/fixtures.cjs');

const transient = (status = 503) => Object.assign(new Error('Transient provider failure'), { status });
function controlTime(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Math, 'random', () => 0.5);
}

test('LangChain retries transient model calls after one and two seconds', async t => {
  controlTime(t);
  const provider = scriptedProvider([transient(), transient(429), submission()]);
  const task = selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal);
  await flush(); assert.equal(provider.calls.length, 1);
  t.mock.timers.tick(999); await flush(); assert.equal(provider.calls.length, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(provider.calls.length, 2);
  t.mock.timers.tick(1999); await flush(); assert.equal(provider.calls.length, 2);
  t.mock.timers.tick(1);
  assert.equal((await task).title, sampleProblem.title);
  assert.equal(provider.calls.length, 3);
});

test('retry exhaustion propagates the final failure after three total attempts', async t => {
  controlTime(t);
  const provider = scriptedProvider([transient(), transient(), transient()]);
  const rejected = assert.rejects(selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal), /Transient provider failure/);
  await flush(); t.mock.timers.tick(1000); await flush(); t.mock.timers.tick(2000);
  await rejected; assert.equal(provider.calls.length, 3);
});

test('retry waits respect a provider Retry-After hint', async t => {
  controlTime(t);
  const provider = scriptedProvider([Object.assign(transient(429), { retryAfterMs: 5000 }), submission()]);
  const task = selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal);
  await flush(); t.mock.timers.tick(4999); await flush(); assert.equal(provider.calls.length, 1);
  t.mock.timers.tick(1); await task; assert.equal(provider.calls.length, 2);
});

test('authentication, validation, cancellation and explicitly permanent errors are not retried', async () => {
  for (const error of [
    transient(401), transient(403), new Error('Invalid configuration'), Object.assign(new Error('Canceled'), { name: 'AbortError' }),
    stampRetryable(transient(), false),
  ]) {
    const provider = scriptedProvider([error, submission()]);
    await assert.rejects(selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal));
    assert.equal(provider.calls.length, 1);
  }
});

test('canceling during backoff rejects promptly and prevents all later attempts', async t => {
  controlTime(t);
  const controller = new AbortController(), provider = scriptedProvider([transient(), submission()]);
  const rejected = assert.rejects(selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', controller.signal), /abort/i);
  await flush(); controller.abort(); await rejected;
  t.mock.timers.tick(10000); await flush();
  assert.equal(provider.calls.length, 1);
});

test('Google grounded search uses the same retry middleware without replaying the selection turn', async t => {
  controlTime(t);
  const calls = [];
  const { reply, toolCall } = require('./helpers/fixtures.cjs');
  class ChatGoogle extends ScriptedChatModel {
    constructor() { super([
      reply(toolCall('search', 'search_problem', { query: 'Find problem' })),
      transient(),
      new messages.AIMessage('Verified problem'), submission(),
    ], calls); }
  }
  const model = load('src/features/interview/adapters/thinkingModels.ts', {}, { '@langchain/google': { ChatGoogle } }).createThinkingRuntime().getModel(config.thinking);
  const task = selector()(model, 'Rules', new AbortController().signal);
  await flush(); assert.equal(calls.length, 2);
  t.mock.timers.tick(1000); await task;
  assert.equal(calls.length, 4);
  assert.deepEqual(plain(calls.slice(1, 3).map(call => call.tools)), [[{ googleSearch: {} }], [{ googleSearch: {} }]]);
});

test('judgment model failures retry within the same independent assessment task', async t => {
  controlTime(t);
  const calls = [];
  const model = thinkingModel(
    new ScriptedChatModel([transient(), new messages.AIMessage(JSON.stringify(assessment('code')))], calls, { structuredOutput: true }),
    () => assert.fail('Judgment must not search'),
  );
  const task = judgeSubmission(model, { kind: 'code', problem: sampleProblem, code: '', language: 'Python' }, new AbortController().signal);
  await flush(); t.mock.timers.tick(1000);
  assert.equal((await task).summary, 'code feedback');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].history[1].text, calls[1].history[1].text);
});

test('selection workflow deadline includes backoff and prevents a late retry', async t => {
  controlTime(t);
  const clock = fakeClock(), provider = scriptedProvider([Object.assign(transient(429), { retryAfterMs: 400000 }), submission()]);
  const select = selector();
  const h = harness({ clocks: clock.globals, adapterFactory: provider.factory,
    select: (agents, instructions, signal, logger) => select(agents, instructions, signal, logger) });
  const task = h.session.connect(config);
  await flush(); assert.equal(provider.calls.length, 1);
  clock.advance(300000); await task;
  assert.match(h.snapshot.error, /timed out/);
  t.mock.timers.tick(400000); await flush();
  assert.equal(provider.calls.length, 1);
  assert.equal(h.liveSessions.length, 0);
});
