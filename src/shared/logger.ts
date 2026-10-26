import { defaultLoggingEnabled, defaultMinimumLevel, outputLog } from './loggerOutput';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Record<string, unknown>;
export type LogRecord = {
  timestamp: number;
  level: LogLevel;
  scope: string;
  event: string;
  context: LogContext;
  data?: unknown;
};
export interface Logger {
  debug(event: string, data?: unknown): void;
  info(event: string, data?: unknown): void;
  warn(event: string, data?: unknown): void;
  error(event: string, data?: unknown): void;
  child(context: LogContext, secrets?: readonly string[]): Logger;
}
export type LoggerOptions = {
  scope?: string;
  context?: LogContext;
  secrets?: readonly string[];
  enabled?: boolean;
  minLevel?: LogLevel;
  sink?: (record: LogRecord) => void;
};
const levels: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const sensitiveField = /(?:api[_-]?key|credential|authorization|password|secret|access[_-]?token|refresh[_-]?token)$/i;

// Snapshot fields directly: provider toJSON methods can omit response metadata.
function snapshot(value: unknown, secrets: readonly string[], ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'string') {
    for (const secret of secrets) {
      if (!secret) continue;
      for (const variant of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
        value = (value as string).split(variant).join('[redacted]');
      }
    }
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => snapshot(item, secrets, ancestors));
    const result: Record<string, unknown> = Object.create(null);
    const keys = new Set(Object.keys(value));
    if (value instanceof Error || Object.prototype.toString.call(value) === '[object Error]') {
      for (const key of ['name', 'message', 'stack', 'cause']) keys.add(key);
    }
    for (const key of keys) {
      if (sensitiveField.test(key)) { result[key] = '[redacted]'; continue; }
      try { result[key] = snapshot((value as Record<string, unknown>)[key], secrets, ancestors); }
      catch { result[key] = '[unavailable]'; }
    }
    return result;
  } finally { ancestors.delete(value); }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const enabled = options.enabled ?? defaultLoggingEnabled;
  const minLevel = options.minLevel ?? (options.sink ? 'debug' : defaultMinimumLevel);
  const minimum = Math.max(levels[minLevel], options.sink ? 0 : levels[defaultMinimumLevel]);
  const secrets = (options.secrets ?? []).map(secret => secret.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const emit = (level: LogLevel, event: string, data?: unknown) => {
    if (!enabled || levels[level] < minimum) return;
    try {
      const record = snapshot({ timestamp: Date.now(), level, scope: options.scope ?? 'app', event,
        context: options.context ?? {}, data }, secrets) as LogRecord;
      if (options.sink) options.sink(record);
      else outputLog(record);
    } catch { /* Diagnostics must never interrupt the application. */ }
  };
  return {
    debug: (event, data) => emit('debug', event, data),
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, data) => emit('error', event, data),
    child: (context, extraSecrets = []) => createLogger({ ...options, enabled, minLevel,
      scope: typeof context.scope === 'string' ? context.scope : options.scope,
      context: { ...options.context, ...context }, secrets: [...secrets, ...extraSecrets] }),
  };
}

export const silentLogger: Logger = createLogger({ enabled: false });
export const logger: Logger = createLogger();
