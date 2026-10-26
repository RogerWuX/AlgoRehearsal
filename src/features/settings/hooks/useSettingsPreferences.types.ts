import type { InterviewApiConfig } from '../../../shared/apiConfig';
import type { StorageStatus } from '../../../shared/storage';

export type SettingsPreferences = {
  config: InterviewApiConfig;
  saveConfig(config: InterviewApiConfig): void;
  storageStatus: StorageStatus;
  credentialStorageStatus?: StorageStatus;
};
