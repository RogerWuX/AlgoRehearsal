const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const load = require('./helpers/loadTypeScript.cjs');
const { loadProjectQuestions } = require('../scripts/loadProjectQuestions.cjs');
const { plain, memoryStorage, sampleProblem, config, deferred, flush, formatDiscussionMessage } = require('./helpers/fixtures.cjs');

const secondProblem = { ...sampleProblem, title: 'Another problem', sourceUrl: 'https://example.test/problems/another' };

test('Metro loads the root question database in development and production without credential opt-in', () => {
  for (const NODE_ENV of ['development', 'dev', 'test', 'production']) {
    const env = { NODE_ENV };
    const raw = JSON.stringify([sampleProblem]);
    loadProjectQuestions('/project', env, (file, encoding) => {
      assert.equal(file, join('/project', 'question', 'questions.json'));
      assert.equal(encoding, 'utf8');
      return raw;
    });
    assert.equal(env.EXPO_PUBLIC_PROJECT_QUESTIONS, raw);
    assert.equal(env.EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING, '');
    const imported = load('src/features/interview/adapters/projectQuestions.web.ts', { process: { env } }).loadProjectQuestions();
    assert.deepEqual(plain(imported), { problems: [sampleProblem], warning: '' });
  }
});

test('missing question folders reset stale data; unreadable and malformed databases warn without crashing', () => {
  const env = { EXPO_PUBLIC_PROJECT_QUESTIONS: JSON.stringify([sampleProblem]), EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING: 'stale' };
  const readError = code => () => { throw Object.assign(new Error('Private details'), { code }); };
  loadProjectQuestions('/project', env, readError('ENOENT'));
  let imported = load('src/features/interview/adapters/projectQuestions.web.ts', { process: { env } }).loadProjectQuestions();
  assert.deepEqual(plain(imported), { problems: [], warning: '' });
  loadProjectQuestions('/project', env, readError('EACCES'));
  imported = load('src/features/interview/adapters/projectQuestions.web.ts', { process: { env } }).loadProjectQuestions();
  assert.equal(imported.problems.length, 0);
  assert.match(imported.warning, /permissions/);
  assert.doesNotMatch(imported.warning, /Private details/);
  for (const raw of ['{broken', '{}', 'null', JSON.stringify([{ ...sampleProblem, examples: [] }, secondProblem])]) {
    loadProjectQuestions('/project', env, () => raw);
    imported = load('src/features/interview/adapters/projectQuestions.web.ts', { process: { env } }).loadProjectQuestions();
    assert.match(imported.warning, /could not be imported/);
    assert.deepEqual(plain(imported.problems), raw.startsWith('[') ? [secondProblem] : []);
  }
});

test('question bank imports merge by URL, update records, and restore without selecting an active problem', () => {
  const { createProblemRepository, PROBLEM_BANK_STORAGE_KEY } = load('src/features/interview/storage/problemStorage.ts');
  const storage = memoryStorage();
  let repository = createProblemRepository(() => storage, { initialProblems: [sampleProblem, secondProblem] });
  assert.deepEqual(plain(repository.list()), [sampleProblem, secondProblem]);
  assert.equal(repository.read().problem, null);
  assert.equal(repository.write({ ...sampleProblem, description: 'Updated by agent' }), 'saved');
  repository = createProblemRepository(() => storage, { initialProblems: [{ ...secondProblem, description: 'Updated in database' }] });
  assert.equal(repository.read().problem.description, 'Updated by agent');
  assert.equal(repository.list().length, 2);
  assert.equal(repository.list()[1].description, 'Updated in database');
  const before = storage.getItem(PROBLEM_BANK_STORAGE_KEY);
  const originalWrite = storage.setItem;
  let writes = 0;
  storage.setItem = (...args) => { writes++; originalWrite(...args); };
  repository = createProblemRepository(() => storage, { initialProblems: [{ ...secondProblem, description: 'Updated in database' }] });
  assert.equal(writes, 0);
  assert.equal(storage.getItem(PROBLEM_BANK_STORAGE_KEY), before);
  // Removing the bundled database does not delete previously saved questions.
  assert.equal(createProblemRepository(() => storage).list().length, 2);
});

test('current active problems restore from local storage and join the question bank', () => {
  const { createProblemRepository, writeProblem, readProblem } = load('src/features/interview/storage/problemStorage.ts');
  const storage = memoryStorage();
  writeProblem(storage, sampleProblem);
  let repository = createProblemRepository(() => storage);
  assert.deepEqual(plain(repository.read().problem), sampleProblem);
  assert.deepEqual(plain(repository.list()), [sampleProblem]);
  assert.equal(repository.getOrigin(sampleProblem.sourceUrl), 'local-storage');
  repository.write(secondProblem);
  repository = createProblemRepository(() => storage);
  assert.deepEqual(plain(readProblem(storage)), secondProblem);
  assert.equal(repository.list().length, 2);
});

test('invalid stored entries are ignored and blocked/full storage keeps the bank usable in memory', () => {
  const { createProblemRepository, PROBLEM_BANK_STORAGE_KEY } = load('src/features/interview/storage/problemStorage.ts');
  const storage = memoryStorage();
  storage.setItem(PROBLEM_BANK_STORAGE_KEY, JSON.stringify([{}, sampleProblem]));
  assert.deepEqual(plain(createProblemRepository(() => storage).list()), [sampleProblem]);
  for (const [getStorage, expectedStatus] of [
    [() => null, 'session'],
    [() => { throw new Error('Blocked'); }, 'unavailable'],
    [() => ({ getItem: () => { throw new Error('Blocked'); }, setItem: () => { throw new Error('Blocked'); } }), 'unavailable'],
    [() => ({ getItem: () => null, setItem: () => { throw new Error('Quota'); } }), 'unavailable'],
  ]) {
    const repository = createProblemRepository(getStorage, { initialProblems: [sampleProblem] });
    assert.deepEqual(plain(repository.list()), [sampleProblem]);
    assert.equal(repository.write(secondProblem), expectedStatus);
    assert.equal(repository.list().length, 2);
    assert.deepEqual(plain(repository.read().problem), secondProblem);
  }
});

function storedSession({ problems = [sampleProblem, secondProblem], words = [0, 0], audio, storage = memoryStorage() } = {}) {
  const requests = [], timers = [];
  const { createProblemRepository } = load('src/features/interview/storage/problemStorage.ts');
  const { createProblemSelector } = load('src/features/interview/selection/createProblemSelector.ts', {
    crypto: { getRandomValues: array => array.set(words) },
  });
  const { InterviewSession } = load('src/features/interview/session/InterviewSession.ts');
  const session = new InterviewSession({
    formatDiscussionMessage,
    judgment: { isRunning: () => false, cancel() {}, run: async () => assert.fail('Unexpected grading') },
    selection: createProblemSelector({
      problems: createProblemRepository(() => storage, { initialProblems: problems }),
      thinking: { getModel: () => assert.fail('Stored mode must skip model lookup') },
      loadInstructions: () => assert.fail('Stored mode must skip instruction loading'),
      selectProblem: () => assert.fail('Stored mode must skip the selection agent'),
    }),
    createAudio: () => audio ?? { resume: async () => {}, close() {}, stopMicrophone: () => false },
    createTransport: (live, problem, events) => {
      requests.push({ live, problem, events });
      return { close() {} };
    },
    clock: { setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.cleared = true; } },
  });
  return { session, requests, timers, storage };
}

const storedConfig = { ...config, problemSource: 'stored' };

test('stored mode requires both APIs, selects both random endpoints, saves the choice, and retries the same problem', async () => {
  for (const [words, expected] of [[[0, 0], sampleProblem], [[0, 1], secondProblem]]) {
    const h = storedSession({ words });
    try {
      assert.equal(h.session.getSnapshot().storedProblemCount, 2);
      assert.equal(h.requests.length, 0);
      await h.session.connect(storedConfig);
      assert.equal(h.session.getSnapshot().status, 'connecting');
      assert.equal(h.timers[0].ms, 20000);
      assert.deepEqual(plain(h.requests[0].problem), expected);
      assert.deepEqual(JSON.parse(h.storage.getItem('interview-practice.problem')), expected);
      h.requests[0].events.error('Live connection failed');
      assert.equal(h.session.getSnapshot().canRetry, true);
      await h.session.retry(config);
      assert.equal(h.requests.length, 2);
      assert.deepEqual(plain(h.requests[1].problem), expected);
      h.requests[1].events.ready();
      assert.equal(h.session.getSnapshot().status, 'connected');
    } finally { h.session.disconnect(); }
  }
});

test('stored mode rejects an empty bank or missing Live settings without starting resources or falling back to the agent', async () => {
  const empty = storedSession({ problems: [] });
  await empty.session.connect(storedConfig);
  assert.match(empty.session.getSnapshot().error, /No stored questions/);
  assert.equal(empty.requests.length, 0);
  assert.equal(empty.timers.length, 0);
  const missingLive = storedSession();
  await missingLive.session.connect({ ...storedConfig, live: { ...config.live, credential: '' } });
  assert.match(missingLive.session.getSnapshot().error, /Live API credential/);
  assert.equal(missingLive.requests.length, 0);
  for (const thinking of [{ ...config.thinking, apiKey: '' }, { ...config.thinking, apiKey: 'auth_tokens/ephemeral' }]) {
    const missingThinking = storedSession();
    await missingThinking.session.connect({ ...storedConfig, thinking });
    assert.match(missingThinking.session.getSnapshot().error, /standard thinking API key/);
    assert.equal(missingThinking.requests.length, 0);
    assert.equal(missingThinking.timers.length, 0);
  }
});

test('canceling or timing out stored startup ignores a late audio resume and leaves the workspace empty', async () => {
  for (const timeout of [false, true]) {
    const pending = deferred(), storage = memoryStorage();
    load('src/features/interview/storage/problemStorage.ts').writeProblem(storage, sampleProblem);
    let closes = 0;
    const h = storedSession({ storage, words: [0, 1], audio: { resume: () => pending.promise, close: () => { closes++; }, stopMicrophone: () => false } });
    const task = h.session.connect(storedConfig);
    await flush();
    await h.session.connect(storedConfig);
    assert.equal(h.timers.length, 1);
    if (timeout) h.timers[0].callback(); else h.session.disconnect();
    pending.resolve(); await task;
    assert.equal(closes, 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.session.getSnapshot().status, 'disconnected');
    assert.equal(h.session.getSnapshot().problem, null);
    assert.deepEqual(JSON.parse(storage.getItem('interview-practice.problem')), sampleProblem);
    assert.equal(h.session.getSnapshot().canRetry, false);
  }
});

test('web composition imports bundled questions without accessing legacy session storage', async () => {
  for (const blocked of [false, true]) {
    const storage = memoryStorage(), legacy = memoryStorage();
    load('src/features/interview/storage/problemStorage.ts').writeProblem(legacy, sampleProblem);
    let reads = 0;
    const browser = { localStorage: storage, get sessionStorage() {
      reads++;
      if (blocked) throw new Error('Blocked');
      return legacy;
    } };
    const hook = load('src/features/interview/hooks/useInterviewSession.web.ts', {
      window: browser,
      process: { env: { EXPO_PUBLIC_PROJECT_QUESTIONS: JSON.stringify([secondProblem]) } },
    }, {
      './useSessionController': { default: create => create() },
      '../adapters/audio/browserAudio.web': { BrowserAudio: class {} },
      '../adapters/liveTransport.web': { createLiveTransport() {} },
      '../adapters/thinkingModels': { createThinkingRuntime() {} },
      '../agents/selection/selectProblem': { selectProblem() {} },
    }).default;
    const dependencies = hook();
    assert.equal(dependencies.formatDiscussionMessage('Written notes'), '[Discussion notes]\nWritten notes');
    assert.deepEqual(plain(dependencies.selection.getBankInfo()), { storedProblemCount: 1, questionImportWarning: '' });
    assert.equal(storage.getItem('interview-practice.problem'), null);
    assert.deepEqual(JSON.parse(storage.getItem('interview-practice.questions')), [secondProblem]);
    await dependencies.selection.prepare({ ...config, problemSource: 'stored' }).getProblem(
      new AbortController().signal, load('src/shared/logger.ts').logger);
    assert.deepEqual(JSON.parse(storage.getItem('interview-practice.problem')), secondProblem);
    assert.deepEqual(JSON.parse(legacy.getItem('interview-practice.problem')), sampleProblem);
    assert.equal(reads, 0);
  }
});
