const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const indexedDBFixture = require('./helpers/indexedDB.cjs');
const { deferred } = require('./helpers/fixtures.cjs');

const record = (event, timestamp = 1000, data) => ({ timestamp, level: 'warn', scope: 'test', event, context: {}, data });
const events = jsonl => jsonl.trim() ? jsonl.trim().split('\n').map(line => JSON.parse(line).event) : [];
const storageModule = () => load('src/shared/logStorage.ts');

test('IndexedDB logs survive a fresh store instance, preserve order and snapshot before pending writes', async () => {
  const factory = indexedDBFixture();
  const { createLogStorage, createIndexedDBLogBackend } = storageModule();
  const create = () => createLogStorage({ backend: createIndexedDBLogBackend(() => factory), now: () => 1000 });
  const first = create();
  const data = { metadata: { full: 'original' } };
  first.append(record('one', 1000, data)); first.append(record('two')); first.append(record('three'));
  data.metadata.full = 'mutated';
  const exported = await first.exportLogs();
  assert.deepEqual(events(exported), ['one', 'two', 'three']);
  assert.equal(JSON.parse(exported.split('\n')[0]).data.metadata.full, 'original');
  assert.equal(first.getStatus().mode, 'persistent');
  assert.equal(await create().exportLogs(), exported);
});

test('IndexedDB retention removes expired and oldest records using UTF-8 JSON Lines bytes', async () => {
  const factory = indexedDBFixture();
  const { createLogStorage, createIndexedDBLogBackend, serializedLogBytes } = storageModule();
  let now = 1000;
  const bytes = serializedLogBytes(JSON.stringify(record('一')));
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(record('一')) + '\n'));
  const storage = createLogStorage({ backend: createIndexedDBLogBackend(() => factory), now: () => now, retentionMs: 100, maxBytes: bytes * 2 });
  storage.append(record('一', 1000)); storage.append(record('二', 1000)); storage.append(record('三', 1000));
  assert.deepEqual(events(await storage.exportLogs()), ['二', '三']);
  now = 1101;
  assert.equal(await storage.exportLogs(), '');
  // Pruning is persisted, rather than just filtering the download.
  const reloaded = createLogStorage({ backend: createIndexedDBLogBackend(() => factory), now: () => 1000 });
  assert.equal(await reloaded.exportLogs(), '');
});

test('records above the entire cap are skipped and reported without evicting retained logs', async () => {
  const factory = indexedDBFixture();
  const { createLogStorage, createIndexedDBLogBackend } = storageModule();
  const storage = createLogStorage({ backend: createIndexedDBLogBackend(() => factory), now: () => 1000, maxBytes: 200 });
  const statuses = [];
  const unsubscribe = storage.subscribe(() => statuses.push(storage.getStatus()));
  storage.append(record('small')); storage.append(record('large', 1000, 'x'.repeat(1000)));
  assert.deepEqual(events(await storage.exportLogs()), ['small']);
  assert.equal(storage.getStatus().omittedRecords, 1);
  assert.ok(statuses.some(status => /exceeded/.test(status.lastOmission)));
  unsubscribe();
});

test('an already expired queued record does not evict a retained record', async () => {
  const factory = indexedDBFixture();
  const { createLogStorage, createIndexedDBLogBackend } = storageModule();
  const storage = createLogStorage({ backend: createIndexedDBLogBackend(() => factory), now: () => 1000, retentionMs: 100, maxBytes: 150 });
  storage.append(record('retained')); storage.append(record('expired', 899));
  assert.deepEqual(events(await storage.exportLogs()), ['retained']);
});

test('an aborted write is isolated, keeps prior persisted logs and uses a bounded session buffer', async () => {
  const factory = indexedDBFixture();
  const { createLogStorage, createIndexedDBLogBackend, serializedLogBytes } = storageModule();
  const storage = createLogStorage({ backend: createIndexedDBLogBackend(() => factory), now: () => 1000,
    memoryMaxBytes: serializedLogBytes(JSON.stringify(record('two'))) });
  storage.append(record('saved')); await storage.exportLogs();
  factory.failNextTransaction();
  storage.append(record('one')); storage.append(record('two'));
  assert.deepEqual(events(await storage.exportLogs()), ['saved', 'two']);
  assert.equal(storage.getStatus().mode, 'session');
  await storage.clearLogs();
  assert.equal(await storage.exportLogs(), '');
  assert.equal(storage.getStatus().mode, 'persistent');
});

test('unavailable IndexedDB supports session download, expiry, omission reporting and clear failure', async () => {
  const { createLogStorage, createIndexedDBLogBackend } = storageModule();
  let now = 1000;
  const storage = createLogStorage({ backend: createIndexedDBLogBackend(() => { throw new Error('SecurityError'); }),
    now: () => now, retentionMs: 100, maxBytes: 1000, memoryMaxBytes: 150 });
  const unsubscribe = storage.subscribe(() => { throw new Error('Bad observer'); });
  storage.append(record('one')); storage.append(record('too-big', 1000, 'x'.repeat(200)));
  assert.deepEqual(events(await storage.exportLogs()), ['one']);
  assert.equal(storage.getStatus().mode, 'session');
  assert.equal(storage.getStatus().omittedRecords, 1);
  assert.match(storage.getStatus().message, /session only/);
  assert.match(storage.getStatus().lastOmission, /buffer limit/);
  await assert.rejects(storage.clearLogs(), /could not be cleared/);
  assert.equal(await storage.exportLogs(), '');
  storage.append(record('expired')); now = 1101;
  assert.equal(await storage.exportLogs(), '');
  unsubscribe();
});

test('persisted and fallback records share the export cap, removing oldest saved records first', async () => {
  const factory = indexedDBFixture();
  const { createLogStorage, createIndexedDBLogBackend, serializedLogBytes } = storageModule();
  const bytes = serializedLogBytes(JSON.stringify(record('one')));
  const storage = createLogStorage({ backend: createIndexedDBLogBackend(() => factory), now: () => 1000, maxBytes: bytes * 2 });
  storage.append(record('one')); storage.append(record('two')); await storage.exportLogs();
  factory.failNextTransaction(); storage.append(record('new'));
  const exported = await storage.exportLogs();
  assert.deepEqual(events(exported), ['two', 'new']);
  assert.equal(Buffer.byteLength(exported), bytes * 2);
});

test('export and clear wait for pending writes, and later writes follow clear', async () => {
  const { createLogStorage } = storageModule();
  const pending = deferred();
  const calls = [], saved = [];
  const storage = createLogStorage({ now: () => 1000, backend: {
    async append(entry) { calls.push(entry.json); if (JSON.parse(entry.json).event === 'first') await pending.promise; saved.push(entry.json); },
    async read() { calls.push('read'); return [...saved]; },
    async clear() { calls.push('clear'); saved.length = 0; },
  } });
  storage.append(record('first')); storage.append(record('second'));
  let finished = false;
  const exported = storage.exportLogs().then(value => { finished = true; return value; });
  const cleared = storage.clearLogs();
  storage.append(record('after-clear'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(finished, false); assert.equal(calls.length, 1);
  pending.resolve();
  assert.deepEqual(events(await exported), ['first', 'second']);
  await cleared;
  assert.deepEqual(events(await storage.exportLogs()), ['after-clear']);
});

test('download uses a UTC JSON Lines filename, UTF-8 blob, and releases its object URL', async () => {
  let capturedBlob, link, timer;
  const calls = [];
  const module = load('src/shared/logStorage.ts', {
    URL: { createObjectURL(blob) { capturedBlob = blob; return 'blob:logs'; }, revokeObjectURL(url) { calls.push(url); } },
    setTimeout(callback) { timer = callback; },
    document: { createElement() { link = { click() { calls.push('click'); }, remove() { calls.push('remove'); } }; return link; },
      body: { appendChild() { calls.push('append'); } } },
  });
  module.logStorage.append(record('中文', Date.now()));
  await module.downloadLogs();
  assert.match(link.download, /^interview-practice-logs-\d{4}-\d{2}-\d{2}T.*Z\.jsonl$/);
  assert.equal(capturedBlob.type, 'application/x-ndjson;charset=utf-8');
  assert.deepEqual(events(await capturedBlob.text()), ['中文']);
  assert.equal(module.logDownloadFilename(0), 'interview-practice-logs-1970-01-01T00-00-00-000Z.jsonl');
  timer(); assert.deepEqual(calls, ['append', 'click', 'remove', 'blob:logs']);
});
