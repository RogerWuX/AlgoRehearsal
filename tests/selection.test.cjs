const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, flush, deferred, sampleProblem, config, Message, selector, testRuntime, scriptedProvider, toolCall, reply, submission } = require('./helpers/fixtures.cjs');

test('random number supports inclusive endpoints, equal and negative bounds', () => {
  for (const [words, expected] of [[[0, 0], -2], [[0, 4], 2]]) {
    const agent = load('src/features/interview/utils.ts', { crypto: { getRandomValues: array => array.set(words) } });
    assert.equal(agent.generateRandomNumber({ min: -2, max: 2 }), expected);
  }
  assert.equal(load('src/features/interview/utils.ts').generateRandomNumber({ min: 7, max: 7 }), 7);
  const agent = load('src/features/interview/utils.ts');
  for (let i = 0; i < 50; i++) {
    const n = agent.generateRandomNumber({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
    assert.ok(Number.isSafeInteger(n));
  }
});

test('random number rejects biased samples and invalid bounds', () => {
  let calls = 0;
  const agent = load('src/features/interview/utils.ts', { crypto: { getRandomValues: array => array.set(calls++ === 0 ? [0xffffffff, 0xffffffff] : [0, 2]) } });
  assert.equal(agent.generateRandomNumber({ min: 1, max: 3 }), 3);
  assert.equal(calls, 2);
  for (const args of [null, {}, { min: '1', max: 4 }, { min: 3, max: 2 }, { min: 1.5, max: 4 }, { min: 0, max: Infinity }, { min: 0, max: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => agent.generateRandomNumber(args), /safe integers/);
  }
});

test('selector invokes search and random tools, preserves reasoning metadata, and submits once', async () => {
  const controller = new AbortController();
  let searched = 0;
  const thought = reply(toolCall('search', 'search_problem', { query: 'Find a DSA problem' }), toolCall('random', 'gen_random_number', { min: 4, max: 4 }));
  thought.additional_kwargs = { thoughtSignature: 'preserve-this' };
  const provider = scriptedProvider([thought, submission()], async (query, signal) => {
    searched++;
    assert.equal(query, 'Find a DSA problem');
    assert.equal(signal, controller.signal);
    return { text: 'Verified', sources: [{ title: 'Pair sum', url: sampleProblem.sourceUrl }] };
  });
  assert.deepEqual(plain(await selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Custom selection rules', controller.signal)), sampleProblem);
  assert.equal(searched, 1);
  assert.deepEqual(provider.configurations, [{ ...config.thinking }]);
  assert.equal(provider.calls[0].options.signal.aborted, false);
  assert.match(provider.calls[0].history[0].text, /Custom selection rules/);
  const history = provider.calls[1].history;
  assert.deepEqual(history[2].additional_kwargs, thought.additional_kwargs);
  assert.equal(history[2].additional_kwargs.thoughtSignature, 'preserve-this');
  assert.equal(history[3].tool_call_id, 'search');
  assert.equal(JSON.parse(history[3].content).sources[0].url, sampleProblem.sourceUrl);
  assert.equal(JSON.parse(history[4].content).number, 4);
});

test('invalid submissions and unknown tools return errors for correction', async () => {
  const provider = scriptedProvider([
    reply(toolCall('bad', 'submit_problem', { ...sampleProblem, sourceUrl: 'javascript:alert(1)' }), toolCall('unknown', 'unsupported', {})),
    submission(),
  ]);
  assert.deepEqual(plain(await selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal)), sampleProblem);
  const history = provider.calls[1].history;
  assert.equal(history[3].status, 'error');
  assert.match(JSON.parse(history[3].content).error.message, /HTTP/);
  assert.match(JSON.parse(history[4].content).error.message, /Unknown tool/);
});

test('schema validation errors can be corrected and duplicate tool calls reuse results', async () => {
  let searches = 0;
  const call = toolCall('same-search', 'search_problem', { query: 'Verify the problem' });
  const provider = scriptedProvider([
    reply(toolCall('bad', 'submit_problem', { ...sampleProblem, examples: [] }), call),
    reply(call), submission(),
  ], async () => { searches++; return { text: 'Found', sources: [] }; });
  await selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal);
  assert.equal(searches, 1);
  assert.equal(provider.calls[1].history[3].status, 'error');
  assert.ok(provider.calls[2].history.some(message => message.tool_call_id === call.id));
});

test('first valid submission ends selection without another model call or submission', async () => {
  const provider = scriptedProvider([reply(
    toolCall('first', 'submit_problem', sampleProblem),
    toolCall('later-search', 'search_problem', { query: 'Do not search after acceptance' }),
    toolCall('second', 'submit_problem', { ...sampleProblem, title: 'Different' }),
    { name: 'search_problem', args: {}, type: 'tool_call' },
  )], () => assert.fail('Selection already completed'));
  const result = await selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal);
  assert.equal(result.title, sampleProblem.title);
  assert.equal(provider.calls.length, 1);
});

test('tools in one batch wait in order and duplicate search IDs run only once', async () => {
  const pending = deferred(), queries = [];
  const search = toolCall('same-search', 'search_problem', { query: 'Verify before submission' });
  const provider = scriptedProvider([reply(search, search,
    toolCall('submit', 'submit_problem', sampleProblem),
    toolCall('later', 'search_problem', { query: 'Do not execute' }),
  )], async query => { queries.push(query); return pending.promise; });
  let finished = false;
  const task = selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal)
    .then(problem => { finished = true; return problem; });
  await flush();
  assert.deepEqual(queries, ['Verify before submission']);
  assert.equal(finished, false);
  pending.resolve({ text: 'Verified', sources: [] });
  assert.deepEqual(plain(await task), sampleProblem);
  assert.deepEqual(queries, ['Verify before submission']);
  assert.equal(provider.calls.length, 1);
});

test('reusing a tool ID for a different tool fails before executing it', async () => {
  let searches = 0;
  const provider = scriptedProvider([
    reply(toolCall('same', 'search_problem', { query: 'Verify problem' })),
    reply(toolCall('same', 'gen_random_number', { min: 1, max: 1 })),
  ], async () => { searches++; return { text: 'Verified', sources: [] }; });
  await assert.rejects(selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal), /different tool/);
  assert.equal(searches, 1);
  assert.equal(provider.calls.length, 2);
});

test('a fatal tool ID conflict stops the rest of its batch', async () => {
  const queries = [];
  const provider = scriptedProvider([reply(
    toolCall('same', 'search_problem', { query: 'First search' }),
    toolCall('same', 'gen_random_number', { min: 1, max: 1 }),
    toolCall('later', 'search_problem', { query: 'Do not execute after failure' }),
  )], async query => { queries.push(query); return { text: 'Verified', sources: [] }; });
  await assert.rejects(selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal), /different tool/);
  assert.deepEqual(queries, ['First search']);
});

test('provider can be substituted and dropdown model changes reach the factory', async () => {
  const select = selector();
  for (const thinking of [{ ...config.thinking, model: 'gemini-3.8-flash' }, { ...config.thinking, model: 'antigravity-preview-09-2026' }]) {
    const provider = scriptedProvider([submission()]);
    await select(testRuntime({}, { google: provider.factory, antigravity: provider.factory }).getModel(thinking), 'Rules', new AbortController().signal);
    assert.deepEqual(provider.configurations, [{ ...thinking }]);
  }
});

test('selector reports API failures, missing submissions, and malformed calls', async () => {
  for (const [response, pattern] of [
    [new Error('Invalid thinking credential'), /Invalid thinking/],
    [new Message({ content: 'No verified problem found', tool_calls: [] }), /without submitting/],
    [reply({ name: 'submit_problem', args: sampleProblem }), /invalid tool call/],
  ]) {
    const provider = scriptedProvider([response]);
    await assert.rejects(selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', new AbortController().signal), pattern);
  }
});

test('runtime rejects a Live token and selector aborts before invoking a model', async () => {
  const controller = new AbortController();
  const provider = scriptedProvider([]);
  const runtime = testRuntime({}, { google: provider.factory });
  assert.throws(() => runtime.getModel({ ...config.thinking, apiKey: 'auth_tokens/live' }), /standard thinking API key/);
  assert.equal(provider.configurations.length, 0);
  const model = runtime.getModel(config.thinking);
  controller.abort();
  await assert.rejects(selector()(model, 'Rules', controller.signal), /abort/i);
  assert.equal(provider.calls.length, 0);
});

test('cancellation during a model invocation prevents submission', async () => {
  const pending = deferred(), controller = new AbortController();
  const provider = scriptedProvider([async () => pending.promise]);
  const task = selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', controller.signal);
  await flush();
  controller.abort();
  pending.resolve(submission());
  await assert.rejects(task, /abort/i);
  assert.equal(provider.calls.length, 1);
});

test('cancellation during search prevents another model invocation', async () => {
  const pending = deferred(), controller = new AbortController();
  const provider = scriptedProvider([reply(toolCall('search', 'search_problem', { query: 'Problem' })), submission()], async (_query, signal) => {
    assert.equal(signal, controller.signal);
    return pending.promise;
  });
  const task = selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), 'Rules', controller.signal);
  await flush(); controller.abort(); pending.resolve({ text: 'Late result', sources: [] });
  await assert.rejects(task, /abort/i);
  assert.equal(provider.calls.length, 1);
});

test('embedded instructions reach the selector without fetch or document access', async () => {
  const agent = load('src/features/interview/agents/selection/loadSelectionInstructions.ts', { fetch: undefined, document: undefined });
  const controller = new AbortController();
  const instructions = await agent.loadSelectionInstructions(controller.signal);
  assert.match(instructions, /^# Problem selection instructions\n\n/);
  assert.match(instructions, /Do not conduct the interview or provide a solution/);
  const provider = scriptedProvider([submission()]);
  await selector()(testRuntime({}, { google: provider.factory }).getModel(config.thinking), instructions, controller.signal);
  assert.ok(provider.calls[0].history[0].text.startsWith(instructions + '\n\n'));
});

test('embedded instruction loading rejects cancellation', async () => {
  const agent = load('src/features/interview/agents/selection/loadSelectionInstructions.ts', { fetch: undefined, document: undefined });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(agent.loadSelectionInstructions(controller.signal), /abort/i);
});
