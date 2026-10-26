import { resolveThinkingConfig, type ModelFactoryId } from '../../../shared/apiConfig';
import { logger as appLogger } from '../../../shared/logger';
import type { ThinkingModel, ThinkingModelFactory, ThinkingRuntime } from './types';

export function createThinkingRuntime(factories: Partial<Record<ModelFactoryId, ThinkingModelFactory>>): ThinkingRuntime {
  const models = new Map<string, { apiKey: string; model: ThinkingModel }>();
  return {
    getModel(requested) {
      const { config, entry } = resolveThinkingConfig(requested);
      const factory = factories[entry.modelFactory];
      if (!factory) throw new Error(`Unsupported thinking model factory: ${entry.modelFactory}`);
      const key = `${entry.provider}:${entry.value}`;
      let state = models.get(key);
      if (!state || state.apiKey !== config.apiKey) {
        state = { apiKey: config.apiKey, model: {
          ...factory(config), modelId: entry.value, provider: entry.provider,
          getLogger: (logger = appLogger) => logger.child({ model: entry.value, provider: entry.provider }, [config.apiKey]),
        } };
        models.set(key, state);
      }
      return state.model;
    },
  };
}
