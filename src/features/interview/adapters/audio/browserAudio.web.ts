import type { AudioChunk, InterviewAudio } from '../../model/transport';
import { decodePcm, encodePcm } from './pcm';
import { logger as appLogger, type Logger } from '../../../../shared/logger';

function release(action: () => void | Promise<void>, logger: Logger) {
  try {
    const result = action();
    if (result) void result.catch(error => logger.warn('audio.cleanup-failed', { error }));
  } catch (error) { logger.warn('audio.cleanup-failed', { error }); }
}

type Microphone = {
  stream: MediaStream;
  context: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode | null;
};

export class BrowserAudio implements InterviewAudio {
  private context: AudioContext | null = null;
  private playback = new Set<AudioBufferSourceNode>();
  private nextAudioTime = 0;
  private mic: Microphone | null = null;
  private micRequest = 0;
  private closed = false;
  private logger: Logger;

  constructor(logger: Logger = appLogger) { this.logger = logger.child({ scope: 'audio' }); }
  private release(action: () => void | Promise<void>) { release(action, this.logger); }

  async resume() {
    if (this.closed) { this.logger.debug('audio.resume-skipped', { reason: 'audio-closed' }); return; }
    this.logger.debug('audio.resume-requested');
    this.context ??= new AudioContext({ sampleRate: 24000 });
    await this.context.resume();
    this.logger.info('audio.resumed');
  }

  play(chunk: AudioChunk) {
    const context = this.context;
    if (this.closed || !context || !chunk.mimeType.startsWith('audio/pcm')) return;
    const rate = Number(/rate=(\d+)/.exec(chunk.mimeType)?.[1] ?? 24000);
    const samples = decodePcm(chunk.data);
    if (!samples.length) return;
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.playback.add(source);
    source.onended = () => {
      this.playback.delete(source);
      this.release(() => source.disconnect());
    };
    const start = Math.max(context.currentTime, this.nextAudioTime);
    source.start(start);
    this.nextAudioTime = start + buffer.duration;
  }

  stopPlayback() {
    if (this.playback.size) this.logger.debug('audio.playback-stopped', { queuedSources: this.playback.size });
    for (const source of this.playback) {
      this.release(() => source.stop());
      this.release(() => source.disconnect());
    }
    this.playback.clear();
    this.nextAudioTime = 0;
  }

  async startMicrophone(onAudio: (chunk: AudioChunk) => void, onError: () => void): Promise<boolean> {
    if (this.closed || this.mic) {
      this.logger.debug('microphone.capture-rejected', { reason: this.closed ? 'audio-closed' : 'capture-already-active' });
      return false;
    }
    const request = ++this.micRequest;
    const current = () => !this.closed && request === this.micRequest;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    try {
      this.logger.info('microphone.permission-requested', { microphoneRequestId: request });
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) {
        this.logger.debug('microphone.permission-discarded', { reason: 'request-superseded', microphoneRequestId: request });
        stream.getTracks().forEach(track => this.release(() => track.stop()));
        return false;
      }
      this.logger.info('microphone.permission-granted', { microphoneRequestId: request });
      context = new AudioContext({ sampleRate: 16000 });
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mic: Microphone = { stream, context, processor, source: null };
      this.mic = mic;
      await context.resume();
      if (!current()) {
        this.logger.debug('microphone.resume-discarded', { reason: 'request-superseded', microphoneRequestId: request });
        return false;
      }
      mic.source = context.createMediaStreamSource(stream);
      mic.source.connect(processor);
      processor.connect(context.destination);
      processor.onaudioprocess = event => {
        if (!current()) return;
        try {
          onAudio({ data: encodePcm(event.inputBuffer.getChannelData(0)), mimeType: `audio/pcm;rate=${mic.context.sampleRate}` });
        } catch (error) {
          if (current()) {
            this.logger.error('microphone.capture-failed', { error });
            this.stopMicrophone();
            onError();
          }
        }
      };
      this.logger.info('microphone.capture-started', { microphoneRequestId: request, sampleRate: context.sampleRate });
      return true;
    } catch (error) {
      // An old permission/resume failure must not stop a newer microphone.
      if (!current()) {
        this.logger.debug('microphone.failure-discarded', { reason: 'request-superseded', microphoneRequestId: request });
        return false;
      }
      this.logger.warn('microphone.permission-or-resume-failed', { error, microphoneRequestId: request });
      if (this.mic) this.stopMicrophone();
      else {
        stream?.getTracks().forEach(track => this.release(() => track.stop()));
        if (context) this.release(() => context!.close());
      }
      throw error;
    }
  }

  stopMicrophone(): boolean {
    this.micRequest++;
    const mic = this.mic;
    this.mic = null;
    if (!mic) return false;
    this.logger.info('microphone.capture-stopped');
    mic.processor.onaudioprocess = null;
    this.release(() => mic.source?.disconnect());
    this.release(() => mic.processor.disconnect());
    mic.stream.getTracks().forEach(track => this.release(() => track.stop()));
    this.release(() => mic.context.close());
    return true;
  }

  close() {
    if (this.closed) return;
    this.logger.info('audio.close-requested');
    this.closed = true;
    this.stopMicrophone();
    this.stopPlayback();
    const context = this.context;
    this.context = null;
    if (context) this.release(() => context.close());
  }
}
