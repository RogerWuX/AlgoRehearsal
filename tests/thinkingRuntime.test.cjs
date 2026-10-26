const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { thinkingModel, modelDefinition } = require('./helpers/fixtures.cjs');
const { selectProblem } = load('src/features/interview/agents/selection/selectProblem.ts');
const { judgeSubmission } = load('src/features/interview/agents/judgment/judgeSubmission.ts');
const { plain, flush, config, sampleProblem, messages, ScriptedChatModel, reply, toolCall, submission, assessment, deferred } = require('./helpers/fixtures.cjs');

const signal = () => new AbortController().signal;
const codeRequest = { kind: 'code', problem: sampleProblem, code: 'solve()', language: 'Python' };
const interviewRequest = { kind: 'interview', problem: sampleProblem, messages: [], discussion: 'Written approach and mindset.' };

test('selection, grounded search and both judges reuse one Google LLM without pacing', async () => {
  const clients = [], calls = [];
  class ChatGoogle extends ScriptedChatModel {
    constructor(options) {
      super([
        reply(toolCall('search', 'search_problem', { query: 'Find pair sum' })),
        new messages.AIMessage({ content: 'Verified problem', response_metadata: { grounding_metadata: {
          groundingChunks: [{ web: { uri: sampleProblem.sourceUrl, title: 'Pair sum' } }],
        } } }),
        submission(),
        new messages.AIMessage(JSON.stringify(assessment('code'))),
        new messages.AIMessage(JSON.stringify(assessment('interview'))),
      ], calls, { structuredOutput: true });
      clients.push(plain(options));
    }
  }
  const runtime = load('src/features/interview/adapters/thinkingModels.ts', {}, { '@langchain/google': { ChatGoogle } }).createThinkingRuntime();
  const model = runtime.getModel(config.thinking);
  assert.deepEqual(plain(await selectProblem(model, 'Rules', signal())), sampleProblem);
  await judgeSubmission(runtime.getModel({ ...config.thinking, apiKey: ' thinking-key ', model: ' gemini-3.8-flash ' }), codeRequest, signal());
  await judgeSubmission(model, interviewRequest, signal());
  assert.equal(calls.length, 5);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0], { apiKey: 'thinking-key', model: 'gemini-3.8-flash', maxRetries: 0 });
  assert.deepEqual(plain(calls[1].tools), [{ googleSearch: {} }]);
  assert.ok(calls[2].history.some(message => message.tool_call_id === 'search' && JSON.parse(message.text).sources[0].url === sampleProblem.sourceUrl));
});

test('real ChatGoogle converts shared agents to selection, grounded search and native judgment requests', async () => {
  const { ChatGoogle: GoogleModel } = require('@langchain/google');
  const bodies = [];
  const candidates = [
    { content: { role: 'model', parts: [{ functionCall: { name: 'search_problem', args: { query: 'Verify pair sum' } } }] } },
    { content: { role: 'model', parts: [{ text: 'Verified problem' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: sampleProblem.sourceUrl, title: 'Pair sum' } }] } },
    { content: { role: 'model', parts: [{ functionCall: { name: 'submit_problem', args: sampleProblem } }] } },
    { content: { role: 'model', parts: [{ text: JSON.stringify(assessment('code')) }] } },
    { content: { role: 'model', parts: [{ text: JSON.stringify(assessment('interview')) }] } },
  ];
  class ChatGoogle extends GoogleModel {
    constructor(options) {
      super({ ...options, apiClient: {
        hasApiKey: () => true,
        async fetch(request) {
          const candidate = candidates[bodies.length];
          assert.ok(candidate, 'No extra model requests');
          bodies.push(await request.json());
          return Response.json({ candidates: [{ ...candidate, finishReason: 'STOP' }] });
        },
      } });
    }
    // Model metadata controls native output selection; exercise that path even
    // when the installed catalog does not yet contain the registered model ID.
    get profile() { return { structuredOutput: true }; }
  }
  const model = { ...load('src/features/interview/adapters/models/google.ts', {}, { '@langchain/google': { ChatGoogle } }).createGoogleModel(config.thinking), modelId: config.thinking.model, provider: 'google', getLogger: logger => logger ?? load('src/shared/logger.ts').logger };
  assert.deepEqual(plain(await selectProblem(model, 'Rules', signal())), sampleProblem);
  assert.deepEqual(plain(await judgeSubmission(model, codeRequest, signal())), assessment('code'));
  assert.deepEqual(plain(await judgeSubmission(model, interviewRequest, signal())), assessment('interview'));
  assert.equal(bodies.length, 5);
  assert.deepEqual(bodies[0].tools.flatMap(tool => tool.functionDeclarations?.map(fn => fn.name) ?? []),
    ['search_problem', 'gen_random_number', 'submit_problem']);
  assert.deepEqual(bodies[1].tools, [{ googleSearch: {} }]);
  assert.ok(bodies[2].contents.some(message => message.parts.some(part => part.functionResponse?.name === 'search_problem')));
  for (const index of [3, 4]) {
    assert.equal(bodies[index].generationConfig.responseMimeType, 'application/json');
    assert.ok(bodies[index].generationConfig.responseJsonSchema.properties.perspectives);
    assert.equal(bodies[index].tools, undefined);
  }
  assert.deepEqual(JSON.parse(bodies[3].contents.at(-1).parts[0].text), codeRequest);
  assert.deepEqual(JSON.parse(bodies[4].contents.at(-1).parts[0].text), interviewRequest);
});

test('runtime isolates models, rebuilds after credential changes and strips obsolete RPM', async () => {
  const built = [];
  const factory = configuration => {
    built.push(plain(configuration));
    return modelDefinition(new ScriptedChatModel([]));
  };
  const runtime = load('src/features/interview/llm/runtime.ts').createThinkingRuntime({ google: factory, antigravity: factory });
  runtime.getModel(config.thinking);
  runtime.getModel({ ...config.thinking, requestsPerMinute: -1 });
  runtime.getModel({ ...config.thinking, model: 'antigravity-preview-09-2026' });
  runtime.getModel({ ...config.thinking, apiKey: 'replacement-key' });
  assert.equal(built.length, 3);
  assert.ok(built.every(options => !('requestsPerMinute' in options)));
  assert.equal(built[2].apiKey, 'replacement-key');
});

test('unsupported models, providers and credentials fail before agent construction', () => {
  let constructions = 0;
  const factory = () => { constructions++; throw new Error('Unexpected construction'); };
  const runtime = load('src/features/interview/llm/runtime.ts').createThinkingRuntime({ google: factory });
  for (const change of [{ model: 'gemini-unknown' }, { model: config.live.model }, { provider: 'other' }, { apiKey: '' }, { apiKey: 'auth_tokens/live' }]) {
    assert.throws(() => runtime.getModel({ ...config.thinking, ...change }));
  }
  assert.equal(constructions, 0);
});

test('runtime rejects cancellation promptly and ignores a late task result', async () => {
  const pending = deferred(), controller = new AbortController();
  let started = 0;
  const factory = () => modelDefinition(new ScriptedChatModel([() => { started++; return pending.promise; }]));
  const runtime = load('src/features/interview/llm/runtime.ts').createThinkingRuntime({ google: factory });
  const task = selectProblem(runtime.getModel(config.thinking), 'Rules', controller.signal);
  const rejected = assert.rejects(task, /abort/i);
  await flush(); controller.abort(); await rejected;
  pending.resolve(submission()); await flush();
  assert.equal(started, 1);
  await assert.rejects(async () => selectProblem(runtime.getModel(config.thinking), 'Rules', controller.signal), /abort/i);
  assert.equal(started, 1);
});

test('task state is isolated across concurrent selection runs sharing one LLM', async () => {

  const first = { ...sampleProblem, title: 'First' }, second = { ...sampleProblem, title: 'Second' };
  const llm = new ScriptedChatModel([
    reply(toolCall('same-id', 'submit_problem', first)), reply(toolCall('same-id', 'submit_problem', second)),
  ]);
  const model = thinkingModel(llm, () => assert.fail('Unexpected search'));
  const results = await Promise.all([
    selectProblem(model, 'Rules', signal()), selectProblem(model, 'Rules', signal()),
  ]);
  assert.deepEqual(results.map(result => result.title).sort(), ['First', 'Second']);
});

test('judgment agents support tool-based structured output and reject malformed assessments', async () => {

  const llm = new ScriptedChatModel([
    reply(toolCall('assessment', 'extract-1', assessment('code'))),
  ]);
  // Use the actual bound output-tool name selected by LangChain.
  llm.responses[0] = (_history, options) => reply(toolCall('assessment', options.tools[0].function.name, assessment('code')));
  const model = thinkingModel(llm, () => assert.fail('Unexpected search'));
  assert.deepEqual(plain(await judgeSubmission(model, codeRequest, signal())), assessment('code'));
  const malformed = new ScriptedChatModel([new messages.AIMessage(JSON.stringify({ summary: 'Invalid' }))], [], { structuredOutput: true });
  await assert.rejects(judgeSubmission(thinkingModel(malformed), codeRequest, signal()), /invalid|schema|validation/i);
});

test('judgment agents never log code, discussion, transcript, reports or error payloads', async () => {
  const records = [], calls = [];
  const logger = load('src/shared/logger.ts').createLogger({ enabled: true, sink: record => records.push(record) });

  const llm = new ScriptedChatModel([
    new Error('private code sentinel private transcript sentinel thinking-key'),
    new Error('private discussion sentinel private transcript sentinel thinking-key'),
  ], calls);
  const model = thinkingModel(llm, () => assert.fail('Unexpected search'));
  await assert.rejects(judgeSubmission(model, { ...codeRequest, code: 'private code sentinel' }, signal(), logger));
  await assert.rejects(judgeSubmission(model, { ...interviewRequest, discussion: 'private discussion sentinel' }, signal(), logger));
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify(records), /private code sentinel|private discussion sentinel|private transcript sentinel|thinking-key/);
});
