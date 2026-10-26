export const ANTIGRAVITY_POLL_INTERVAL_MS = 5000;
export const REQUEST_TIMEOUT_MS = 300000;

export function requestOptions(signal?: AbortSignal, timeout = REQUEST_TIMEOUT_MS) {
  signal?.throwIfAborted();
  return { ...(signal ? { fetchOptions: { signal } } : {}), timeout, maxRetries: 0 };
}

export function waitForPoll(signal?: AbortSignal, intervalMs = ANTIGRAVITY_POLL_INTERVAL_MS): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
