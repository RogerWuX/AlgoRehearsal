// An SDK or middleware delay that ignores abort must not hold the workflow open.
export function invokeWithSignal<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return request(); }).then(value => {
      signal.throwIfAborted();
      resolve(value);
    }).catch(reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
