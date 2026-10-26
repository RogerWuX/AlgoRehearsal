export type SelectOption = { label: string; value: string };
export type ModelOption = SelectOption & {
  thinkingEffort?: { options: readonly SelectOption[]; defaultValue: string };
};
export const ANTIGRAVITY_AGENT = 'antigravity-preview-09-2026';

export type ModelCapability = 'live' | 'thinking';
export type ModelFactoryId = 'google' | 'antigravity';
export type SupportedModel = ModelOption & {
  provider: string;
  modelFactory: ModelFactoryId;
  capability: ModelCapability;
  standardKey?: boolean;
};

export const MODEL_REGISTRY: readonly SupportedModel[] = [
  { label: 'Gemini 3.8 Live Extended Thinking', value: 'gemini-3.8-live-extended-thinking',
    provider: 'google', modelFactory: 'google', capability: 'live', thinkingEffort: {
      options: [{ label: 'Low', value: 'low' }, { label: 'Medium', value: 'medium' }, { label: 'High', value: 'high' }],
      defaultValue: 'medium',
    } },
  { label: 'Gemini 3.8 Live', value: 'gemini-3.8-live', provider: 'google', modelFactory: 'google', capability: 'live' },
  { label: 'Gemini 3.8 Flash', value: 'gemini-3.8-flash', provider: 'google', modelFactory: 'google', capability: 'thinking', standardKey: true },
  { label: 'Antigravity (Preview)', value: ANTIGRAVITY_AGENT, provider: 'google', modelFactory: 'antigravity', capability: 'thinking', standardKey: true },
];

function modelOptions(capability: ModelCapability): readonly ModelOption[] {
  return MODEL_REGISTRY.filter(model => model.capability === capability)
    .map(({ label, value, thinkingEffort }) => ({ label, value, ...(thinkingEffort ? { thinkingEffort } : {}) }));
}

export const LIVE_MODELS = modelOptions('live');
export const THINKING_MODELS = modelOptions('thinking');

export function resolveSupportedModel(model: string, capability: ModelCapability, provider?: string): SupportedModel {
  const supported = MODEL_REGISTRY.find(entry => entry.value === model.trim() && entry.capability === capability);
  if (!supported) throw new Error(`Unsupported ${capability === 'live' ? 'Live' : 'thinking'} model: ${model.trim()}`);
  if (provider !== undefined && supported.provider !== provider.trim()) {
    throw new Error(`Unsupported thinking provider: ${provider.trim()} for model ${supported.value}`);
  }
  return supported;
}

export type LiveConfig = { credential: string; model: string; thinkingEffort?: string };
export type ThinkingConfig = { provider: string; apiKey: string; model: string };
export type ProblemSource = 'agent' | 'stored';
export type InterviewApiConfig = { live: LiveConfig; thinking: ThinkingConfig; problemSource: ProblemSource; problemSearchDescription: string; saveSearchedProblems: boolean; saveInterviewState: boolean; rememberApiKeys: boolean };

export function resolveThinkingEffort(model: ModelOption | undefined, requested: unknown): string | undefined {
  const effort = model?.thinkingEffort;
  if (!effort?.options.length) return undefined;
  return typeof requested === 'string' && effort.options.some(option => option.value === requested)
    ? requested : effort.defaultValue;
}

export function normalizeLiveConfig(config: LiveConfig): LiveConfig {
  const { thinkingEffort: requested, ...live } = config;
  const model = config.model.trim();
  const thinkingEffort = resolveThinkingEffort(LIVE_MODELS.find(option => option.value === model), requested);
  return { ...live, model,
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}) };
}

export function requiresStandardThinkingKey(config: ThinkingConfig): boolean {
  return MODEL_REGISTRY.some(model => model.value === config.model.trim() && model.capability === 'thinking'
    && model.provider === config.provider.trim() && model.standardKey);
}

export type ResolvedThinkingConfig = ThinkingConfig;

export function resolveThinkingConfig(config: ThinkingConfig): { config: ResolvedThinkingConfig; entry: SupportedModel } {
  const entry = resolveSupportedModel(config.model, 'thinking', config.provider);
  const apiKey = config.apiKey.trim();
  if (!apiKey || (entry.standardKey && apiKey.startsWith('auth_tokens/'))) {
    throw new Error('Enter a standard thinking API key and model.');
  }
  return { entry, config: { provider: entry.provider, model: entry.value, apiKey } };
}

export function validateThinkingConfig(config: ThinkingConfig): ResolvedThinkingConfig {
  return resolveThinkingConfig(config).config;
}

export function defaultApiConfig(): InterviewApiConfig {
  return {
    problemSource: 'agent',
    problemSearchDescription: '',
    saveSearchedProblems: false,
    saveInterviewState: false,
    rememberApiKeys: false,
    live: normalizeLiveConfig({ credential: '', model: LIVE_MODELS[0].value }),
    thinking: { provider: resolveSupportedModel(THINKING_MODELS[0].value, 'thinking').provider, apiKey: '', model: THINKING_MODELS[0].value },
  };
}

export function trimApiConfig(config: InterviewApiConfig): InterviewApiConfig {
  return {
    problemSource: config.problemSource,
    problemSearchDescription: config.problemSearchDescription.trim(),
    saveSearchedProblems: config.saveSearchedProblems,
    saveInterviewState: config.saveInterviewState,
    rememberApiKeys: config.rememberApiKeys,
    live: normalizeLiveConfig({ ...config.live, credential: config.live.credential.trim() }),
    thinking: { provider: config.thinking.provider.trim(), apiKey: config.thinking.apiKey.trim(), model: config.thinking.model.trim() },
  };
}

export function validSettingsModels(config: InterviewApiConfig): boolean {
  return LIVE_MODELS.some(option => option.value === config.live.model)
    && MODEL_REGISTRY.some(model => model.value === config.thinking.model && model.capability === 'thinking'
      && model.provider === config.thinking.provider);
}

export function liveConfigured(config: LiveConfig): boolean {
  return !!config.credential.trim() && !!config.model.trim();
}

export function thinkingConfigured(config: ThinkingConfig): boolean {
  return !!config.apiKey.trim() && !(requiresStandardThinkingKey(config) && config.apiKey.trim().startsWith('auth_tokens/'))
    && !!config.model.trim() && !!config.provider.trim();
}
