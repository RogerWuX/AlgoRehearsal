export type SettingsCategoryId = 'interview' | 'model' | 'diagnostics';

export const SETTINGS_SIDEBAR_BREAKPOINT = 768;
export const SETTINGS_DIALOG_WIDTH = 760;
export const SETTINGS_DIALOG_HEIGHT = 640;
export const SETTINGS_DIALOG_MARGIN = 20;

export const settingsCategories: readonly { id: SettingsCategoryId; label: string }[] = [
  { id: 'interview', label: 'Interview' },
  { id: 'model', label: 'Model' },
  { id: 'diagnostics', label: 'Diagnostics' },
];
