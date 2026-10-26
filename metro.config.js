const { getDefaultConfig } = require('expo/metro-config');
const { join } = require('node:path');
const { loadProjectQuestions } = require('./scripts/loadProjectQuestions.cjs');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = config.resolver.assetExts.filter(extension => extension !== 'md');
config.resolver.sourceExts.push('md');
config.transformer.babelTransformerPath = require.resolve('./scripts/markdownTransformer.cjs');
loadProjectQuestions(__dirname);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // LangSmith's ESM Client -> env -> index -> Client cycle exposes an
  // uninitialized export to Metro Fast Refresh. Its CommonJS build initializes
  // exports before loading dependencies and works with the refresh runtime.
  const resolution = context.resolveRequest(
    moduleName === 'langsmith' || moduleName.startsWith('langsmith/')
      ? { ...context, isESMImport: false, unstable_conditionNames: ['require'] }
      : context,
    moduleName,
    platform,
  );

  // LangSmith's browser map lists only .js files. Apply the same browser
  // replacements to its .cjs build so Node filesystem/worker modules stay out.
  if (resolution.type === 'sourceFile') {
    // LangChain's universal loader uses import(variable), which Metro rejects.
    // Agents receive constructed models from our factories, so this unused
    // model-name loader can fail explicitly without bundling optional providers.
    if (/\/langchain\/dist\/chat_models\/universal\.(?:js|cjs)$/.test(resolution.filePath)) {
      resolution.filePath = join(__dirname, 'src/features/interview/adapters/models/modelLoader.web.ts');
    }
    resolution.filePath = resolution.filePath.replace(
      /(\/langsmith\/dist\/utils\/(?:fs|worker_threads))\.cjs$/,
      '$1.browser.cjs',
    );
  }
  return resolution;
};

module.exports = config;
