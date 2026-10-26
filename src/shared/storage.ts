export type StorageStatus = 'saved' | 'session' | 'unavailable';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
