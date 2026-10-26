export type Clock = {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(timer: unknown): void;
};

export const systemClock: Clock = {
  setTimeout: (callback, duration) => setTimeout(callback, duration),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function generateRandomNumber(args: unknown): number {
  if (!args || typeof args !== 'object') throw new Error('min and max must be safe integers with min <= max.');
  const { min, max } = args as { min?: unknown; max?: unknown };
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new Error('min and max must be safe integers with min <= max.');
  }
  // Rejection sampling avoids modulo bias, even across the full safe-integer range.
  const span = BigInt(max) - BigInt(min) + BigInt(1);
  const size = BigInt(1) << BigInt(64);
  const limit = size - size % span;
  const words = new Uint32Array(2);
  let sample: bigint;
  do {
    crypto.getRandomValues(words);
    sample = (BigInt(words[0]) << BigInt(32)) | BigInt(words[1]);
  } while (sample >= limit);
  return Number(BigInt(min) + sample % span);
}
