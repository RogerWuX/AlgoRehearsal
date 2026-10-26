import type { LiveConfig } from '../../../shared/apiConfig';
import type { Logger } from '../../../shared/logger';
import type { ChatMessage } from './chat';

export type AudioChunk = { data: string; mimeType: string };
export type InterviewContent = {
  inputText?: string;
  inputTextFinished?: boolean;
  outputText?: string;
  audio: AudioChunk[];
  interrupted?: boolean;
  turnComplete?: boolean;
};

export interface InterviewTransport {
  sendText(text: string): boolean;
  sendAudio(chunk: AudioChunk): void;
  endAudio(): void;
  close(): void;
}

export type TransportEvents = {
  ready(): void;
  content(content: InterviewContent): void;
  error(message: string): void;
  resumption?(update: { resumable: boolean; handle?: string }): void;
};

export type TransportRecovery = { handle?: string; messages: readonly ChatMessage[]; continuing: boolean; enabled: boolean };

export type TransportTurn = { readonly role: 'user' | 'model'; readonly text: string };
export type LiveTransportRequest = {
  readonly systemInstruction: string;
  readonly initialTurns: readonly TransportTurn[];
  readonly sessionResumption?: { readonly handle?: string };
};

export interface InterviewAudio {
  resume(): Promise<void>;
  play(chunk: AudioChunk): void;
  stopPlayback(): void;
  startMicrophone(onAudio: (chunk: AudioChunk) => void, onError: () => void): Promise<boolean>;
  stopMicrophone(): boolean;
  close(): void;
}

export type TransportFactory = (config: LiveConfig, request: LiveTransportRequest, events: TransportEvents, logger?: Logger) => InterviewTransport;
