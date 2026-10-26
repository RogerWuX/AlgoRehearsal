import type { InterviewApiConfig } from '../../../shared/apiConfig';

export const CREDENTIALS_STORAGE_KEY = 'interview-practice.api-keys';
type CredentialStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function restoreCredentials(storage: Pick<CredentialStorage, 'getItem'>, config: InterviewApiConfig): InterviewApiConfig {
  if (!config.rememberApiKeys) return config;
  const raw = storage.getItem(CREDENTIALS_STORAGE_KEY);
  if (!raw) return config;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return config;
    return { ...config,
      live: { ...config.live, credential: typeof value.live === 'string' ? value.live.trim() : config.live.credential },
      thinking: { ...config.thinking, apiKey: typeof value.thinking === 'string' ? value.thinking.trim() : config.thinking.apiKey },
    };
  } catch { return config; }
}

export function saveCredentials(storage: Pick<CredentialStorage, 'setItem' | 'removeItem'>, config: InterviewApiConfig): void {
  if (config.rememberApiKeys) {
    storage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify({ live: config.live.credential.trim(), thinking: config.thinking.apiKey.trim() }));
  } else {
    storage.removeItem(CREDENTIALS_STORAGE_KEY);
  }
}
