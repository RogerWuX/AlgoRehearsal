export function decodePcm(data: string): Float32Array {
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

export function encodePcm(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  // Avoid exceeding the argument limit when encoding a large input buffer.
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
