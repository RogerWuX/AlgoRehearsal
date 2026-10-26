import { useState } from 'react';
import { defaultApiConfig, type InterviewApiConfig } from '../../../shared/apiConfig';
import type { SettingsPreferences } from './useSettingsPreferences.types';

export default function useSettingsPreferences(storedProblemCount = 0): SettingsPreferences {
  const [config, saveConfig] = useState<InterviewApiConfig>(() => ({ ...defaultApiConfig(), problemSource: storedProblemCount > 0 ? 'stored' : 'agent' }));
  return { config, saveConfig, storageStatus: 'session' };
}
