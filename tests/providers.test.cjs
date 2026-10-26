const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { config, ScriptedChatModel, modelDefinition } = require('./helpers/fixtures.cjs');

const bundle = () => modelDefinition(new ScriptedChatModel([]));
const liveRequest = { systemInstruction: 'Supplied instruction', initialTurns: [{ role: 'user', text: 'Supplied opening' }] };

test('Thinking dispatches exact registry models and reuses task agent implementations', async () => {
  const calls = [];
  const { createThinkingRuntime } = load('src/features/interview/adapters/thinkingModels.ts', {}, {
    './models/google': { createGoogleModel: value => { calls.push(['google', value]); return bundle(); } },
    './models/antigravity': { createAntigravityModel: value => { calls.push(['antigravity', value]); return bundle(); } },
  });
  const runtime = createThinkingRuntime();
  for (const model of ['gemini-3.8-flash', ' gemini-3.8-flash ']) {
    const agents = runtime.getModel({ ...config.thinking, model });
    assert.ok(agents.llm instanceof ScriptedChatModel);
    assert.equal(typeof agents.getLogger, 'function');
    assert.equal(calls.at(-1)[0], 'google');
  }
  runtime.getModel({ ...config.thinking, model: ' antigravity-preview-09-2026 ' });
  assert.equal(calls.at(-1)[0], 'antigravity');
  for (const model of ['', 'other-model', 'gemini-unknown', 'gemini-3.7-flash', config.live.model, 'antigravity-preview-other']) {
    assert.throws(() => runtime.getModel({ ...config.thinking, model }), /Unsupported thinking model/);
  }
  assert.throws(() => runtime.getModel({ ...config.thinking, provider: 'other' }), /Unsupported thinking provider/);
  assert.equal(calls.length, 2);
});

test('runtime and Live transport reject mismatches before SDK construction', () => {
  let constructions = 0;
  class UnexpectedClient { constructor() { constructions++; throw new Error('Unexpected construction'); } }
  const dependencies = { '@google/genai/web': { GoogleGenAI: UnexpectedClient }, '@langchain/google': { ChatGoogle: UnexpectedClient } };
  const runtime = load('src/features/interview/adapters/thinkingModels.ts', {}, dependencies).createThinkingRuntime();
  const { createGeminiTransport } = load('src/features/interview/adapters/live/gemini/transport.web.ts', {}, dependencies);
  assert.throws(() => runtime.getModel({ ...config.thinking, provider: 'other' }), /Unsupported thinking provider/);
  assert.throws(() => createGeminiTransport({ ...config.live, model: 'other-live-model' }, liveRequest, {}), /Unsupported Live model/);
  for (const model of ['gemini-3.8-flash', 'antigravity-preview-09-2026']) {
    for (const apiKey of ['', 'auth_tokens/live']) assert.throws(() => runtime.getModel({ ...config.thinking, model, apiKey }), /standard thinking API key/);
  }
  assert.equal(constructions, 0);
});

test('Live routes its existing Gemini models independently of thinking agents', () => {
  const calls = [], transport = {};
  const { createLiveTransport } = load('src/features/interview/adapters/liveTransport.web.ts', {}, {
    './live/gemini/transport.web': { createGeminiTransport: (...args) => { calls.push(args); return transport; } },
  });
  for (const model of ['other-live-model', 'gemini-unknown-live', 'gemini-3.8-flash', 'antigravity-preview-09-2026', '']) {
    assert.throws(() => createLiveTransport({ ...config.live, model }, liveRequest, {}), /Unsupported Live model/);
  }
  const live = { ...config.live, model: ' gemini-3.8-live ' }, events = {};
  assert.equal(createLiveTransport(live, liveRequest, events), transport);
  assert.deepEqual(calls, [[live, liveRequest, events, undefined]]);
});

test('standard Google Thinking key restrictions apply only to registered Google models', () => {
  const { thinkingConfigured } = load('src/shared/apiConfig.ts');
  for (const model of ['gemini-3.8-flash', 'antigravity-preview-09-2026']) {
    assert.equal(thinkingConfigured({ ...config.thinking, model, apiKey: 'auth_tokens/token' }), false);
  }
  assert.equal(thinkingConfigured({ provider: 'other', model: 'other-model', apiKey: 'auth_tokens/provider-specific' }), true);
});
