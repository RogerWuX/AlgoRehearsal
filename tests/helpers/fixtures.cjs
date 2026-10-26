const load = require('./loadTypeScript.cjs');
const { formatDiscussionMessage } = load('src/features/interview/agents/interviewer/prompts.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const sampleProblem = { title: 'Pair sum', sourceUrl: 'https://example.test/problems/pair-sum', description: 'Return two indices whose values sum to the target.', examples: [{ input: '[2,7], target=9', output: '[0,1]', explanation: '2 + 7 = 9' }], constraints: ['2 <= n <= 1000'] };
const config = { ...load('src/shared/apiConfig.ts').defaultApiConfig(), live: { credential: 'live-key', model: 'gemini-3.8-live' }, thinking: { provider: 'google', apiKey: 'thinking-key', model: 'gemini-3.8-flash' } };
function memoryStorage() {
  const items = new Map();
  return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) };
}
const messages = require('@langchain/core/messages');
const Message = messages.AIMessage;
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');

// Run the real LangChain graph and tools while replacing only the network model.
class ScriptedChatModel extends BaseChatModel {
  constructor(responses = [], calls = [], profile = {}) {
    super({ maxRetries: 0 });
    this.responses = responses; this.calls = calls; this.modelProfile = profile;
  }
  _llmType() { return 'scripted-interview-model'; }
  get profile() { return this.modelProfile; }
  bindTools(tools, options = {}) { this.boundTools = tools; return this.withConfig({ ...options, tools }); }
  async _generate(history, options) {
    this.calls.push({ history: [...history], options, tools: options.tools });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    const result = typeof next === 'function' ? await next(history, options) : next;
    if (!result) throw new Error('No scripted model response.');
    return { generations: [{ message: result, text: result.text }] };
  }
}
function fakeClock(automatic = false) {
  let now = 0;
  const pending = new Map(), scheduled = [];
  const globals = {
    Date: { now: () => now },
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, at: now + ms };
      pending.set(timer, timer);
      scheduled.push(timer);
      if (automatic) queueMicrotask(() => {
        if (!pending.delete(timer)) return;
        now = Math.max(now, timer.at);
        callback();
      });
      return timer;
    },
    clearTimeout: timer => { pending.delete(timer); },
  };
  return {
    globals, scheduled,
    get now() { return now; },
    get pendingCount() { return pending.size; },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...pending.values()].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > target) break;
        now = next.at;
        pending.delete(next);
        next.callback();
      }
      now = target;
    },
  };
}
function modelDefinition(llm, search) {
  return { llm, ...(search ? { search } : {}), capabilities: {
    structuredOutput: !!llm.profile?.structuredOutput, modelRetry: true, statefulContinuation: false,
  } };
}
function thinkingModel(llm, search) {
  const logger = load('src/shared/logger.ts').logger;
  return { ...modelDefinition(llm, search), modelId: config.thinking.model, provider: config.thinking.provider,
    getLogger: (requested = logger) => requested };
}
function testRuntime(globals, factories) {
  return load('src/features/interview/llm/runtime.ts', globals).createThinkingRuntime(factories);
}
function selector(globals = fakeClock(true).globals) {
  return load('src/features/interview/agents/selection/selectProblem.ts', globals, {
    '@langchain/core/messages': messages,
  }).selectProblem;
}
function scriptedProvider(responses, search = async () => ({ text: 'Verified problem', sources: [{ title: 'Problem', url: sampleProblem.sourceUrl }] })) {
  const calls = [];
  const configurations = [];
  const llm = new ScriptedChatModel(responses, calls);
  const factory = configuration => {
    configurations.push(plain(configuration));
    return modelDefinition(llm, (query, _prompt, context) => search(query, context.signal));
  };
  return { factory, calls, configurations, get tools() { return llm.boundTools; } };
}

function judgeWithProvider(globals = {}, dependencies = {}) {
  const runtime = load('src/features/interview/adapters/thinkingModels.ts', globals, dependencies).createThinkingRuntime();
  const judge = load('src/features/interview/agents/judgment/judgeSubmission.ts', globals, {
    '@langchain/core/messages': messages, ...dependencies,
  }).judgeSubmission;
  return (config, request, signal, logger) => judge(runtime.getModel(config), request, signal, logger);
}
const toolCall = (id, name, args) => ({ id, name, args, type: 'tool_call' });
const reply = (...calls) => new Message({ content: '', tool_calls: calls });
const submission = () => reply(toolCall('submit', 'submit_problem', sampleProblem));

function assessment(kind) {
  const perspectives = kind === 'code' ? ['Correctness', 'Time and space complexity', 'Code quality', 'Edge cases and testing']
    : ['Problem understanding', 'Algorithmic reasoning', 'Communication', 'Testing discussion', 'Complexity and tradeoffs'];
  return { summary: `${kind} feedback`, perspectives: perspectives.map(perspective => ({ perspective, feedback: 'Concrete evidence and a suggested improvement.' })), strengths: ['A clear approach.'], improvements: ['Discuss boundary inputs.'] };
}

function harness({ fetch = async () => { throw new Error('Unexpected fetch'); }, loadInstructions, storage = memoryStorage(), interviewState, clocks = {}, select = async () => sampleProblem, audioFactory, transportFactory, adapterFactory, judge = async (_config, request) => assessment(request.kind), logger } = {}) {
  const liveSessions = [], contexts = [], selections = [], judgments = [];
  class AudioContext {
    constructor({ sampleRate }) { this.closed = false; this.sampleRate = sampleRate; this.destination = {}; contexts.push(this); }
    async resume() {}
    async close() { this.closed = true; }
    createScriptProcessor() { return { connect() {}, disconnect() {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class LiveSession {
    constructor(options, parameters, pending) {
      this.options = options; this.parameters = parameters; this.pending = pending;
      this.sent = []; this.closed = false;
    }
    send(message) { if (this.closed) throw new Error('Session closed'); this.sent.push(plain(message)); }
    sendClientContent(parameters) { this.send({ clientContent: parameters }); }
    sendRealtimeInput(parameters) { this.send({ realtimeInput: parameters }); }
    sendToolResponse(parameters) { this.send({ toolResponse: parameters }); }
    close() { this.closed = true; this.parameters.callbacks.onclose({ code: 1000 }); }
    async receive(message) {
      this.parameters.callbacks.onmessage(message);
      if (message.setupComplete) this.pending.resolve(this);
      await flush();
    }
    fail() { this.parameters.callbacks.onerror(new Error('SDK connection failed')); }
  }
  class GoogleGenAI {
    constructor(options) {
      this.live = { connect: parameters => {
        const pending = deferred();
        const session = new LiveSession(options, parameters, pending);
        liveSessions.push(session);
        return pending.promise;
      } };
    }
  }
  const globals = { AudioContext, fetch,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } }, ...clocks };
  const { createLiveTransport } = load('src/features/interview/adapters/liveTransport.web.ts', globals, {
    '@google/genai/web': { GoogleGenAI, Modality: { AUDIO: 'AUDIO' }, ThinkingLevel: { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' } },
  });
  const { BrowserAudio } = load('src/features/interview/adapters/audio/browserAudio.web.ts', globals);
  const { createInterviewerFactory } = load('src/features/interview/agents/interviewer/createInterviewer.ts', globals);
  const { loadSelectionInstructions } = load('src/features/interview/agents/selection/loadSelectionInstructions.ts', globals);
  const { createProblemRepository } = load('src/features/interview/storage/problemStorage.ts');
  const { createProblemSelector } = load('src/features/interview/selection/createProblemSelector.ts', globals);
  const { createJudgmentWorkflow } = load('src/features/interview/judgment/createJudgmentWorkflow.ts', globals);
  const { InterviewSession } = load('src/features/interview/session/InterviewSession.ts', globals);
  const clientConfigs = new WeakMap();
  const factory = configuration => adapterFactory ? adapterFactory(configuration) : modelDefinition(new ScriptedChatModel([]));
  const runtime = testRuntime(globals, { google: factory, antigravity: factory });
  const thinking = { getModel: config => {
    const agents = runtime.getModel(config);
    clientConfigs.set(agents, config);
    return agents;
  } };
  const session = new InterviewSession({
    selection: createProblemSelector({
      problems: createProblemRepository(() => storage), thinking,
      loadInstructions: loadInstructions ?? loadSelectionInstructions,
      selectProblem: async (...args) => { selections.push([clientConfigs.get(args[0]), ...args.slice(1)]); return select(...args); },
    }),
    judgment: createJudgmentWorkflow({
      thinking,
      judge: async (model, request, signal, logger) => {
        const configuration = clientConfigs.get(model);
        const args = [configuration, request, signal, model.getLogger(logger)];
        judgments.push(args);
        const result = await judge(...args);
        signal.throwIfAborted();
        return result;
      },
    }),
    logger,
    interviewState,
    formatDiscussionMessage,
    createTransport: transportFactory ?? createInterviewerFactory(createLiveTransport),
    createAudio: audioFactory ?? (() => new BrowserAudio()),
  });
  return { session, get snapshot() { return session.getSnapshot(); }, liveSessions, contexts, storage, selections, judgments };
}

module.exports = { modelDefinition, thinkingModel, testRuntime, judgeWithProvider, plain, flush, deferred, sampleProblem, config, memoryStorage, Message, messages, ScriptedChatModel, fakeClock, selector, scriptedProvider, toolCall, reply, submission, harness, assessment, formatDiscussionMessage };
