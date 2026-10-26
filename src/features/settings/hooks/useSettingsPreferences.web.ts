import { useState } from 'react';
import { defaultApiConfig, type InterviewApiConfig } from '../../../shared/apiConfig';
import { logger } from '../../../shared/logger';
import type { StorageStatus } from '../../../shared/storage';
import { readPreferences, writePreferences } from '../storage/preferencesStorage';
import { CREDENTIALS_STORAGE_KEY, restoreCredentials, saveCredentials } from '../storage/credentialsStorage';
import type { SettingsPreferences } from './useSettingsPreferences.types';

const log = logger.child({ scope: 'settings-storage' });
type PreferencesState = { config: InterviewApiConfig; storageStatus: StorageStatus; credentialStorageStatus?: StorageStatus };

function restorePreferences(storedProblemCount: number): PreferencesState {
  const config: InterviewApiConfig = { ...defaultApiConfig(), problemSource: storedProblemCount > 0 ? 'stored' : 'agent' };
  if (typeof window === 'undefined') return { config, storageStatus: 'session' };
  let restored = config;
  let storageStatus: StorageStatus = 'saved';
  try {
    restored = readPreferences(window.localStorage, config);
  } catch {
    log.warn('settings.restore-failed', { fallback: 'session' });
    storageStatus = 'unavailable';
  }
  try {
    // Read keys only when opted in; remove any previous keys when disabled.
    if (restored.rememberApiKeys) restored = restoreCredentials(window.sessionStorage, restored);
    else window.sessionStorage?.removeItem(CREDENTIALS_STORAGE_KEY);
    return { config: restored, storageStatus, credentialStorageStatus: restored.rememberApiKeys ? 'saved' : 'session' };
  } catch {
    log.warn('settings.credentials-restore-failed');
    return { config: restored, storageStatus, credentialStorageStatus: restored.rememberApiKeys ? 'unavailable' : 'session' };
  }
}

export default function useSettingsPreferences(storedProblemCount = 0): SettingsPreferences {
  const [state, setState] = useState(() => restorePreferences(storedProblemCount));

  function saveConfig(config: InterviewApiConfig) {
    let storageStatus: StorageStatus = 'session';
    let credentialStorageStatus: StorageStatus = 'session';
    if (typeof window !== 'undefined') {
      try {
        writePreferences(window.localStorage, config);
        storageStatus = 'saved';
        log.info('settings.preferences-saved', { source: 'local-storage' });
      } catch {
        storageStatus = 'unavailable';
        log.warn('settings.save-failed', { fallback: 'session' });
      }
      try {
        if (window.sessionStorage) {
          saveCredentials(window.sessionStorage, config);
          credentialStorageStatus = config.rememberApiKeys ? 'saved' : 'session';
        } else if (config.rememberApiKeys) credentialStorageStatus = 'unavailable';
      } catch {
        credentialStorageStatus = 'unavailable';
        log.warn('settings.credentials-save-failed');
      }
    }
    setState({ config, storageStatus, credentialStorageStatus });
  }

  return { ...state, saveConfig };
}
