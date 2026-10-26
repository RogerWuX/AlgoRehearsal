import { logger as nativeLogs } from 'react-native-logs';
import type { LogRecord } from './logger';
import { logStorage } from './logStorage';

export const developmentLogging = typeof __DEV__ !== 'undefined' && __DEV__;
export const defaultLoggingEnabled = true;
export const defaultMinimumLevel = 'debug' as const;

const levels = { debug: 0, info: 1, warn: 2, error: 3 };

const output = nativeLogs.createLogger({
  levels,
  severity: defaultMinimumLevel,
  async: false,
  stringifyFunc: () => '',
  transport: ({ rawMsg, level }: { rawMsg: unknown; level: { severity: number } }) => {
    const record = (rawMsg as LogRecord[])[0];
    // Persist even if the console is unavailable or throws.
    logStorage.append(record);
    if (level.severity >= levels.error) console.error('[interview-practice]', JSON.stringify(record, null, 2));
  },
});

export function outputLog(record: LogRecord): void {
  output[record.level](record);
}
