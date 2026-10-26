const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, flush, deferred, sampleProblem, config, harness, assessment, fakeClock, messages, judgeWithProvider } = require('./helpers/fixtures.cjs');

const thinking = { ...config.thinking };
const submission = () => ({ code: '  function solve(nums) { return nums; }\n', language: 'JavaScript' });
async function connect(h) {
  await h.session.connect(config);
  const live = h.liveSessions.at(-1);
  await live.receive({ setupComplete: {} });
  return live;
}
function clockGlobals(clock) {
  return { ...clock.globals, Date: class extends Date { static now() { return clock.now; } } };
}

test('End captures exact code and transcript, closes Live immediately, and judges inputs independently once', async () => {
  const pending = deferred();
  const h = harness({ judge: async (_config, request) => request.kind === 'code' ? pending.promise : assessment('interview') });
  const live = await connect(h);
  h.session.send('Use a hash map.');
  h.session.setDiscussion('  Mindset: reason about edge cases\n😀');
  await live.receive({ serverContent: { outputTranscription: { text: 'What is the complexity?' } } });
  const code = submission();
  const task = h.session.endInterview(code, thinking);
  assert.equal(h.snapshot.status, 'judging');
  assert.equal(live.closed, true);
  assert.equal(h.contexts[0].closed, true);
  assert.equal(h.snapshot.canRetry, false);
  const captured = plain(h.snapshot.judgment.submission);
  code.code = 'changed after submission';
  h.session.setDiscussion('Changed after submission');
  await live.receive({ serverContent: { inputTranscription: { text: 'late transcript' } } });
  await h.session.endInterview(code, thinking);
  await h.session.connect(config);
  assert.equal(h.liveSessions.length, 1);
  assert.equal(h.judgments.length, 1);
  assert.equal(h.judgments[0][1].code, submission().code);
  assert.equal(h.judgments[0][1].language, 'JavaScript');
  assert.equal('messages' in h.judgments[0][1], false);
  assert.equal('discussion' in h.judgments[0][1], false);
  assert.throws(() => { h.snapshot.judgment.submission.problem.examples.push({}); }, /extensible|read only|frozen/);
  pending.resolve(assessment('code'));
  await task;
  assert.deepEqual(h.judgments.map(args => args[1].kind), ['code', 'interview']);
  assert.equal('code' in h.judgments[1][1], false);
  assert.equal('language' in h.judgments[1][1], false);
  assert.deepEqual(plain(h.judgments[1][1].messages), captured.messages);
  assert.equal(h.judgments[1][1].discussion, '  Mindset: reason about edge cases\n😀');
  assert.equal(h.snapshot.judgment.status, 'completed');
  assert.equal(h.snapshot.status, 'disconnected');
  assert.deepEqual(plain(h.snapshot.judgment.submission), captured);
  assert.equal(h.selections.length, 1);
});

test('a failed code judgment still judges the interview; retry keeps successful feedback and the original submission', async () => {
  let failCode = true;
  const h = harness({ judge: async (_config, request) => {
    if (request.kind === 'code' && failCode) throw new Error('Failed using thinking-key and live-key');
    return assessment(request.kind);
  } });
  await connect(h);
  await h.session.endInterview(submission(), thinking);
  assert.equal(h.snapshot.judgment.status, 'failed');
  assert.match(h.snapshot.judgment.errors.code, /redacted/);
  assert.doesNotMatch(h.snapshot.judgment.errors.code, /thinking-key|live-key/);
  const interview = h.snapshot.judgment.interview;
  failCode = false;
  await h.session.retryJudgment({ ...thinking, apiKey: 'corrected-key' });
  assert.deepEqual(h.judgments.map(args => args[1].kind), ['code', 'interview', 'code']);
  assert.equal(h.judgments[2][0].apiKey, 'corrected-key');
  assert.equal(h.judgments[2][1].code, submission().code);
  assert.equal(h.snapshot.judgment.interview, interview);
  assert.equal(h.snapshot.judgment.errors.code, undefined);
  assert.equal(h.snapshot.judgment.status, 'completed');
  await h.session.retryJudgment(thinking);
  assert.equal(h.judgments.length, 3);
});

test('empty code and transcript still receive both judgments and invalid assessments remain retryable', async () => {
  const h = harness({ judge: async (_config, request) => request.kind === 'code' ? { summary: 'not a valid report', score: 100 } : assessment('interview') });
  await connect(h);
  await h.session.endInterview({ code: '', language: 'Plain text' }, thinking);
  assert.equal(h.judgments[0][1].code, '');
  assert.equal(h.judgments[1][1].messages.length, 0);
  assert.equal(h.snapshot.judgment.code, null);
  assert.match(h.snapshot.judgment.errors.code, /invalid assessment/);
  assert.equal(h.snapshot.judgment.interview.summary, 'interview feedback');
});

test('timeout aborts a hung code judgment and proceeds to the interview; late results are ignored', async () => {
  const clock = fakeClock(), pending = deferred();
  const h = harness({ clocks: clockGlobals(clock), judge: async (_config, request) => request.kind === 'code' ? pending.promise : assessment('interview') });
  await connect(h);
  const task = h.session.endInterview(submission(), thinking);
  await flush();
  clock.advance(300000);
  await task;
  assert.equal(h.judgments[0][2].aborted, true);
  assert.match(h.snapshot.judgment.errors.code, /timed out/);
  assert.equal(h.snapshot.judgment.interview.summary, 'interview feedback');
  pending.resolve(assessment('code')); await flush();
  assert.equal(h.snapshot.judgment.code, null);
  assert.equal(clock.pendingCount, 0);
});

test('disconnect aborts grading, and late failure cannot alter a newly started interview', async () => {
  const pending = deferred();
  const h = harness({ judge: () => pending.promise });
  await connect(h);
  const task = h.session.endInterview(submission(), thinking);
  await flush();
  h.session.disconnect();
  assert.equal(h.judgments[0][2].aborted, true);
  await connect(h);
  pending.reject(new Error('late failure')); await task;
  assert.equal(h.snapshot.status, 'connected');
  assert.equal(h.snapshot.error, '');
  assert.equal(h.snapshot.judgment.status, 'idle');
  h.session.disconnect();
});

test('quit clears partial grading and prevents its late results from restoring a submission', async () => {
  const pending = deferred();
  const h = harness({ judge: async (_config, request) => request.kind === 'interview' ? pending.promise : assessment('code') });
  await connect(h);
  const task = h.session.endInterview(submission(), thinking);
  await flush();
  assert.equal(h.snapshot.judgment.code.summary, 'code feedback');
  assert.equal(h.snapshot.judgment.phase, 'interview');
  h.session.quit();
  assert.equal(h.judgments[1][2].aborted, true);
  assert.equal(h.snapshot.problem, null); assert.equal(h.snapshot.judgment.status, 'idle');
  assert.equal(h.snapshot.judgment.submission, null); assert.equal(h.snapshot.judgment.code, null);
  pending.resolve(assessment('interview')); await task;
  assert.equal(h.snapshot.status, 'disconnected'); assert.equal(h.snapshot.judgment.interview, null);
  assert.equal(h.snapshot.judgment.submission, null);
  await h.session.retryJudgment(thinking);
  assert.equal(h.judgments.length, 2);
});

test('judging logs only progress and sizes, not code, transcript, reports, or credentials', async () => {
  const records = [];
  const { createLogger } = load('src/shared/logger.ts');
  const h = harness({ logger: createLogger({ enabled: true, sink: record => records.push(record) }),
    judge: async (_config, request) => {
      if (request.kind === 'code') throw new Error('private code sentinel private transcript sentinel thinking-key');
      return assessment(request.kind);
    } });
  await connect(h);
  h.session.send('private transcript sentinel');
  h.session.setDiscussion('private discussion sentinel');
  await h.session.endInterview({ code: 'private code sentinel', language: 'Python' }, thinking);
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /private transcript sentinel|private discussion sentinel|private code sentinel|thinking-key|code feedback/);
  assert.match(serialized, /judgment.completed/);
});

test('assessment validation rejects missing, duplicate, or scored perspectives and orders valid feedback', () => {
  const { validateAssessment } = load('src/features/interview/judgment/model.ts');
  const { judgmentPrompt } = load('src/features/interview/agents/judgment/prompts.ts');
  for (const kind of ['code', 'interview']) {
    const report = assessment(kind);
    report.perspectives.reverse();
    assert.deepEqual(plain(validateAssessment(kind, report)), assessment(kind));
    assert.throws(() => validateAssessment(kind, { ...report, score: 10 }), /invalid assessment/);
    assert.throws(() => validateAssessment(kind, { ...report, perspectives: report.perspectives.slice(1) }), /invalid assessment/);
    report.perspectives[0] = report.perspectives[1];
    assert.throws(() => validateAssessment(kind, report), /invalid assessment/);
  }
  const prompt = judgmentPrompt({ kind: 'interview', problem: sampleProblem, messages: [] });
  assert.match(prompt, /candidate's user-role transcript messages and written discussion/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /not private reasoning/);
});

test('Gemini judgment agents use one model, independent inputs, and native structured feedback', async () => {
  const { ScriptedChatModel } = require('./helpers/fixtures.cjs');
  const clients = [], calls = [], controller = new AbortController();
  class ChatGoogle extends ScriptedChatModel {
    constructor(options) {
      super([(...args) => {
        const input = JSON.parse(args[0][1].text);
        return new messages.AIMessage(JSON.stringify(assessment(input.kind)));
      }, (...args) => {
        const input = JSON.parse(args[0][1].text);
        return new messages.AIMessage(JSON.stringify(assessment(input.kind)));
      }], calls, { structuredOutput: true });
      clients.push(plain(options));
    }
  }
  const judge = judgeWithProvider({}, { '@langchain/google': { ChatGoogle } });
  const code = { kind: 'code', problem: sampleProblem, ...submission() };
  const interview = { kind: 'interview', problem: sampleProblem, messages: [{ id: 1, role: 'user', text: 'Hash map.' }] };
  await judge(thinking, code, controller.signal);
  await judge(thinking, interview, controller.signal);
  assert.deepEqual(clients, [{ apiKey: 'thinking-key', model: 'gemini-3.8-flash', maxRetries: 0 }]);
  assert.deepEqual(calls.map(call => JSON.parse(call.history[1].text)), [code, interview]);
  assert.equal(calls[0].history.length, 2);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(calls[0].options.response_format.type, 'json_schema');
});

test('Antigravity judgment polls and submits a validated assessment without canceling its paused interaction', async () => {
  const clock = fakeClock(true), creates = [], cancels = [], gets = [];
  class GoogleGenAI {
    constructor(options) {
      assert.equal(options.apiKey, 'thinking-key');
      this.interactions = {
        create: async (params, options) => { creates.push({ params: plain(params), options }); return { id: 'judge', status: 'queued', steps: [] }; },
        get: async id => { gets.push(id); return { id, status: 'requires_action', steps: [{ type: 'function_call', id: 'submit', name: 'submit_assessment', arguments: assessment('code') }] }; },
        cancel: async id => { cancels.push(id); },
      };
    }
  }
  const judge = judgeWithProvider(clock.globals, { '@google/genai/web': { GoogleGenAI } });
  const controller = new AbortController();
  const result = await judge({ ...thinking, model: 'antigravity-preview-09-2026' }, { kind: 'code', problem: sampleProblem, ...submission() }, controller.signal);
  assert.deepEqual(plain(result), assessment('code'));
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].params.tools.map(tool => tool.name), ['submit_assessment']);
  assert.equal(creates[0].options.fetchOptions.signal, controller.signal);
  assert.deepEqual(gets, ['judge']);
  assert.deepEqual(cancels, []);
  assert.equal(clock.pendingCount, 0);
});

test('Antigravity skips cancellation for paused responses and rejects late or malformed feedback', async () => {
  for (const late of [false, true]) {
    const pending = deferred(), cancels = [], controller = new AbortController();
    class GoogleGenAI {
      constructor() { this.interactions = {
        create: () => pending.promise,
        cancel: async id => { cancels.push(id); },
      }; }
    }
    const judge = judgeWithProvider({}, { '@google/genai/web': { GoogleGenAI } });
    const task = judge({ ...thinking, model: 'antigravity-preview-09-2026' }, { kind: 'interview', problem: sampleProblem, messages: [] }, controller.signal);
    await flush();
    if (late) controller.abort();
    pending.resolve({ id: 'late', status: 'requires_action', steps: [{ type: 'function_call', id: 'bad', name: 'submit_assessment', arguments: { summary: 'Incomplete' } }] });
    await assert.rejects(task, late ? /abort/i : /invalid assessment/);
    await flush();
    assert.deepEqual(cancels, []);
  }
});
