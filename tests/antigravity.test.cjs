const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, flush, deferred, sampleProblem, config, messages, fakeClock } = require('./helpers/fixtures.cjs');

const agent = 'antigravity-preview-09-2026';
const call = (id, name, args) => ({ type: 'function_call', id, name, arguments: args });
const interaction = (id, steps = [], status = 'requires_action') => ({ id, status, environment_id: 'environment-1', steps });
const submission = () => interaction('submitted', [call('submit', 'submit_problem', sampleProblem)]);

function managedHarness(responses, { polls = [], clock = fakeClock(true), logger, cancelError } = {}) {
  const clients = [], creates = [], gets = [], cancels = [];
  class GoogleGenAI {
    constructor(options) {
      clients.push(plain(options));
      this.interactions = {
        create: async (parameters, options) => {
          creates.push({ parameters: plain(parameters), options, at: clock.now });
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return typeof next === 'function' ? next(parameters, options) : next;
        },
        get: async (id, parameters, options) => {
          gets.push({ id, parameters, options, at: clock.now });
          const next = polls.shift();
          if (next instanceof Error) throw next;
          return typeof next === 'function' ? next() : next;
        },
        cancel: async (id, parameters, options) => { cancels.push({ id, parameters, options }); if (cancelError) throw cancelError; return interaction(id, [], 'cancelled'); },
      };
    }
  }
  const dependencies = {
    '@google/genai/web': { GoogleGenAI },
    '@langchain/google': { ChatGoogle: class { constructor() { throw new Error('Antigravity must not construct ChatGoogle'); } } },
    '@langchain/core/messages': messages,
  };
  const runtime = load('src/features/interview/adapters/thinkingModels.ts', clock.globals, dependencies).createThinkingRuntime();
  const select = load('src/features/interview/agents/selection/selectProblem.ts', clock.globals, dependencies).selectProblem;
  const controller = new AbortController();
  return {
    clients, creates, gets, cancels, controller, clock,
    model: () => runtime.getModel({ ...config.thinking, model: agent }),
    judge: (request, signal = controller.signal) => load('src/features/interview/agents/judgment/judgeSubmission.ts', clock.globals, dependencies)
      .judgeSubmission(runtime.getModel({ ...config.thinking, model: agent }), request, signal, logger),
    select: description => select(runtime.getModel({ ...config.thinking, apiKey: ' thinking-key ', model: ` ${agent} ` }), 'Custom difficulty rules. Use search_problem.', controller.signal, logger, description),
  };
}

test('Antigravity uses the thinking credential and managed search with validated submission tools', async () => {
  const h = managedHarness([submission()]);
  assert.deepEqual(plain(await h.select()), sampleProblem);
  assert.deepEqual(h.clients, [{ apiKey: 'thinking-key', httpOptions: { apiVersion: 'v1beta' } }]);
  const request = h.creates[0];
  assert.equal(request.parameters.agent, agent);
  assert.equal(request.parameters.model, undefined);
  assert.equal(request.parameters.environment, 'remote');
  assert.equal(request.parameters.background, true); assert.equal(request.parameters.store, true);
  assert.match(request.parameters.system_instruction, /Custom difficulty rules/);
  assert.match(request.parameters.system_instruction, /references to search_problem mean use the built-in google_search/);
  assert.deepEqual(request.parameters.tools.map(tool => tool.name ?? tool.type), ['gen_random_number', 'submit_problem', 'google_search', 'url_context']);
  assert.deepEqual(request.parameters.tools[1].parameters.required, ['title', 'sourceUrl', 'description', 'examples', 'constraints']);
  assert.equal(request.options.fetchOptions.signal, h.controller.signal); assert.equal(request.options.maxRetries, 0);
  assert.equal(h.creates.length, 1); assert.equal(h.cancels.length, 0);
});

test('Antigravity receives problem preferences as managed-search input and preserves the default input when blank', async () => {
  for (const description of [undefined, ' \n\t ', '  Medium graphs\n最短路徑 {{literal}} ${value} $&  ']) {
    const h = managedHarness([submission()]);
    assert.deepEqual(plain(await h.select(description)), sampleProblem);
    const normalized = (description ?? '').trim();
    assert.equal(h.creates[0].parameters.input, normalized
      ? `Start problem selection.\n\nUser problem preferences:\n${normalized}` : 'Start problem selection.');
    assert.doesNotMatch(h.creates[0].parameters.system_instruction, /User problem preferences|最短路徑/);
  }
});

test('Antigravity traces full polling responses, observed managed search, tools and acceptance with shared context', async () => {
  const records = [];
  const { createLogger } = load('src/shared/logger.ts');
  const logger = createLogger({ enabled: true, context: { sessionId: 4, attemptId: 9 }, sink: record => records.push(record) });
  const search = { type: 'google_search_call', id: 'search-1', arguments: { queries: ['pair sum'] } };
  const searchResult = { type: 'google_search_result', call_id: 'search-1', result: [{ search_suggestions: 'Full search result' }] };
  const poll = { ...interaction('background', [search, searchResult, call('random', 'gen_random_number', { min: 1, max: 1 })]),
    usage: { total_tokens: 8 }, customMetadata: { description: 'Keep all returned fields' } };
  const h = managedHarness([interaction('background', [], 'queued'), submission()], { polls: [poll], logger });
  await h.select();
  const responses = records.filter(record => record.event === 'interaction.response');
  assert.equal(responses.length, 3);
  assert.equal(responses[1].data.interaction.usage.total_tokens, 8);
  assert.equal(responses[1].data.interaction.customMetadata.description, 'Keep all returned fields');
  assert.equal(responses[1].data.interaction.steps[1].result[0].search_suggestions, 'Full search result');
  assert.ok(records.some(record => record.event === 'interaction.continue'));
  const accepted = records.find(record => record.event === 'problem.accepted');
  assert.equal(accepted.data.searchObserved, true);
  assert.equal(accepted.context.attemptId, 9);
  assert.equal(accepted.context.sessionId, 4);
  const originalEvents = ['selection.started', 'selection.instructions', 'interaction.create', 'interaction.response',
    'interaction.poll-wait', 'managed-search.observed', 'interaction.status-decision', 'tool.requested', 'tool.result',
    'interaction.continue', 'problem.accepted', 'interaction.cancel-requested'];
  assert.deepEqual(records.map(record => record.event).filter(event => originalEvents.includes(event)), [
    'selection.started', 'selection.instructions', 'interaction.create', 'interaction.response', 'interaction.poll-wait',
    'interaction.response', 'managed-search.observed', 'interaction.status-decision', 'tool.requested', 'tool.result',
    'interaction.continue', 'interaction.response', 'interaction.status-decision', 'tool.requested', 'tool.result',
    'problem.accepted',
  ]);
});

test('Antigravity distinguishes URL retrieval from search and does not infer unreturned search activity', async () => {
  for (const steps of [[], [{ type: 'url_context_call', id: 'url-1', arguments: { urls: [sampleProblem.sourceUrl] } }]]) {
    const records = [];
    const { createLogger } = load('src/shared/logger.ts');
    const logger = createLogger({ enabled: true, sink: record => records.push(record) });
    const h = managedHarness([interaction('submitted', [...steps, call('submit', 'submit_problem', sampleProblem)])], { logger });
    await h.select();
    const accepted = records.find(record => record.event === 'problem.accepted').data;
    assert.equal(accepted.searchObserved, false);
    assert.equal(accepted.urlContextObserved, steps.length > 0);
    assert.equal(accepted.searchVisibility, 'returned-steps-only');
  }
});

test('Antigravity corrects invalid submissions, caches duplicate calls, and continues server-side state', async () => {
  const random = call('random', 'gen_random_number', { min: 4, max: 4 });
  const h = managedHarness([
    interaction('first', [random, call('invalid', 'submit_problem', { ...sampleProblem, sourceUrl: 'javascript:alert(1)' }), call('unknown', 'unknown', {})]),
    interaction('second', [random, call('bad-bounds', 'gen_random_number', { min: 10, max: 1 })]),
    submission(),
  ]);
  assert.deepEqual(plain(await h.select()), sampleProblem);
  const firstResults = h.creates[1].parameters.input;
  assert.deepEqual(JSON.parse(firstResults[0].result), { number: 4 });
  assert.match(JSON.parse(firstResults[1].result).error.message, /HTTP\(S\)/);
  assert.match(JSON.parse(firstResults[2].result).error.message, /Unknown tool/);
  assert.equal(h.creates[1].parameters.previous_interaction_id, 'first');
  assert.equal(h.creates[1].parameters.environment, 'environment-1');
  assert.equal(h.creates[2].parameters.input[0].result, firstResults[0].result);
  assert.ok(JSON.parse(h.creates[2].parameters.input[1].result).error);
  assert.deepEqual(h.creates.map(request => request.at), [0, 0, 0]);
});

test('Antigravity ignores server-executed calls and accepts only the first valid problem', async () => {
  const h = managedHarness([interaction('first', [
    call('filesystem', 'write_to_file', {}), { type: 'function_result', call_id: 'filesystem', result: 'done' },
    call('first-submit', 'submit_problem', sampleProblem),
    call('second-submit', 'submit_problem', { ...sampleProblem, title: 'Other problem' }),
  ])]);
  assert.equal((await h.select()).title, sampleProblem.title);
  assert.equal(h.creates.length, 1);
});

test('Antigravity polls every five seconds and continues without application throttling', async () => {
  const h = managedHarness([interaction('background', [], 'queued'), submission()], {
    polls: [interaction('background', [], 'in_progress'), interaction('background', [call('random', 'gen_random_number', { min: 1, max: 1 })])],
  });
  await h.select();
  assert.deepEqual(h.gets.map(request => request.at), [5000, 10000]);
  assert.equal(h.creates[1].at, 10000);
  assert.equal(h.gets[0].options.fetchOptions.signal, h.controller.signal);
});

test('Antigravity reports API failures, terminal states, and malformed pending calls', async () => {
  for (const [result, pattern] of [
    [new Error('Credential rejected'), /Credential rejected/],
    ...['completed', 'failed', 'incomplete', 'cancelled'].map(status => [interaction('terminal', [], status), new RegExp(status)]),
    [interaction('empty'), /without pending tool calls/],
    [interaction('invalid', [call('', 'submit_problem', sampleProblem)]), /invalid tool call/],
    [{ ...interaction('missing-env', [call('random', 'gen_random_number', { min: 1, max: 1 })]), environment_id: undefined }, /no environment/],
  ]) {
    const h = managedHarness([result]);
    await assert.rejects(h.select(), pattern);
    assert.equal(h.cancels.length, 0);
  }
  const duplicate = call('same', 'gen_random_number', { min: 1, max: 1 });
  const h = managedHarness([interaction('first', [duplicate]), interaction('second', [call('same', 'submit_problem', sampleProblem)])]);
  await assert.rejects(h.select(), /reused a tool call ID/);
});

test('canceling Antigravity polling stops timers and cancels queued or running background interactions once', async () => {
  for (const status of ['queued', 'in_progress']) {
    const h = managedHarness([interaction('background', [], status)], { clock: fakeClock() });
    const task = h.select(); await flush();
    assert.equal(h.clock.pendingCount, 1);
    h.controller.abort();
    await assert.rejects(task, /abort/i);
    assert.equal(h.clock.pendingCount, 0); assert.equal(h.gets.length, 0);
    assert.deepEqual(h.cancels.map(request => request.id), ['background']);
    assert.equal(h.cancels[0].options.fetchOptions, undefined);
  }
});

test('Antigravity does not retry transient inference failures', async () => {
  const h = managedHarness([Object.assign(new Error('Unavailable'), { status: 503 }), submission()], { clock: fakeClock() });
  await assert.rejects(h.select(), /Unavailable/);
  assert.equal(h.creates.length, 1);
  assert.equal(h.clock.pendingCount, 0);
});

test('late Antigravity responses after cancellation are canceled and cannot submit a problem', async () => {
  for (const phase of ['create', 'get']) {
    const pending = deferred();
    const h = managedHarness(phase === 'create' ? [() => pending.promise] : [interaction('background', [], 'in_progress')], {
      polls: [() => pending.promise],
    });
    const task = h.select(); await flush(); h.controller.abort();
    pending.resolve(interaction('late-background', [], 'in_progress'));
    await assert.rejects(task, /abort/i);
    assert.equal(h.creates.length, 1);
    await flush();
    assert.ok(h.cancels.some(request => request.id === 'late-background'));
  }
});


test('cached Antigravity model isolates overlapping selection and judgment continuations', async () => {
  const { assessment } = require('./helpers/fixtures.cjs');
  const selecting = deferred(), judging = deferred();
  const h = managedHarness([
    () => selecting.promise, () => judging.promise,
    parameters => {
      assert.equal(parameters.previous_interaction_id, 'selection-first');
      assert.equal(parameters.environment, 'selection-environment');
      assert.deepEqual(plain(parameters.input.map(result => result.call_id)), ['random']);
      return submission();
    },
  ]);
  const selected = h.select(); await flush();
  const judged = h.judge({ kind: 'code', problem: sampleProblem, code: '', language: 'Python' }); await flush();
  assert.equal(h.clients.length, 1);
  assert.equal(h.model(), h.model());
  const judgmentReport = assessment('code');
  judging.resolve({ ...interaction('judgment-first', [call('assessment', 'submit_assessment', judgmentReport)]), environment_id: 'judgment-environment' });
  assert.deepEqual(plain(await judged), judgmentReport);
  selecting.resolve({ ...interaction('selection-first', [call('random', 'gen_random_number', { min: 1, max: 1 })]), environment_id: 'selection-environment' });
  assert.deepEqual(plain(await selected), sampleProblem);
  assert.equal(h.cancels.length, 0);
});

test('aborting a pending Antigravity create rejects before the SDK returns and cancels the late result once', async () => {
  const pending = deferred(), records = [];
  const logger = load('src/shared/logger.ts').createLogger({ enabled: true, sink: record => records.push(record) });
  const h = managedHarness([() => pending.promise], { logger });
  const task = h.select(); await flush();
  h.controller.abort();
  await assert.rejects(task, /abort/i);
  assert.equal(h.cancels.length, 0);
  pending.resolve(interaction('late-background', [], 'queued')); await flush();
  assert.deepEqual(h.cancels.map(request => request.id), ['late-background']);
  assert.equal(records.filter(record => record.event === 'interaction.stale-response').length, 1);
  assert.equal(records.some(record => record.event === 'problem.accepted'), false);
});

test('Antigravity search observations include intermediate polling steps and count unique IDs', async () => {
  const records = [], search = { type: 'google_search_call', id: 'search-before-action' };
  const logger = load('src/shared/logger.ts').createLogger({ enabled: true, sink: record => records.push(record) });
  const h = managedHarness([interaction('background', [search], 'queued')], {
    logger, polls: [interaction('background', [search], 'in_progress'), submission()],
  });
  await h.select();
  const accepted = records.find(record => record.event === 'problem.accepted').data;
  assert.equal(accepted.searchObserved, true);
  assert.equal(accepted.searchCalls, 1);
  assert.equal(records.filter(record => record.event === 'managed-search.observed').length, 2);
});

test('Antigravity skips cancellation for late responses awaiting tool input', async () => {
  for (const phase of ['create', 'get']) {
    const pending = deferred(), records = [];
    const logger = load('src/shared/logger.ts').createLogger({ enabled: true, sink: record => records.push(record) });
    const h = managedHarness(phase === 'create' ? [() => pending.promise] : [interaction('background', [], 'in_progress')], {
      polls: [() => pending.promise], logger,
    });
    const task = h.select(); await flush(); h.controller.abort();
    await assert.rejects(task, /abort/i);
    pending.resolve(submission()); await flush();
    assert.deepEqual(h.cancels.map(request => request.id), phase === 'create' ? [] : ['background']);
    assert.equal(records.filter(record => record.event === 'interaction.stale-response').length, 1);
    assert.equal(records.some(record => record.event === 'problem.accepted'), false);
  }
});

test('Antigravity cleanup failures are logged once and preserve the original polling error', async () => {
  const records = [];
  const logger = load('src/shared/logger.ts').createLogger({ enabled: true, sink: record => records.push(record) });
  const h = managedHarness([interaction('background', [], 'in_progress')], {
    polls: [new Error('Polling failed')], logger, cancelError: new Error('Cleanup failed'),
  });
  await assert.rejects(h.select(), /Polling failed/);
  assert.equal(h.cancels.length, 1);
  assert.equal(records.filter(record => record.event === 'interaction.cancel-failed').length, 1);
});

test('Antigravity judgment rejects terminal responses and never retries model failures', async () => {
  const request = { kind: 'code', problem: sampleProblem, code: '', language: 'Python' };
  const terminal = managedHarness([interaction('terminal', [], 'completed')]);
  await assert.rejects(terminal.judge(request), /finished without submitting an assessment/);
  const failing = managedHarness([Object.assign(new Error('Unavailable'), { status: 503 })]);
  await assert.rejects(failing.judge(request), /Unavailable/);
  assert.equal(failing.creates.length, 1);
});

test('Antigravity messages preserve final text and the complete raw interaction', () => {
  const { interactionMessage } = load('src/features/interview/adapters/models/antigravity/interactionMapping.ts');
  const raw = { ...interaction('final', [{ type: 'model_output', content: [{ type: 'text', text: 'Final result' }] }], 'completed'),
    usage: { tokens: 12 }, reasoning: { provider: 'Retain this field' } };
  const quiet = { debug() {} };
  const message = interactionMessage(raw, quiet);
  assert.equal(message.text, 'Final result');
  assert.deepEqual(plain(message.response_metadata.interaction), raw);
  assert.equal(message.tool_calls.length, 0);
});
