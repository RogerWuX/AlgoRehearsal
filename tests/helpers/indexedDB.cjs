// Small asynchronous browser boundary for transaction, cursor, and reload tests.
// Transaction data is committed only on completion and rolled back on abort.
module.exports = function indexedDBFixture() {
  const stores = new Map();
  let nextKey = 1, failNext = false;
  const factory = {
    failNextTransaction() { failNext = true; },
    open() {
      const request = {};
      setImmediate(() => {
        request.result = {
          close() {},
          createObjectStore(name) { stores.set(name, new Map()); },
          transaction(names) {
            const working = new Map(names.map(name => [name, new Map(stores.get(name))]));
            let pending = 0, aborted = false;
            const mustFail = failNext; failNext = false;
            const tx = {
              abort() {
                if (aborted) return;
                aborted = true; tx.error = new Error('Storage failure');
                setImmediate(() => tx.onabort?.());
              },
              objectStore(name) {
                const entries = working.get(name);
                return {
                  add(value) { return schedule(() => { const key = nextKey++; entries.set(key, value); return key; }); },
                  put(value, key) { return schedule(() => { entries.set(key, value); return key; }); },
                  delete(key) { return schedule(() => entries.delete(key)); },
                  clear() { return schedule(() => entries.clear()); },
                  getAll() { return schedule(() => [...entries].sort(([a], [b]) => a - b).map(([, value]) => value)); },
                  openCursor() {
                    const items = [...entries].sort(([a], [b]) => a - b);
                    const request = {};
                    let index = 0;
                    const advance = () => schedule(() => {
                      const item = items[index++];
                      return item ? { key: item[0], value: item[1], continue: advance } : null;
                    }, request);
                    advance(); return request;
                  },
                };
              },
            };
            function schedule(operation, request = {}) {
              pending++;
              setImmediate(() => {
                if (aborted) return;
                if (mustFail) { tx.abort(); return; }
                try { request.result = operation(); request.onsuccess?.(); }
                catch (error) { tx.error = error; tx.abort(); return; }
                pending--;
                if (!pending) {
                  for (const [name, entries] of working) stores.set(name, entries);
                  tx.oncomplete?.();
                }
              });
              return request;
            }
            return tx;
          },
        };
        if (!stores.size) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return factory;
};
