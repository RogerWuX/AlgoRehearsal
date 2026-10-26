const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, config, sampleProblem, messages, fakeClock, scriptedProvider, toolCall, reply, submission, memoryStorage, deferred, selector, testRuntime, formatDiscussionMessage } = require('./helpers/fixtures.cjs');

function capture() {
  const records = [];
  const { createLogger } = load('src/shared/logger.ts');
  return { records, logger: createLogger({ enabled: true, sink: record => records.push(record) }) };
}

for (const development of [true, false]) {
  test(`native ${development ? 'development' : 'production'} prints only errors without inspecting lower-level payloads`, () => {
    const output = [];
    let inspected = 0;
    const console = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (prefix, json) => output.push({ level, prefix, record: JSON.parse(json) })]));
    const { logger, createLogger } = load('src/shared/logger.ts', { __DEV__: development, console });
    const payload = Object.defineProperty({}, 'value', { enumerable: true, get() { inspected++; return 'value'; } });
    const child = logger.child({ scope: 'test' });
    for (const level of ['debug', 'info', 'warn']) child[level]('ignored', payload);
    createLogger({ enabled: true, minLevel: 'debug' }).info('also-filtered', payload);
    assert.equal(inspected, 0);
    assert.equal(output.length, 0);
    child.error('failed', payload);
    assert.equal(inspected, 1);
    assert.equal(output.length, 1);
    assert.equal(output[0].level, 'error');
    assert.equal(output[0].prefix, '[interview-practice]');
    assert.equal(output[0].record.scope, 'test');
    assert.equal(output[0].record.data.value, 'value');
  });
}

function webLogger(development, console, storage) {
  const globals = { __DEV__: development, console };
  const output = load('src/shared/loggerOutput.web.ts', globals, { './logStorage': { logStorage: storage } });
  return load('src/shared/logger.ts', globals, { './loggerOutput': output });
}

test('web explicit minimum levels and disabled logging do not inspect filtered payloads', () => {
  const records = [];
  let inspected = 0, printed = 0;
  const console = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => printed++]));
  const { createLogger } = webLogger(false, console, { append: record => records.push(record) });
  const payload = Object.defineProperty({}, 'value', { enumerable: true, get() { inspected++; return 'value'; } });
  const child = createLogger({ minLevel: 'warn' }).child({ scope: 'production', attempt: 2 }).child({ session: 3 });
  child.debug('ignored', payload); child.info('ignored', payload);
  createLogger({ enabled: false }).error('disabled', payload);
  assert.equal(inspected, 0);
  child.warn('warning', { response_metadata: { all: true } });
  assert.deepEqual(records.map(record => record.level), ['warn']);
  assert.equal(records[0].context.attempt, 2);
  assert.equal(records[0].context.session, 3);
  assert.equal(records[0].data.response_metadata.all, true);
  assert.equal(printed, 0);
});

for (const development of [true, false]) {
  test(`web ${development ? 'development' : 'production'} stores every level and prints only redacted errors`, () => {
    const records = [], output = [];
    const console = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (prefix, json) => output.push({ level, prefix, record: JSON.parse(json) })]));
    const { logger } = webLogger(development, console, { append: record => records.push(record) });
    const child = logger.child({ attempt: 7 }, ['my-key']).child({ session: 3 });
    for (const level of ['debug', 'info', 'warn', 'error']) child[level]('event', {
      response_metadata: { detail: 'my-key complete' }, toJSON() { throw new Error('Lossy provider serializer'); },
    });
    assert.deepEqual(records.map(record => record.level), ['debug', 'info', 'warn', 'error']);
    assert.equal(output.length, 1);
    assert.equal(output[0].level, 'error');
    assert.equal(output[0].record.level, 'error');
    assert.equal(output[0].prefix, '[interview-practice]');
    assert.ok(records.every(record => record.context.attempt === 7 && record.context.session === 3));
    assert.ok(records.every(record => record.data.response_metadata.detail === '[redacted] complete'));
    assert.equal(output[0].record.data.response_metadata.detail, '[redacted] complete');
  });

  test(`web ${development ? 'development' : 'production'} persists before a throwing error console and honors custom sinks`, () => {
    const records = [];
    let printed = 0;
    const console = { error() {
      printed++;
      assert.equal(records.length, 1);
      throw new Error('Broken console');
    } };
    const { logger, createLogger } = webLogger(development, console, { append: record => records.push(record) });
    assert.doesNotThrow(() => logger.error('saved'));
    assert.equal(printed, 1);
    assert.equal(records.length, 1);
    const custom = [];
    const customLogger = createLogger({ sink: record => custom.push(record) }).child({ scope: 'custom' });
    for (const level of ['debug', 'info', 'warn', 'error']) customLogger[level]('custom');
    assert.deepEqual(custom.map(record => record.level), ['debug', 'info', 'warn', 'error']);
    assert.equal(records.length, 1);
    assert.equal(printed, 1);
  });
}

test('transports send severity above error through console.error', () => {
  for (const file of ['src/shared/loggerOutput.ts', 'src/shared/loggerOutput.web.ts']) {
    let transport;
    const output = [], records = [];
    load(file, { __DEV__: false, console: { error: (prefix, json) => output.push({ prefix, record: JSON.parse(json) }) } }, {
      'react-native-logs': { logger: { createLogger(options) { transport = options.transport; return {}; } } },
      './logStorage': { logStorage: { append: record => records.push(record) } },
    });
    const record = { timestamp: 1000, level: 'critical', scope: 'test', event: 'failed', context: {} };
    transport({ rawMsg: [record], level: { severity: 4, text: 'critical' } });
    assert.equal(output.length, 1);
    assert.equal(output[0].prefix, '[interview-practice]');
    assert.equal(output[0].record.level, 'critical');
    assert.equal(records.length, file.endsWith('.web.ts') ? 1 : 0);
  }
});

test('disabled and minimum logger levels never evaluate payload getters', () => {
  const { createLogger } = load('src/shared/logger.ts');
  let inspected = 0;
  const payload = Object.defineProperty({}, 'value', { enumerable: true, get() { inspected++; return 1; } });
  createLogger({ enabled: false }).error('disabled', payload);
  createLogger({ enabled: true, minLevel: 'warn', sink() {} }).debug('filtered', payload);
  assert.equal(inspected, 0);
});

test('logger captures untruncated immutable provider fields without lossy toJSON conversion', () => {
  const { logger, records } = capture();
  const response = { content: 'Full response '.repeat(2000), response_metadata: { rationale: 'Selected this source' },
    usage_metadata: { total_tokens: 123 }, toJSON: () => ({ content: 'short' }) };
  logger.debug('llm.response', { response });
  response.content = 'Changed'; response.response_metadata.rationale = 'Changed';
  assert.equal(records[0].data.response.content, 'Full response '.repeat(2000));
  assert.equal(records[0].data.response.response_metadata.rationale, 'Selected this source');
  assert.equal(records[0].data.response.usage_metadata.total_tokens, 123);
});

test('console serialization preserves response metadata and never invokes provider toJSON methods', () => {
  const output = [];
  const { logger } = load('src/shared/logger.ts', { __DEV__: true, console: { error: (prefix, json) => output.push(JSON.parse(json)) } });
  logger.error('response', { content: 'Full response', response_metadata: { complete: true },
    toJSON() { throw new Error('Should not be called'); } });
  assert.equal(output.length, 1);
  assert.equal(output[0].data.response_metadata.complete, true);
});

test('logger redacts credentials in nested fields, strings, URLs, errors, and inherited context', () => {
  const { logger, records } = capture();
  const secret = 'key/with"quote';
  const context = { attemptId: 7, credential: 'private-context' };
  const log = logger.child(context, [secret]).child({ scope: 'search' });
  const data = { apiKey: 'other-key', google_api_key: 'private', access_token: 'private-token',
    content: `Response ${secret}`, url: `https://example.test?key=${encodeURIComponent(secret)}`,
    encoded: JSON.stringify({ secret }), error: new Error(`Denied ${secret}`) };
  log.error('failed', data);
  const output = JSON.stringify(records);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes(encodeURIComponent(secret)));
  for (const value of ['other-key', 'private-context', 'private-token', 'private"']) assert.ok(!output.includes(value));
  assert.equal(records[0].context.attemptId, 7);
  assert.equal(records[0].scope, 'search');
  assert.match(records[0].data.error.message, /\[redacted\]/);
});

test('logger tolerates circular payloads, throwing getters and failed sinks, and honors minimum levels', () => {
  const { createLogger } = load('src/shared/logger.ts');
  const records = [];
  const logger = createLogger({ enabled: true, minLevel: 'warn', sink: record => records.push(record) });
  const data = { value: 4n }; data.self = data;
  Object.defineProperty(data, 'broken', { enumerable: true, get() { throw new Error('Getter failed'); } });
  logger.info('ignored'); logger.child({ scope: 'test' }).warn('captured', data);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.self, '[circular]');
  assert.equal(records[0].data.broken, '[unavailable]');
  assert.equal(records[0].data.value, '4');
  assert.doesNotThrow(() => createLogger({ enabled: true, sink() { throw new Error('Sink failed'); } }).error('failed'));
});

function selectWithLog(responses, search) {
  const { logger, records } = capture();
  const select = selector(fakeClock(true).globals);
  const provider = scriptedProvider(responses, search);
  const model = testRuntime({}, { google: provider.factory }).getModel(config.thinking);
  return { records, provider, run: () => select(model, 'Select an easy problem',
    new AbortController().signal, logger.child({ sessionId: 2, attemptId: 3 })) };
}

test('selection trace links full responses, search data, validation corrections, duplicate reuse and acceptance', async () => {
  const searchCall = toolCall('search', 'search_problem', { query: 'Find pair sum' });
  const first = reply(searchCall, toolCall('invalid', 'submit_problem', {}));
  first.content = 'I will search for a suitable problem.';
  first.response_metadata = { providerDetail: 'complete metadata' };
  const h = selectWithLog([first, reply(searchCall), submission()]);
  assert.deepEqual(plain(await h.run()), sampleProblem);
  const events = h.records.map(record => record.event);
  for (const event of ['llm.response', 'search.result', 'tool.rejected', 'tool.reused', 'problem.accepted']) assert.ok(events.includes(event));
  const response = h.records.find(record => record.event === 'llm.response').data.response;
  assert.equal(response.content, first.content);
  assert.equal(response.response_metadata.providerDetail, 'complete metadata');
  const accepted = h.records.find(record => record.event === 'problem.accepted');
  assert.equal(accepted.data.searchObserved, true);
  assert.equal(accepted.data.searchCalls, 1);
  assert.equal(accepted.context.attemptId, 3);
  assert.equal(accepted.context.sessionId, 2);
  assert.equal(h.records.find(record => record.event === 'search.result').data.result.sources[0].url, sampleProblem.sourceUrl);
});

test('an agent submission without a search is not mislabeled as searched because it has a URL', async () => {
  const h = selectWithLog([submission()]);
  await h.run();
  const accepted = h.records.find(record => record.event === 'problem.accepted');
  assert.equal(accepted.data.source, 'agent');
  assert.equal(accepted.data.searchObserved, false);
});

test('Gemini search agent logs the complete grounded model response', async () => {
  const { ScriptedChatModel } = require('./helpers/fixtures.cjs');
  const { logger, records } = capture();
  const response = new messages.AIMessage({ content: 'Verified results', usage_metadata: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    response_metadata: { groundingMetadata: { groundingChunks: [{ web: { uri: sampleProblem.sourceUrl, title: 'Pair sum' } }] } } });
  class ChatGoogle extends ScriptedChatModel {
    constructor() { super([reply(toolCall('search', 'search_problem', { query: 'query' })), response, submission()]); }
  }
  const { createThinkingRuntime } = load('src/features/interview/adapters/thinkingModels.ts', {}, { '@langchain/google': { ChatGoogle } });
  const agents = createThinkingRuntime().getModel(config.thinking);
  await load('src/features/interview/agents/selection/selectProblem.ts').selectProblem(agents, 'Rules', new AbortController().signal, logger);
  assert.equal(records.find(record => record.event === 'search.llm-response').data.response.usage_metadata.total_tokens, 9);
  assert.equal(records.find(record => record.event === 'search.sources').data.sources.length, 1);
  assert.deepEqual(records.map(record => record.event), [
    'selection.started', 'selection.instructions', 'llm.request', 'request.started', 'request.completed', 'llm.response',
    'tool.requested', 'search.started', 'search.llm-request', 'request.started', 'request.completed',
    'search.llm-response', 'search.sources', 'search.result', 'tool.result',
    'llm.request', 'request.started', 'request.completed', 'llm.response', 'tool.requested', 'tool.result', 'problem.accepted',
  ]);
});

test('problem origins preserve project precedence and unchanged writes, without persisting historical guesses', () => {
  const { logger, records } = capture();
  const { createProblemRepository, writeProblem, PROBLEM_BANK_STORAGE_KEY } = load('src/features/interview/storage/problemStorage.ts');
  const storage = memoryStorage();
  const local = { ...sampleProblem, description: 'Old browser record' };
  storage.setItem(PROBLEM_BANK_STORAGE_KEY, JSON.stringify([local]));
  writeProblem(storage, local);
  const repository = createProblemRepository(() => storage, { initialProblems: [sampleProblem], logger });
  assert.equal(repository.getOrigin(sampleProblem.sourceUrl), 'project-json');
  repository.write(sampleProblem);
  assert.equal(repository.getOrigin(sampleProblem.sourceUrl), 'project-json');
  repository.write({ ...sampleProblem, description: 'New response' });
  assert.equal(repository.getOrigin(sampleProblem.sourceUrl), 'session');
  const restored = createProblemRepository(() => storage, { logger });
  assert.equal(restored.getOrigin(sampleProblem.sourceUrl), 'local-storage');
  assert.ok(records.some(record => record.event === 'problem.restored' && record.data.source === 'local-storage'));
});

test('session logs stored selection, rejection, superseded work and retry without invoking an agent', async () => {
  const { logger, records } = capture();
  const { createProblemRepository } = load('src/features/interview/storage/problemStorage.ts');
  const { InterviewSession } = load('src/features/interview/session/InterviewSession.ts');
  const { createProblemSelector } = load('src/features/interview/selection/createProblemSelector.ts');
  const connections = [];
  const audioResume = deferred();
  const session = new InterviewSession({ logger,
    formatDiscussionMessage,
    judgment: { isRunning: () => false, cancel() {}, run: async () => assert.fail('Unexpected grading') },
    selection: createProblemSelector({
      problems: createProblemRepository(() => memoryStorage(), { initialProblems: [sampleProblem], logger }),
      thinking: { getModel: () => assert.fail('No model lookup') },
      loadInstructions: () => assert.fail('No instruction load'), selectProblem: () => assert.fail('No agent call'),
    }),
    createAudio: () => ({ resume: () => audioResume.promise, close() {}, stopMicrophone: () => false }),
    createTransport: (live, problem, events) => { connections.push(events); return { close() {} }; },
    clock: { setTimeout: () => 1, clearTimeout() {} },
  });
  const stored = { ...config, problemSource: 'stored' };
  const first = session.connect(stored);
  await session.connect(stored);
  session.disconnect(); audioResume.resolve(); await first;
  await session.connect(stored);
  const selected = records.find(record => record.event === 'problem.loaded');
  assert.equal(selected.data.source, 'stored-bank');
  assert.equal(selected.data.origin, 'project-json');
  assert.ok(records.some(record => record.event === 'session.start-rejected' && record.data.reason === 'startup-or-transport-already-active'));
  assert.ok(records.some(record => record.event === 'session.stale-operation'));
  connections[0].error(`Denied ${config.live.credential} ${config.thinking.apiKey}`);
  await session.retry(config);
  assert.ok(records.some(record => record.event === 'problem.reused' && record.data.reason === 'interviewer-retry'));
  const output = JSON.stringify(records);
  assert.ok(!output.includes(config.live.credential));
  assert.ok(!output.includes(config.thinking.apiKey));
  session.disconnect();
});

test('editor logs storage failure and recovery without logging code or each edit', () => {
  const { logger, records } = capture();
  const storage = memoryStorage();
  let state;
  const react = { useEffect() {}, useRef: initial => ({ current: initial }),
    useState(initial) { state ??= initial(); return [state, next => { state = next; }]; } };
  const hook = load('src/features/editor/hooks/useEditorDocument.web.ts', { window: { localStorage: storage } }, {
    react, '../../../shared/logger': { logger },
  }).default;
  hook(true).setText('private code');
  const write = storage.setItem;
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  hook(true).setText('more private code'); hook(true).setText('repeat private code');
  storage.setItem = write;
  hook(true).setText('recovered code');
  assert.equal(records.filter(record => record.event === 'editor.storage-unavailable').length, 1);
  assert.equal(records.filter(record => record.event === 'editor.storage-recovered').length, 1);
  assert.ok(!JSON.stringify(records).includes('private code'));
});

test('settings logs blocked and successful saves using credential presence without exposing values', () => {
  const { logger, records } = capture();
  const react = { useState: value => [value, () => {}] };
  const hook = load('src/features/settings/hooks/useSettingsDraft.ts', {}, { react, '../../../shared/logger': { logger } }).default;
  hook(config, true, () => assert.fail('Locked save')).save();
  let saved = false;
  hook(config, false, () => { saved = true; }).save();
  assert.equal(saved, true);
  assert.ok(records.some(record => record.event === 'settings.save-rejected' && record.data.reason === 'session-active'));
  const record = records.find(record => record.event === 'settings.saved');
  assert.equal(record.data.liveCredentialPresent, true);
  assert.ok(!JSON.stringify(records).includes(config.live.credential));
  assert.ok(!JSON.stringify(records).includes(config.thinking.apiKey));
});

test('logger sink failures cannot change selection acceptance', async () => {
  const { createLogger } = load('src/shared/logger.ts');
  const logger = createLogger({ enabled: true, sink() { throw new Error('Broken diagnostic sink'); } });
  const select = selector(fakeClock(true).globals);
  const provider = scriptedProvider([submission()]);
  const model = testRuntime({}, { google: provider.factory }).getModel(config.thinking);
  assert.deepEqual(plain(await select(model, 'Instructions',
    new AbortController().signal, logger)), sampleProblem);
});

test('managed-provider failures are traced and redacted before propagating', async () => {
  const { logger, records } = capture();
  const select = selector(fakeClock(true).globals);
  const provider = scriptedProvider([new Error(`Rejected ${config.thinking.apiKey}`)]);
  const model = testRuntime({}, { google: provider.factory }).getModel(config.thinking);
  await assert.rejects(select(model, 'Instructions', new AbortController().signal, logger), /Rejected/);
  const failed = records.find(record => record.event === 'selection.failed');
  assert.ok(failed);
  assert.equal(failed.data.error.message, 'Rejected [redacted]');
});
