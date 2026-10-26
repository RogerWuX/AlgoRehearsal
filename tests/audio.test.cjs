const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/loadTypeScript.cjs');
const { deferred, flush } = require('./helpers/fixtures.cjs');

function audioHarness(getUserMedia, options = {}) {
  const contexts = [], sources = [], processors = [], streams = [];
  function stream() {
    const track = { stops: 0, stop() { this.stops++; } };
    const result = { track, getTracks: () => [track] };
    streams.push(result);
    return result;
  }
  class AudioContext {
    constructor({ sampleRate }) { this.sampleRate = sampleRate; this.currentTime = 2; this.closed = 0; this.destination = {}; contexts.push(this); }
    resume() { return options.resume?.(this) ?? Promise.resolve(); }
    close() { this.closed++; return Promise.resolve(); }
    createScriptProcessor() {
      const processor = { disconnected: 0, connect() {}, disconnect() { this.disconnected++; if (options.failDisconnect) throw new Error('Disconnect failed'); } };
      processors.push(processor); return processor;
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { duration: length / sampleRate, sampleRate, getChannelData: () => data };
    }
    createBufferSource() {
      const source = { disconnected: 0, stopped: 0, connect() {}, start(time) { this.started = time; }, stop() { this.stopped++; }, disconnect() { this.disconnected++; } };
      sources.push(source); return source;
    }
  }
  const { BrowserAudio } = load('src/features/interview/adapters/audio/browserAudio.web.ts', {
    AudioContext, navigator: { mediaDevices: { getUserMedia: () => getUserMedia ? getUserMedia(stream) : Promise.resolve(stream()) } },
  });
  return { audio: new BrowserAudio(), contexts, sources, processors, streams, stream };
}

test('PCM uses little endian samples and clips microphone input', () => {
  const { encodePcm, decodePcm } = load('src/features/interview/adapters/audio/pcm.ts');
  const encoded = encodePcm(new Float32Array([-2, 0, 0.5, 2]));
  const bytes = Buffer.from(encoded, 'base64');
  assert.deepEqual([0, 2, 4, 6].map(offset => bytes.readInt16LE(offset)), [-32767, 0, 16383, 32767]);
  const samples = decodePcm(encoded);
  assert.equal(samples[0], -32767 / 32768);
  assert.equal(samples[3], 32767 / 32768);
  assert.equal(decodePcm(btoa('\x00')).length, 0);
});

test('playback queues chunks, skips non-audio data, and interruption releases sources', async () => {
  const h = audioHarness();
  await h.audio.resume();
  const chunk = { data: btoa('\x00\x00\xff\x7f'), mimeType: 'audio/pcm;rate=24000' };
  h.audio.play({ ...chunk, mimeType: 'image/png' });
  h.audio.play(chunk); h.audio.play(chunk);
  assert.equal(h.sources.length, 2);
  assert.equal(h.sources[0].started, 2);
  assert.equal(h.sources[1].started, 2 + 2 / 24000);
  h.audio.stopPlayback();
  assert.ok(h.sources.every(source => source.stopped === 1 && source.disconnected === 1));
  h.audio.play(chunk);
  assert.equal(h.sources[2].started, 2);
  h.audio.close(); h.audio.close();
  assert.equal(h.contexts[0].closed, 1);
});

test('repeated playback activation reuses its context without discarding queued audio', async () => {
  const h = audioHarness();
  await h.audio.resume();
  h.audio.play({ data: btoa('\x00\x00'), mimeType: 'audio/pcm;rate=24000' });
  await h.audio.resume();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.sources[0].stopped, 0);
  h.audio.close();
  assert.equal(h.contexts[0].closed, 1);
});

test('microphone permission resolving after cancellation stops the late stream', async () => {
  const pending = deferred();
  const h = audioHarness(() => pending.promise);
  const task = h.audio.startMicrophone(() => {}, () => {});
  h.audio.stopMicrophone();
  const stream = h.stream(); pending.resolve(stream);
  assert.equal(await task, false);
  assert.equal(stream.track.stops, 1);
  assert.equal(h.contexts.length, 0);
  h.audio.close();
});

test('stale permission rejection does not stop a newly active microphone', async () => {
  const pending = deferred(); let calls = 0;
  const h = audioHarness(stream => ++calls === 1 ? pending.promise : Promise.resolve(stream()));
  const old = h.audio.startMicrophone(() => {}, () => {});
  h.audio.stopMicrophone();
  assert.equal(await h.audio.startMicrophone(() => {}, () => {}), true);
  pending.reject(new Error('Old denial'));
  assert.equal(await old, false);
  assert.equal(h.streams[0].track.stops, 0);
  h.audio.close();
  assert.equal(h.streams[0].track.stops, 1);
});

test('canceling a pending audio resume releases capture and ignores its late rejection', async () => {
  const pending = deferred();
  const h = audioHarness(undefined, { resume: () => pending.promise });
  const task = h.audio.startMicrophone(() => {}, () => {});
  await flush();
  h.audio.stopMicrophone();
  pending.reject(new Error('Old resume failure'));
  assert.equal(await task, false);
  assert.equal(h.streams[0].track.stops, 1);
  assert.equal(h.contexts[0].closed, 1);
});

test('capture sends PCM at the actual sample rate and cleanup survives processor errors', async () => {
  const h = audioHarness(undefined, { failDisconnect: true });
  const chunks = [];
  assert.equal(await h.audio.startMicrophone(chunk => chunks.push(chunk), () => {}), true);
  h.processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array([0, 1]) } });
  assert.equal(chunks[0].mimeType, 'audio/pcm;rate=16000');
  h.audio.close();
  assert.equal(h.processors[0].onaudioprocess, null);
  assert.equal(h.streams[0].track.stops, 1);
  assert.equal(h.contexts[0].closed, 1);
});

test('a failed audio send reports once and releases microphone resources', async () => {
  const h = audioHarness(); let errors = 0;
  await h.audio.startMicrophone(() => { throw new Error('Connection failed'); }, () => { errors++; });
  const process = h.processors[0].onaudioprocess;
  process({ inputBuffer: { getChannelData: () => new Float32Array([1]) } });
  process({ inputBuffer: { getChannelData: () => new Float32Array([1]) } });
  assert.equal(errors, 1);
  assert.equal(h.streams[0].track.stops, 1);
  h.audio.close();
});
