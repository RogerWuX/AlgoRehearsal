const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, sampleProblem, assessment, deferred, flush, fakeClock } = require('./helpers/fixtures.cjs');
const { captureSubmission, emptyJudgment, restoreJudgment } = load('src/features/interview/judgment/state.ts');
const { createJudgmentWorkflow, JUDGMENT_TIMEOUT_MS } = load('src/features/interview/judgment/createJudgmentWorkflow.ts');

function workflowHarness({ judge = async (_model, request) => assessment(request.kind), getModel, logger } = {}) {
  const clock = fakeClock(), calls = [], models = [], updates = [];
  const initial = { ...emptyJudgment(), submission: captureSubmission(sampleProblem,
    [{ id: 1, role: 'user', text: 'Use a map.' }], { code: '  return nums;\n', language: 'JavaScript' }, '  Written approach\n😀') };
  let state = initial;
  const context = { logger, secrets: ['live-key', 'previous-thinking-key'],
    onChange: next => { state = next; updates.push(next); } };
  const workflow = createJudgmentWorkflow({
    thinking: { getModel: configuration => {
      models.push(plain(configuration));
      return getModel ? getModel(configuration) : { configuration };
    } },
    judge: (...args) => { calls.push(args); return judge(...args); },
    clock: clock.globals,
  });
  return { workflow, clock, calls, models, updates, initial, context, get state() { return state; },
    run: (configuration = config.thinking) => workflow.run(state, configuration, context) };
}

test('submission capture copies exact inputs and freezes the problem, discussion, and code snapshot', () => {
  const problem = plain(sampleProblem), messages = [{ id: 1, role: 'user', text: 'My approach' }];
  const code = { code: '  solution\n', language: 'Python' };
  const submission = captureSubmission(problem, messages, code, '  My mindset\r\n😀');
  problem.examples[0].input = 'changed';
  problem.constraints.push('changed');
  messages[0].text = 'changed';
  code.code = 'changed';
  assert.deepEqual(plain(submission.problem), sampleProblem);
  assert.deepEqual(plain(submission.messages), [{ id: 1, role: 'user', text: 'My approach' }]);
  assert.equal(submission.code, '  solution\n');
  assert.equal(submission.language, 'Python');
  assert.equal(submission.discussion, '  My mindset\r\n😀');
  assert.ok(Number.isFinite(Date.parse(submission.submittedAt)));
  assert.ok(Object.isFrozen(submission));
  assert.ok(Object.isFrozen(submission.messages[0]));
  assert.throws(() => submission.problem.examples.push({}), /extensible|read only|frozen/);
});

test('workflow grades sequentially with independent inputs, blocks duplicate runs, and publishes immutable updates', async () => {
  const pending = deferred();
  const h = workflowHarness({ judge: async (_model, request) => request.kind === 'code' ? pending.promise : assessment('interview') });
  const task = h.run();
  assert.equal(h.workflow.isRunning(), true);
  await flush();
  await h.run();
  assert.equal(h.models.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.state.phase, 'code');
  assert.deepEqual(plain(h.calls[0][1]), { kind: 'code', problem: sampleProblem, code: '  return nums;\n', language: 'JavaScript' });
  pending.resolve(assessment('code'));
  await task;
  assert.deepEqual(h.calls.map(args => args[1].kind), ['code', 'interview']);
  assert.deepEqual(plain(h.calls[1][1]), { kind: 'interview', problem: sampleProblem, messages: plain(h.initial.submission.messages), discussion: '  Written approach\n😀' });
  assert.equal(h.state.status, 'completed');
  assert.equal(h.state.phase, null);
  assert.equal(h.state.submission, h.initial.submission);
  assert.equal(h.initial.status, 'idle');
  assert.equal(h.initial.code, null);
  assert.equal(h.workflow.isRunning(), false);
  assert.equal(h.clock.pendingCount, 0);
  for (const update of h.updates) {
    assert.ok(Object.isFrozen(update));
    assert.ok(Object.isFrozen(update.errors));
  }
  assert.throws(() => h.state.code.strengths.push('changed'), /extensible|read only|frozen/);
  await h.run();
  await h.workflow.run(emptyJudgment(), config.thinking, h.context);
  assert.equal(h.models.length, 1);
});

test('failed grading redacts current and inherited credentials, logs no private payloads, and retries only missing feedback', async () => {
  const records = [];
  const { createLogger } = load('src/shared/logger.ts');
  let failCode = true;
  const h = workflowHarness({ logger: createLogger({ enabled: true, sink: record => records.push(record) }),
    judge: async (_model, request) => {
      if (request.kind === 'code' && failCode) throw new Error('private code sentinel private transcript sentinel thinking-key live-key previous-thinking-key');
      return assessment(request.kind);
    } });
  await h.run();
  assert.equal(h.state.status, 'failed');
  assert.doesNotMatch(h.state.errors.code, /thinking-key|live-key/);
  assert.match(h.state.errors.code, /redacted/);
  const successful = h.state.interview;
  failCode = false;
  await h.run({ ...config.thinking, apiKey: 'corrected-key' });
  assert.deepEqual(h.calls.map(args => args[1].kind), ['code', 'interview', 'code']);
  assert.equal(h.models[1].apiKey, 'corrected-key');
  assert.equal(h.state.interview, successful);
  assert.equal(h.state.errors.code, undefined);
  assert.equal(h.state.status, 'completed');
  assert.doesNotMatch(JSON.stringify(records), /private code sentinel|private transcript sentinel|thinking-key|live-key|corrected-key|feedback/);
  assert.deepEqual(records.map(record => record.event), ['judgment.started', 'judgment.failed', 'judgment.started', 'judgment.completed', 'judgment.started', 'judgment.completed']);
});

test('invalid assessments are retryable while successful feedback and the captured submission survive', async () => {
  let invalid = true;
  const h = workflowHarness({ judge: async (_model, request) => request.kind === 'code' && invalid
    ? { summary: 'private malformed output', score: 100 } : assessment(request.kind) });
  await h.run();
  assert.equal(h.state.code, null);
  assert.match(h.state.errors.code, /invalid assessment/);
  assert.doesNotMatch(h.state.errors.code, /private malformed output/);
  const successful = h.state.interview;
  invalid = false;
  await h.run();
  assert.equal(h.state.interview, successful);
  assert.equal(h.state.submission, h.initial.submission);
  assert.equal(h.state.status, 'completed');
});

test('model configuration failures affect only unfinished feedback and leave the workflow retryable', async () => {
  let invalid = true;
  const h = workflowHarness({ getModel: () => {
    if (invalid) throw new Error('Invalid thinking-key live-key previous-thinking-key');
    return {};
  } });
  const previous = { ...h.initial, status: 'failed', code: assessment('code'), errors: { interview: 'old error' } };
  await h.workflow.run(previous, config.thinking, h.context);
  assert.equal(h.state.status, 'failed');
  assert.equal(h.state.code, previous.code);
  assert.equal(h.state.errors.code, undefined);
  assert.doesNotMatch(h.state.errors.interview, /thinking-key|live-key/);
  assert.match(h.state.errors.interview, /redacted/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.clock.pendingCount, 0);
  assert.equal(h.workflow.isRunning(), false);
  invalid = false;
  await h.run();
  assert.deepEqual(h.calls.map(args => args[1].kind), ['interview']);
  assert.equal(h.state.status, 'completed');
});

test('each grading phase times out despite an uncooperative provider and ignores its late result', async () => {
  for (const kind of ['code', 'interview']) {
    const pending = deferred();
    const h = workflowHarness({ judge: async (_model, request) => request.kind === kind ? pending.promise : assessment(request.kind) });
    const task = h.run();
    await flush();
    assert.equal(h.state.phase, kind);
    h.clock.advance(JUDGMENT_TIMEOUT_MS);
    await task;
    assert.equal(h.calls.find(args => args[1].kind === kind)[2].aborted, true);
    assert.match(h.state.errors[kind], /timed out/);
    assert.equal(h.state[kind], null);
    assert.ok(h.state[kind === 'code' ? 'interview' : 'code']);
    assert.equal(h.state.status, 'failed');
    assert.equal(h.workflow.isRunning(), false);
    assert.equal(h.clock.pendingCount, 0);
    const updateCount = h.updates.length;
    pending.resolve(assessment(kind));
    await flush();
    assert.equal(h.updates.length, updateCount);
    assert.equal(h.state[kind], null);
  }
});

test('cancellation settles a hung run, preserves completed feedback, and cannot alter its replacement', async () => {
  for (const outcome of ['success', 'failure']) {
    const pending = deferred();
    let interviews = 0;
    const h = workflowHarness({ judge: async (_model, request) => request.kind === 'interview' && interviews++ === 0
      ? pending.promise : assessment(request.kind) });
    const canceled = h.run();
    await flush();
    const successful = h.state.code;
    h.workflow.cancel();
    assert.equal(h.state.status, 'canceled');
    assert.equal(h.state.phase, null);
    assert.equal(h.state.code, successful);
    assert.equal(h.state.errors.code, undefined);
    assert.match(h.state.errors.interview, /canceled/);
    assert.equal(h.calls[1][2].aborted, true);
    assert.equal(h.workflow.isRunning(), false);
    assert.equal(h.clock.pendingCount, 0);
    const replacement = h.run();
    await canceled;
    await replacement;
    assert.deepEqual(h.calls.map(args => args[1].kind), ['code', 'interview', 'interview']);
    assert.equal(h.state.code, successful);
    assert.equal(h.state.status, 'completed');
    const updateCount = h.updates.length;
    if (outcome === 'success') pending.resolve(assessment('interview'));
    else pending.reject(new Error('late provider failure'));
    await flush();
    h.workflow.cancel();
    assert.equal(h.updates.length, updateCount);
    assert.equal(h.clock.pendingCount, 0);
  }
});

test('cancellation from a phase notification stops the provider call and releases its timer', async () => {
  const h = workflowHarness();
  const context = { ...h.context, onChange: state => {
    h.context.onChange(state);
    if (state.status === 'running' && state.phase === 'code') h.workflow.cancel();
  } };
  await h.workflow.run(h.initial, config.thinking, context);
  assert.equal(h.state.status, 'canceled');
  assert.equal(h.workflow.isRunning(), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.clock.pendingCount, 0);
  await h.run();
  assert.equal(h.state.status, 'completed');
});

test('restored interrupted grading keeps successful feedback and marks only missing feedback interrupted', () => {
  const running = { ...emptyJudgment(), status: 'running', phase: 'interview',
    submission: captureSubmission(sampleProblem, [], { code: '', language: 'Plain text' }, ''), code: assessment('code') };
  const restored = restoreJudgment(running);
  assert.equal(restored.status, 'canceled');
  assert.equal(restored.phase, null);
  assert.equal(restored.code, running.code);
  assert.equal(restored.submission, running.submission);
  assert.equal(restored.errors.code, undefined);
  assert.match(restored.errors.interview, /interrupted/);
  assert.equal(running.status, 'running');
  assert.ok(Object.isFrozen(restored.errors));
  const completed = { ...restored, status: 'completed', interview: assessment('interview'), errors: {} };
  assert.equal(restoreJudgment(completed), completed);
  assert.equal(completed.status, 'completed');
  assert.ok(Object.isFrozen(completed.interview));
});
