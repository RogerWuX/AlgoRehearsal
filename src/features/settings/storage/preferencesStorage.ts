import {
  LIVE_MODELS, MODEL_REGISTRY, normalizeLiveConfig,
  type InterviewApiConfig,
} from '../../../shared/apiConfig';
import type { KeyValueStorage } from '../../../shared/storage';

export const SETTINGS_STORAGE_KEY = 'interview-practice.settings';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function readPreferences(storage: Pick<KeyValueStorage, 'getItem'>, defaults: InterviewApiConfig): InterviewApiConfig {
  const raw = storage.getItem(SETTINGS_STORAGE_KEY);
  if (raw === null) return defaults;
  let saved: Record<string, unknown>;
  try {
    saved = record(JSON.parse(raw));
  } catch {
    return defaults;
  }
  const live = record(saved.live), thinking = record(saved.thinking);
  const thinkingModel = MODEL_REGISTRY.find(model => model.capability === 'thinking' && model.value === thinking.model);
  return {
    ...defaults,
    problemSource: saved.problemSource === 'agent' || saved.problemSource === 'stored'
      ? saved.problemSource : defaults.problemSource,
    problemSearchDescription: typeof saved.problemSearchDescription === 'string'
      ? saved.problemSearchDescription.trim() : defaults.problemSearchDescription,
    saveSearchedProblems: typeof saved.saveSearchedProblems === 'boolean' ? saved.saveSearchedProblems : defaults.saveSearchedProblems,
    saveInterviewState: typeof saved.saveInterviewState === 'boolean' ? saved.saveInterviewState : defaults.saveInterviewState,
    rememberApiKeys: typeof saved.rememberApiKeys === 'boolean' ? saved.rememberApiKeys : defaults.rememberApiKeys,
    live: normalizeLiveConfig({
      ...defaults.live,
      model: typeof live.model === 'string' && LIVE_MODELS.some(option => option.value === live.model)
        ? live.model : defaults.live.model,
      thinkingEffort: typeof live.thinkingEffort === 'string' ? live.thinkingEffort : undefined,
    }),
    thinking: {
      ...defaults.thinking,
      provider: thinkingModel?.provider ?? defaults.thinking.provider,
      model: thinkingModel?.value ?? defaults.thinking.model,
    },
  };
}

export function writePreferences(storage: Pick<KeyValueStorage, 'setItem'>, config: InterviewApiConfig): void {
  const live = normalizeLiveConfig(config.live);
  // Explicitly copy preferences so credentials and future config fields never enter storage.
  storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
    problemSource: config.problemSource,
    problemSearchDescription: config.problemSearchDescription.trim(),
    saveSearchedProblems: config.saveSearchedProblems,
    saveInterviewState: config.saveInterviewState,
    rememberApiKeys: config.rememberApiKeys,
    live: { model: live.model, ...(live.thinkingEffort !== undefined ? { thinkingEffort: live.thinkingEffort } : {}) },
    thinking: {
      provider: config.thinking.provider,
      model: config.thinking.model,
    },
  }));
}
