import type { LogRecord } from './logger';

export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_MAX_BYTES = 50 * 1024 * 1024;
export const LOG_MEMORY_MAX_BYTES = 5 * 1024 * 1024;
const DATABASE_NAME = 'interview-practice-logs';

export type LogStorageStatus = Readonly<{
  mode: 'loading' | 'persistent' | 'session';
  message: string;
  omittedRecords: number;
  lastOmission?: string;
}>;
export type StoredLog = { timestamp: number; json: string; bytes: number };
type Retention = { cutoff: number; maxBytes: number };
export interface LogBackend {
  append(entry: StoredLog, retention: Retention): Promise<void>;
  read(retention: Retention): Promise<string[]>;
  clear(): Promise<void>;
}

// Keep retention metadata separate so each write scans small entries, not 50 MiB
// of provider responses. Both stores change in the same atomic transaction.
export function createIndexedDBLogBackend(getFactory: () => IDBFactory = () => indexedDB): LogBackend {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = getFactory().open(DATABASE_NAME, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      request.result.createObjectStore('records', { autoIncrement: true });
      request.result.createObjectStore('entries');
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open log storage.'));
    request.onblocked = () => { blocked = true; reject(new Error('Log storage is blocked by another browser tab.')); };
  });

  async function transaction<T>(run: (tx: IDBTransaction, setResult: (result: T) => void) => void): Promise<T> {
    let db: IDBDatabase;
    try { db = await open(); } catch (error) { database = undefined; throw error; }
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['records', 'entries'], 'readwrite');
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error('Log storage transaction failed.'));
      tx.onerror = () => { /* onabort reports request and quota failures. */ };
      try { run(tx, value => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  }

  function prune(tx: IDBTransaction, retention: Retention, incomingBytes: number, done: () => void): void {
    const metadata = tx.objectStore('entries');
    const records = tx.objectStore('records');
    const retained: { key: IDBValidKey; bytes: number }[] = [];
    let total = incomingBytes;
    const cursor = metadata.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) {
        const entry = item.value as { timestamp: number; bytes: number };
        if (entry.timestamp < retention.cutoff) {
          metadata.delete(item.key); records.delete(item.key);
        } else {
          retained.push({ key: item.key, bytes: entry.bytes }); total += entry.bytes;
        }
        item.continue();
      } else {
        for (const entry of retained) {
          if (total <= retention.maxBytes) break;
          metadata.delete(entry.key); records.delete(entry.key); total -= entry.bytes;
        }
        done();
      }
    };
  }

  return {
    append: (entry, retention) => transaction<void>((tx, setResult) => {
      prune(tx, retention, entry.timestamp >= retention.cutoff ? entry.bytes : 0, () => {
        if (entry.timestamp >= retention.cutoff) {
          const request = tx.objectStore('records').add(entry.json);
          request.onsuccess = () => tx.objectStore('entries').put({ timestamp: entry.timestamp, bytes: entry.bytes }, request.result);
        }
        setResult(undefined);
      });
    }),
    read: retention => transaction<string[]>((tx, setResult) => {
      prune(tx, retention, 0, () => {
        const request = tx.objectStore('records').getAll();
        request.onsuccess = () => setResult(request.result as string[]);
      });
    }),
    clear: () => transaction<void>((tx, setResult) => {
      tx.objectStore('records').clear(); tx.objectStore('entries').clear(); setResult(undefined);
    }),
  };
}

// Count actual UTF-8 JSON Lines bytes, including the line terminator.
export function serializedLogBytes(json: string): number {
  return new Blob([json, '\n']).size;
}

export function createLogStorage(options: {
  backend?: LogBackend;
  now?: () => number;
  retentionMs?: number;
  maxBytes?: number;
  memoryMaxBytes?: number;
} = {}) {
  const backend = options.backend ?? createIndexedDBLogBackend();
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const memoryMaxBytes = Math.min(options.memoryMaxBytes ?? LOG_MEMORY_MAX_BYTES, maxBytes);
  const retention = (): Retention => ({ cutoff: now() - (options.retentionMs ?? LOG_RETENTION_MS), maxBytes });
  const listeners = new Set<() => void>();
  let status: LogStorageStatus = Object.freeze({ mode: 'loading', message: 'Checking browser log storage…', omittedRecords: 0 });
  let queue: Promise<unknown> = Promise.resolve();
  let buffer: StoredLog[] = [];
  let failed = false;
  const update = (next: Partial<LogStorageStatus>) => {
    status = Object.freeze({ ...status, ...next });
    for (const listener of listeners) { try { listener(); } catch { /* Isolate observers. */ } }
  };
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending;
  }
  const unavailable = () => {
    failed = true;
    update({ mode: 'session', message: 'Browser log storage is unavailable. New logs are kept for this session only (up to 5 MiB).' });
  };
  const omit = (lastOmission: string) => update({ omittedRecords: status.omittedRecords + 1, lastOmission });
  const pruneBuffer = () => {
    buffer = buffer.filter(entry => entry.timestamp >= retention().cutoff);
    let total = buffer.reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > memoryMaxBytes && buffer.length) total -= buffer.shift()!.bytes;
  };
  const remember = (entry: StoredLog) => {
    if (entry.bytes > memoryMaxBytes) {
      omit('A log record exceeded the session buffer limit and was omitted.'); return;
    }
    buffer.push(entry); pruneBuffer();
  };
  const initialize = () => enqueue(async () => {
    if (status.mode !== 'loading') return;
    try {
      await backend.read(retention());
      update({ mode: 'persistent', message: 'Logs are saved in this browser for seven days, up to 50 MiB.' });
    } catch { unavailable(); }
  });

  return {
    getStatus: () => status,
    subscribe(listener: () => void) {
      listeners.add(listener); void initialize();
      return () => { listeners.delete(listener); };
    },
    append(record: LogRecord): void {
      // Serialize before yielding so later mutations cannot alter saved records.
      try {
        const json = JSON.stringify(record);
        const entry = { timestamp: record.timestamp, json, bytes: serializedLogBytes(json) };
        if (entry.bytes > maxBytes) {
          omit('A log record exceeded the 50 MiB retention limit and was omitted.'); return;
        }
        void enqueue(async () => {
          if (failed) { remember(entry); return; }
          try {
            await backend.append(entry, retention());
            if (status.mode === 'loading') update({ mode: 'persistent', message: 'Logs are saved in this browser for seven days, up to 50 MiB.' });
          } catch { unavailable(); remember(entry); }
        });
      } catch { omit('A log record could not be serialized and was omitted.'); }
    },
    exportLogs(): Promise<string> {
      return enqueue(async () => {
        let saved: string[] = [];
        pruneBuffer();
        const bufferedBytes = buffer.reduce((sum, entry) => sum + entry.bytes, 0);
        try {
          // Session records follow persisted records, so evict older saved logs
          // first to keep the combined download within the retention cap.
          saved = await backend.read({ ...retention(), maxBytes: maxBytes - bufferedBytes });
          if (status.mode === 'loading') update({ mode: 'persistent', message: 'Logs are saved in this browser for seven days, up to 50 MiB.' });
        } catch { unavailable(); }
        const lines = [...saved, ...buffer.map(entry => entry.json)];
        return lines.length ? lines.join('\n') + '\n' : '';
      });
    },
    clearLogs(): Promise<void> {
      return enqueue(async () => {
        buffer = [];
        try {
          await backend.clear(); failed = false;
          update({ mode: 'persistent', message: 'Logs cleared. Logs are saved in this browser for seven days, up to 50 MiB.', omittedRecords: 0, lastOmission: undefined });
        } catch {
          unavailable();
          throw new Error('Session logs cleared, but saved browser logs could not be cleared.');
        }
      });
    },
  };
}

export const logStorage = createLogStorage();

export function logDownloadFilename(timestamp = Date.now()): string {
  return `interview-practice-logs-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}.jsonl`;
}

export async function downloadLogs(): Promise<void> {
  const jsonl = await logStorage.exportLogs();
  const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson;charset=utf-8' }));
  try {
    const link = document.createElement('a');
    link.href = url; link.download = logDownloadFilename();
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    // Give the browser time to begin reading the download before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
