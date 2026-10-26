const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { plain, sampleProblem, config, memoryStorage } = require('./helpers/fixtures.cjs');

test('problem validation, formatting, and session storage round-trip', () => {
  const { validateProblem, formatProblem } = load('src/features/interview/model/problem.ts');
  const { readProblem, writeProblem, PROBLEM_STORAGE_KEY } = load('src/features/interview/storage/problemStorage.ts');
  for (const changes of [{ title: '' }, { description: '' }, { sourceUrl: 'javascript:alert(1)' }, { examples: [] }, { examples: [{ input: '', output: '1' }] }, { constraints: [] }, { constraints: [''] }]) {
    assert.throws(() => validateProblem({ ...sampleProblem, ...changes }));
  }
  const storage = memoryStorage();
  writeProblem(storage, sampleProblem);
  assert.deepEqual(plain(readProblem(storage)), sampleProblem);
  const formatted = formatProblem(readProblem(storage));
  for (const text of ['Pair sum', 'Description', 'Examples', 'Example 1', 'Input:', 'Output:', 'Explanation:', 'Constraints', '- 2 <= n']) assert.ok(formatted.includes(text));
  storage.setItem(PROBLEM_STORAGE_KEY, '{broken');
  assert.equal(readProblem(storage), null);
  storage.setItem(PROBLEM_STORAGE_KEY, '{}');
  assert.equal(readProblem(storage), null);
});


test('configuration has exact dropdown options and independent session defaults', () => {
  const settings = load('src/shared/apiConfig.ts');
  assert.deepEqual(plain(settings.LIVE_MODELS).map(({ label, value }) => ({ label, value })), [
    { label: 'Gemini 3.8 Live Extended Thinking', value: 'gemini-3.8-live-extended-thinking' },
    { label: 'Gemini 3.8 Live', value: 'gemini-3.8-live' },
  ]);
  assert.deepEqual(plain(settings.THINKING_MODELS).map(option => option.value), ['gemini-3.8-flash', 'antigravity-preview-09-2026']);
  const first = settings.defaultApiConfig(), second = settings.defaultApiConfig();
  first.live.credential = 'one';
  assert.equal(second.live.credential, '');
  assert.equal(second.live.model, 'gemini-3.8-live-extended-thinking');
  assert.equal(second.live.thinkingEffort, 'medium');
  assert.equal(second.thinking.apiKey, '');
  assert.equal(second.thinking.model, 'gemini-3.8-flash');
  assert.equal(second.problemSearchDescription, '');
  assert.equal('requestsPerMinute' in second.thinking, false);
  assert.equal(settings.validSettingsModels(second), true); // Partial settings can be saved.
  assert.equal(settings.validSettingsModels({ ...config, thinking: { ...config.thinking, model: 'gemini-3.1-pro-preview' } }), false);
  assert.equal(settings.liveConfigured(second.live), false);
  assert.equal(settings.thinkingConfigured({ ...config.thinking, apiKey: 'auth_tokens/token' }), false);
  assert.equal(settings.validSettingsModels({ ...config, live: { ...config.live, model: 'custom' } }), false);
  const trimmed = settings.trimApiConfig({ ...config, live: { ...config.live, credential: ' live ' }, thinking: { ...config.thinking, apiKey: ' thinking ' } });
  assert.equal(trimmed.live.credential, 'live');
  assert.equal(trimmed.thinking.apiKey, 'thinking');
  assert.equal(settings.trimApiConfig({ ...config, problemSearchDescription: '  Graphs\n最短路徑  ' }).problemSearchDescription, 'Graphs\n最短路徑');
  assert.equal('requestsPerMinute' in trimmed.thinking, false);
  assert.equal('requestsPerMinute' in settings.trimApiConfig({ ...config, thinking: { ...config.thinking, requestsPerMinute: 0 } }).thinking, false);
});

test('model effort metadata supports different option lists and model-specific defaults', () => {
  const { LIVE_MODELS, resolveThinkingEffort, normalizeLiveConfig } = load('src/shared/apiConfig.ts');
  assert.deepEqual(plain(LIVE_MODELS[0].thinkingEffort), {
    options: [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }],
    defaultValue: 'medium',
  });
  const future = { label: 'Future', value: 'future-model', thinkingEffort: {
    options: [{ label: 'Quick', value: 'quick' }, { label: 'Deep', value: 'deep' }], defaultValue: 'quick',
  } };
  assert.equal(resolveThinkingEffort(future, 'deep'), 'deep');
  assert.equal(resolveThinkingEffort(future, 'medium'), 'quick');
  assert.equal(resolveThinkingEffort(future, undefined), 'quick');
  assert.equal(resolveThinkingEffort(LIVE_MODELS[1], 'high'), undefined);
  const old = { credential: 'key', model: LIVE_MODELS[0].value };
  assert.equal(normalizeLiveConfig(old).thinkingEffort, 'medium');
  assert.equal(normalizeLiveConfig({ ...old, thinkingEffort: 'invalid' }).thinkingEffort, 'medium');
  assert.equal(normalizeLiveConfig({ ...old, model: LIVE_MODELS[1].value, thinkingEffort: 'high' }).thinkingEffort, undefined);
});


test('submission tool shares storage validation, trims text, and permits an omitted explanation', async () => {
  const { problemSchema, validateProblem } = load('src/features/interview/model/problem.ts');
  let accepted;
  const tools = load('src/features/interview/agents/selection/tools.ts').createSubmissionTools(problem => { accepted = problem; });
  const submit = tools.find(tool => tool.name === 'submit_problem');
  const padded = { ...sampleProblem, title: '  Pair sum  ', sourceUrl: ` ${sampleProblem.sourceUrl} `,
    description: ` ${sampleProblem.description} `, examples: [{ input: ' [2,7] ', output: ' [0,1] ' }], constraints: [' 2 <= n <= 1000 '] };
  await submit.invoke(padded);
  assert.deepEqual(plain(accepted), plain(validateProblem(padded)));
  assert.equal(accepted.title, 'Pair sum');
  assert.equal(accepted.examples[0].explanation, undefined);
  assert.equal(accepted.examples[0].input, '[2,7]');
  assert.equal(accepted.constraints[0], '2 <= n <= 1000');
  assert.equal(problemSchema.safeParse({ ...sampleProblem, sourceUrl: 'ftp://example.test/problem' }).success, false);
  await assert.rejects(submit.invoke({ ...sampleProblem, sourceUrl: 'ftp://example.test/problem' }), /HTTP\(S\)/);
});

test('problem schema preserves the public validation messages and their priority', () => {
  const { validateProblem } = load('src/features/interview/model/problem.ts');
  for (const [value, message] of [
    [null, 'Submit a structured problem.'],
    [{}, 'sourceUrl must be nonempty text.'],
    [{ ...sampleProblem, sourceUrl: 'bad-url', examples: [] }, 'sourceUrl must be an HTTP(S) URL.'],
    [{ ...sampleProblem, title: '', examples: [] }, 'Provide at least one example.'],
    [{ ...sampleProblem, title: '', constraints: [] }, 'Provide at least one constraint.'],
    [{ ...sampleProblem, examples: [null] }, 'Each example must have input and output.'],
    [{ ...sampleProblem, examples: [{ input: '', output: '1' }] }, 'example input must be nonempty text.'],
    [{ ...sampleProblem, examples: [{ input: '1', output: '1', explanation: '' }] }, 'example explanation must be nonempty text.'],
    [{ ...sampleProblem, constraints: [''] }, 'constraint must be nonempty text.'],
  ]) assert.throws(() => validateProblem(value), { message });
});
