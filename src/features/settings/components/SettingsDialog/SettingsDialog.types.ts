import type { InterviewApiConfig } from '../../../../shared/apiConfig';
import type { StorageStatus } from '../../../../shared/storage';

export type SettingsDialogProps = {
  config: InterviewApiConfig;
  locked: boolean;
  storedProblemCount?: number;
  questionImportWarning?: string;
  preferenceStorageStatus?: StorageStatus;
  credentialStorageStatus?: StorageStatus;
  onClose: () => void;
  onSave: (config: InterviewApiConfig) => void;
};
