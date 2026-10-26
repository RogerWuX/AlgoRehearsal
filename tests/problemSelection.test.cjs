const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, sampleProblem, memoryStorage, deferred, flush, scriptedProvider, submission } = require('./helpers/fixtures.cjs');

const secondProblem = { ...sampleProblem, title: 'Second problem', sourceUrl: 'https://example.test/problems/second' };

test('selector defaults load embedded instructions and run the real selection agent', async () => {
  const { createProblemRepository } = load('src/features/interview/storage/problemStorage.ts');
  const { createProblemSelector } = load('src/features/interview/selection/createProblemSelector.ts');
  const { createThinkingRuntime } = load('src/features/interview/llm/runtime.ts');
  const { SELECTION_INSTRUCTIONS } = load('src/features/interview/agents/selection/prompts.ts');
  const provider = scriptedProvider([submission()]);
  const thinking = createThinkingRuntime({ google: provider.factory });
  const problems = createProblemRepository(() => memoryStorage());
  const logger = load('src/shared/logger.ts').logger;
  const selector = createProblemSelector({ problems, thinking });
  const description = 'Medium graphs\n最短路徑 {{literal}} $&';
  const result = await selector.prepare({ ...config, saveSearchedProblems: true, problemSearchDescription: description })
    .getProblem(new AbortController().signal, logger);
  assert.deepEqual(plain(result), { problem: sampleProblem, problemStorageStatus: 'saved', storedProblemCount: 1 });
  assert.deepEqual(provider.configurations, [config.thinking]);
  assert.equal(provider.calls.length, 1);
  assert.ok(provider.calls[0].history[0].text.startsWith(SELECTION_INSTRUCTIONS + '\n\n'));
  assert.equal(provider.calls[0].history[1].text, `Start problem selection.\n\nUser problem preferences:\n${description}`);
  assert.equal(thinking.getModel(config.thinking), thinking.getModel(config.thinking));
  assert.equal(provider.configurations.length, 1);
});

test('stored selector defaults skip instruction loading and model calls', async () => {
  const { createProblemRepository } = load('src/features/interview/storage/problemStorage.ts');
  const { createProblemSelector } = load('src/features/interview/selection/createProblemSelector.ts', {
    crypto: { getRandomValues: array => array.set([0, 1]) },
  }, {
    '../agents/selection/loadSelectionInstructions': { loadSelectionInstructions: () => assert.fail('No instruction load') },
    '../agents/selection/selectProblem': { selectProblem: () => assert.fail('No agent call') },
  });
  const selector = createProblemSelector({
    problems: createProblemRepository(() => memoryStorage(), { initialProblems: [sampleProblem, secondProblem] }),
    thinking: { getModel: () => assert.fail('No model lookup') },
  });
  const result = await selector.prepare({ ...config, problemSource: 'stored', problemSearchDescription: 'Hard graphs' })
    .getProblem(new AbortController().signal, load('src/shared/logger.ts').logger);
  assert.deepEqual(plain(result), { problem: secondProblem, problemStorageStatus: 'saved', storedProblemCount: 2 });
});

function setup({ initialProblems = [], words = [0, 0], storage = memoryStorage(),
  loadInstructions = async () => 'Rules', selectProblem = async () => sampleProblem } = {}) {
  const { createProblemRepository } = load('src/features/interview/storage/problemStorage.ts');
  const { createProblemSelector } = load('src/features/interview/selection/createProblemSelector.ts', {
    crypto: { getRandomValues: array => array.set(words) },
  });
  const records = [], calls = [], writes = [], model = {};
  const logger = load('src/shared/logger.ts').createLogger({ enabled: true, sink: record => records.push(record) });
  const repository = createProblemRepository(() => storage, { initialProblems, importWarning: 'Import warning' });
  const selector = createProblemSelector({
    problems: { ...repository, write(problem, log) { writes.push(plain(problem)); return repository.write(problem, log); } },
    thinking: { getModel(configuration) { calls.push(['model', plain(configuration)]); return model; } },
    loadInstructions: signal => { calls.push(['instructions', signal]); return loadInstructions(signal); },
    selectProblem: (...args) => { calls.push(['agent', ...args]); return selectProblem(...args); },
  });
  const run = configuration => selector.prepare(configuration, logger).getProblem(new AbortController().signal, logger);
  return { selector, repository, logger, records, calls, writes, model, run };
}

test('selector reports bank metadata and locally selects both stored endpoints with origin and saving', async () => {
  for (const [words, expected, index] of [[[0, 0], sampleProblem, 0], [[0, 1], secondProblem, 1]]) {
    const h = setup({ initialProblems: [sampleProblem, secondProblem], words });
    assert.deepEqual(plain(h.selector.getBankInfo()), { storedProblemCount: 2, questionImportWarning: 'Import warning' });
    const prepared = h.selector.prepare({ ...config, problemSource: 'stored', saveSearchedProblems: false });
    assert.equal(prepared.initialStatus, 'connecting');
    const selected = await prepared.getProblem(new AbortController().signal, h.logger);
    assert.deepEqual(plain(selected), { problem: expected, problemStorageStatus: 'saved', storedProblemCount: 2 });
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.writes, [expected]);
    const loaded = h.records.find(record => record.event === 'problem.loaded').data;
    assert.deepEqual(plain(loaded), { source: 'stored-bank', origin: 'project-json', index, bankSize: 2, selectionSkipped: true, problem: expected });
  }
});

test('empty stored bank rejects during preparation without instructions, model lookup, or saving', () => {
  const h = setup();
  assert.throws(() => h.selector.prepare({ ...config, problemSource: 'stored' }, h.logger), /No stored questions/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.writes, []);
  const rejected = h.records.find(record => record.event === 'session.start-rejected');
  assert.equal(rejected.data.reason, 'stored-bank-empty');
  assert.equal(rejected.data.fallbackToAgent, false);
});

test('preparation captures stored bank and source preferences before acquisition', async () => {
  const h = setup({ initialProblems: [sampleProblem], words: [0, 1] });
  const configuration = { ...config, problemSource: 'stored', saveSearchedProblems: false };
  const prepared = h.selector.prepare(configuration);
  configuration.problemSource = 'agent';
  h.repository.write(secondProblem);
  const result = await prepared.getProblem(new AbortController().signal, h.logger);
  assert.deepEqual(plain(result.problem), sampleProblem);
  assert.equal(result.storedProblemCount, 2);
  assert.deepEqual(h.calls, []);
  assert.equal(h.records.find(record => record.event === 'problem.loaded').data.bankSize, 1);
});

test('agent selection loads instructions before looking up the captured model and validates the result', async () => {
  const h = setup({ selectProblem: async () => ({ ...sampleProblem, title: '  Pair sum  ' }) });
  const configuration = { ...config, thinking: { ...config.thinking } };
  const controller = new AbortController();
  const prepared = h.selector.prepare(configuration);
  assert.equal(prepared.initialStatus, 'selecting');
  assert.deepEqual(plain(prepared.logContext), { source: 'agent', saveSearchedProblems: false, storedProblemCount: 0 });
  configuration.thinking.model = 'changed-after-preparation';
  const result = await prepared.getProblem(controller.signal, h.logger);
  assert.deepEqual(h.calls.map(call => call[0]), ['instructions', 'model', 'agent']);
  assert.deepEqual(h.calls[1][1], config.thinking);
  assert.equal(h.calls[2][1], h.model);
  assert.equal(h.calls[2][2], 'Rules');
  assert.equal(h.calls[2][3], controller.signal);
  assert.equal(h.calls[2][4], h.logger);
  assert.deepEqual(plain(result), { problem: sampleProblem, problemStorageStatus: 'session', storedProblemCount: 0 });
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.records.map(record => record.event), ['instructions.load-started', 'instructions.loaded', 'problem.loaded', 'problem.session-only']);
});

test('searched saving is opt-in and leaves an existing bank unchanged when disabled', async () => {
  for (const saveSearchedProblems of [false, true]) {
    const h = setup({ initialProblems: [secondProblem] });
    const result = await h.run({ ...config, saveSearchedProblems });
    assert.equal(result.problemStorageStatus, saveSearchedProblems ? 'saved' : 'session');
    assert.equal(result.storedProblemCount, saveSearchedProblems ? 2 : 1);
    assert.deepEqual(h.writes, saveSearchedProblems ? [sampleProblem] : []);
    assert.deepEqual(plain(h.repository.list()), saveSearchedProblems ? [secondProblem, sampleProblem] : [secondProblem]);
  }
});

test('selection captures normalized descriptions before acquisition and trims blank descriptions to empty', async () => {
  for (const description of ['', ' \n\t ', '  Medium graphs\n最短路徑 {{literal}} $&  ']) {
    const h = setup();
    const configuration = { ...config, problemSearchDescription: description };
    const prepared = h.selector.prepare(configuration);
    configuration.problemSearchDescription = 'Changed after preparation';
    await prepared.getProblem(new AbortController().signal, h.logger);
    assert.equal(h.calls.find(call => call[0] === 'agent')[5], description.trim());
  }
});

test('selection failures and invalid problems never change the bank', async () => {
  for (const overrides of [
    { loadInstructions: async () => { throw new Error('Instructions failed'); } },
    { selectProblem: async () => { throw new Error('Agent failed'); } },
    { selectProblem: async () => ({ ...sampleProblem, examples: [] }) },
  ]) {
    const h = setup({ ...overrides, initialProblems: [secondProblem] });
    await assert.rejects(h.run({ ...config, saveSearchedProblems: true }));
    assert.deepEqual(h.writes, []);
    assert.deepEqual(plain(h.repository.list()), [secondProblem]);
    assert.ok(!h.records.some(record => record.event === 'problem.loaded'));
    if (overrides.loadInstructions) assert.deepEqual(h.calls.map(call => call[0]), ['instructions']);
  }
});

test('unavailable storage returns the accepted problem and the in-memory bank', async () => {
  for (const problemSource of ['agent', 'stored']) {
    const h = setup({ initialProblems: [sampleProblem], storage: {
      getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); },
    } });
    const result = await h.run({ ...config, problemSource, saveSearchedProblems: true });
    assert.deepEqual(plain(result), { problem: sampleProblem, problemStorageStatus: 'unavailable', storedProblemCount: 1 });
    assert.deepEqual(plain(h.repository.list()), [sampleProblem]);
  }
});

test('an already canceled request performs no selection or saving in either mode', async () => {
  for (const problemSource of ['agent', 'stored']) {
    const h = setup({ initialProblems: [sampleProblem] });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(h.selector.prepare({ ...config, problemSource }).getProblem(controller.signal, h.logger), /abort/i);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.records, []);
  }
});

test('cancellation settles promptly and ignores late instructions and late agent results before saving', async () => {
  for (const phase of ['instructions', 'agent']) {
    const pending = deferred(), controller = new AbortController();
    const h = setup(phase === 'instructions' ? { loadInstructions: () => pending.promise } : { selectProblem: () => pending.promise });
    const task = h.selector.prepare({ ...config, saveSearchedProblems: true }).getProblem(controller.signal, h.logger);
    await flush();
    controller.abort();
    await assert.rejects(task, /abort/i);
    pending.resolve(phase === 'instructions' ? 'Stale instructions' : sampleProblem);
    await flush();
    assert.deepEqual(h.writes, []);
    assert.equal(h.repository.list().length, 0);
    assert.ok(!h.records.some(record => record.event === 'problem.loaded'));
    if (phase === 'instructions') assert.deepEqual(h.calls.map(call => call[0]), ['instructions']);
  }
});
