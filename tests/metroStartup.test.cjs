const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { runBuild } = require('metro');
const config = require('../metro.config');
const { loadProjectQuestions } = require('../scripts/loadProjectQuestions.cjs');
const { sampleProblem, ScriptedChatModel, submission } = require('./helpers/fixtures.cjs');
const load = require('./helpers/loadTypeScript.cjs');

async function main() {
  config.maxWorkers = 2;
  // Bundle the real native entrypoint, including Expo's runtime and root
  // registration, using the project's normal dependency resolver and prelude.
  for (const platform of ['ios', 'android']) {
    for (const dev of [true, false]) {
      const { code } = await runBuild(config, {
        entry: path.resolve(__dirname, '../index.ts'), platform, dev, minify: !dev,
      });
      assert.ok(code.length > 0, `${platform} ${dev ? 'development' : 'production'} bundle must be emitted`);
      console.log(`Complete ${platform} entrypoint bundles successfully in ${dev ? 'development' : 'production'}.`);
    }
  }
  // Exercise the web session, selector, and Google adapter without mounting UI.
  config.serializer.getModulesRunBeforeMainModule = () => [];
  const { code } = await runBuild(config, {
    entry: path.resolve(__dirname, '../src/features/interview/hooks/useInterviewSession.web.ts'),
    platform: 'web',
    dev: true,
    minify: false,
  });

  let registeredExports = 0;
  const context = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal,
    fetch, Headers, Request, Response, ReadableStream, WritableStream, TransformStream,
    crypto: webcrypto,
    process: { env: {} },
    // Metro reads every module export when registering it for Fast Refresh.
    // This reproduces the Client initialization error that production misses.
    __ReactRefresh: {
      register() { registeredExports++; },
      isLikelyComponentType() { return false; },
      getFamilyByType() {},
      createSignatureFunctionForTransform() { return type => type; },
    },
  };
  context.global = context;
  vm.runInNewContext(code, context, { filename: 'metro-startup.js', timeout: 10000 });
  assert.ok(registeredExports > 0, 'Fast Refresh must exercise module exports');
  console.log('Web interview dependencies load successfully with Metro Fast Refresh enabled.');

  // Run an actual bundled agent to verify the model-instance path bypasses the
  // unsupported dynamic provider loader, including middleware and tool dispatch.
  const { code: agentCode } = await runBuild(config, {
    entry: path.resolve(__dirname, '../src/features/interview/agents/selection/selectionAgent.ts'),
    platform: 'web', dev: true, minify: false,
  });
  const agentContext = { ...context };
  agentContext.global = agentContext;
  vm.runInNewContext(agentCode, agentContext, { filename: 'metro-task-agent.js', timeout: 10000 });
  const calls = [];
  const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const selected = await agentContext.__r(0).runSelectionAgent({
    llm: new ScriptedChatModel([submission()], calls),
    capabilities: { structuredOutput: false, modelRetry: true, statefulContinuation: false },
    getLogger: () => quietLogger,
  }, 'Select a verified problem.', { signal: new AbortController().signal, logger: quietLogger });
  assert.deepEqual(JSON.parse(JSON.stringify(selected)), sampleProblem);
  assert.equal(calls.length, 1);
  console.log('Bundled LangChain task agent accepts its first submission without another model call.');

  // Import the real Markdown sources through Metro in both modes and compare
  // their rendered exports with the Node test loader, without network access.
  for (const feature of ['selection', 'judgment', 'interviewer']) {
    const entry = `src/features/interview/agents/${feature}/prompts.ts`;
    const expected = load(entry);
    for (const dev of [true, false]) {
      const { code: promptCode } = await runBuild(config, {
        entry: path.resolve(__dirname, '..', entry), platform: 'web', dev, minify: false,
      });
      const promptContext = { ...context };
      promptContext.global = promptContext;
      vm.runInNewContext(promptCode, promptContext, { filename: `metro-${feature}-prompts.js`, timeout: 10000 });
      const actual = promptContext.__r(0);
      if (feature === 'selection') {
        assert.equal(actual.SELECTION_INSTRUCTIONS, expected.SELECTION_INSTRUCTIONS);
        assert.equal(actual.SEARCH_SYSTEM_PROMPT, expected.SEARCH_SYSTEM_PROMPT);
        for (const mode of ['client-search', 'server-search']) {
          assert.equal(actual.selectionSystemPrompt('Custom rules: 題目\n{{literal}}', mode),
            expected.selectionSystemPrompt('Custom rules: 題目\n{{literal}}', mode));
        }
      } else if (feature === 'judgment') {
        for (const kind of ['code', 'interview']) assert.equal(actual.judgmentPrompt({ kind }), expected.judgmentPrompt({ kind }));
      } else assert.equal(actual.INTERVIEW_INSTRUCTION, expected.INTERVIEW_INSTRUCTION);
    }
  }
  console.log('All Markdown prompts survive development and production Metro bundling.');

  // Check the actual Expo environment transport with nonempty data, without
  // editing the user's question database. Unicode and newlines must survive.
  const fixture = { ...sampleProblem, description: 'Bundle fixture: 題目\nKeep this second line.' };
  const previousQuestions = process.env.EXPO_PUBLIC_PROJECT_QUESTIONS;
  const previousWarning = process.env.EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING;
  try {
    loadProjectQuestions('/fixture-project', process.env, () => JSON.stringify([fixture]));
    for (const dev of [true, false]) {
      const { code: questionCode } = await runBuild(config, {
        entry: path.resolve(__dirname, '../src/features/interview/adapters/projectQuestions.web.ts'),
        platform: 'web', dev, minify: false,
      });
      const questionContext = { ...context, process: { env: {} } };
      questionContext.global = questionContext;
      vm.runInNewContext(questionCode, questionContext, { filename: 'metro-question-database.js', timeout: 10000 });
      const imported = questionContext.__r(0).loadProjectQuestions();
      assert.deepEqual(JSON.parse(JSON.stringify(imported)), { problems: [fixture], warning: '' });
    }
  } finally {
    if (previousQuestions === undefined) delete process.env.EXPO_PUBLIC_PROJECT_QUESTIONS;
    else process.env.EXPO_PUBLIC_PROJECT_QUESTIONS = previousQuestions;
    if (previousWarning === undefined) delete process.env.EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING;
    else process.env.EXPO_PUBLIC_PROJECT_QUESTIONS_WARNING = previousWarning;
  }
  console.log('Question database survives development and production Metro bundling.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
