import { GoogleGenAI, Modality, ThinkingLevel, type LiveServerMessage, type Session } from '@google/genai/web';
import { resolveSupportedModel, normalizeLiveConfig, type LiveConfig } from '../../../../../shared/apiConfig';
import type { InterviewTransport, LiveTransportRequest, TransportEvents } from '../../../model/transport';
import { GeminiProtocolSession } from './protocolSession';
import { logger as appLogger, type Logger } from '../../../../../shared/logger';

const CONNECTION_ERROR = 'Connection failed. Check your credential, model, and network.';

export function createGeminiTransport(config: LiveConfig, request: LiveTransportRequest, events: TransportEvents, logger: Logger = appLogger): InterviewTransport {
  const handle = request.sessionResumption?.handle ?? '';
  const log = logger.child({ scope: 'gemini-live', model: config.model.trim() }, [config.credential, handle]);
  if (resolveSupportedModel(config.model, 'live').modelFactory !== 'google') throw new Error(`Unsupported Gemini Live model: ${config.model.trim()}`);
  const live = normalizeLiveConfig(config);
  const thinkingLevels: Record<string, ThinkingLevel> = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };
  const thinkingLevel = live.thinkingEffort === undefined ? undefined : thinkingLevels[live.thinkingEffort];
  if (live.thinkingEffort !== undefined && thinkingLevel === undefined) throw new Error(`Unsupported Gemini Live thinking effort: ${live.thinkingEffort}`);
  const client = new GoogleGenAI({ apiKey: config.credential.trim(), httpOptions: { apiVersion: 'v1beta' } });
  let closed = false;
  let session: Session | null = null;
  let protocol: GeminiProtocolSession | null = null;
  let pending: LiveServerMessage[] = [];

  const fail = (message: string) => {
    if (closed) { log.debug('transport.error-skipped', { reason: 'transport-closed', message }); return; }
    const credential = config.credential.trim();
    for (const secret of [credential, encodeURIComponent(credential), handle, encodeURIComponent(handle)]) {
      if (secret) message = message.split(secret).join('[redacted]');
    }
    log.error('transport.failed', { message });
    events.error(message);
  };
  function receive(response: LiveServerMessage) {
    if (closed) { log.debug('transport.message-skipped', { reason: 'transport-closed' }); return; }
    // Some server failures arrive as messages rather than socket error events.
    if ('error' in response) {
      const error = response.error;
      fail(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'Gemini returned an error.');
      return;
    }
    if (!session || !protocol) {
      pending.push(response);
      log.debug('transport.message-buffered', { reason: 'setup-pending', pendingCount: pending.length });
      return;
    }
    try {
      protocol.handle(response);
      if (closed) return;
      const content = response.serverContent;
      if (content) events.content({
        inputText: content.inputTranscription?.text,
        inputTextFinished: content.inputTranscription?.finished,
        outputText: content.outputTranscription?.text,
        audio: (content.modelTurn?.parts ?? []).flatMap(part => {
          const audio = part.inlineData;
          return typeof audio?.data === 'string' && typeof audio.mimeType === 'string' ? [{ data: audio.data, mimeType: audio.mimeType }] : [];
        }),
        interrupted: content.interrupted,
        turnComplete: content.turnComplete,
      });
      if (!closed && response.sessionResumptionUpdate) {
        events.resumption?.({ resumable: response.sessionResumptionUpdate.resumable === true, handle: response.sessionResumptionUpdate.newHandle });
      }
    } catch (error) {
      log.error('transport.response-processing-failed', { error });
      fail('Could not process the Gemini response.');
    }
  }

  // Return immediately so disconnect can cancel a pending connection.
  log.info('transport.connect-requested', { thinkingLevel });
  void client.live.connect({
    model: config.model.trim(),
    config: {
      responseModalities: [Modality.AUDIO],
      ...(thinkingLevel !== undefined ? { thinkingConfig: { thinkingLevel } } : {}),
      inputAudioTranscription: {}, outputAudioTranscription: {},
      systemInstruction: { parts: [{ text: request.systemInstruction }] },
      ...(request.sessionResumption ? { sessionResumption: { ...request.sessionResumption } } : {}),
    },
    callbacks: {
      onmessage: receive,
      onerror: error => { log.error('transport.sdk-error', { error }); fail(CONNECTION_ERROR); },
      onclose: event => {
        log.info('transport.closed-by-server', { code: event.code, reason: event.reason, locallyClosed: closed });
        const reason = event.reason?.trim();
        fail(`Gemini disconnected (${event.code}).${reason ? ` ${reason}` : ''} Retry the interview.`);
      },
    },
  }).then(connected => {
    if (closed) {
      log.debug('transport.late-connection', { reason: 'transport-closed-before-setup', action: 'close-late-session' });
      connected.close(); return;
    }
    session = connected;
    protocol = new GeminiProtocolSession(connected, request.initialTurns, log);
    // The SDK resolves after setup; callbacks can arrive before this continuation.
    protocol.handle({ setupComplete: {} });
    if (closed) return;
    log.info('transport.ready', { bufferedCount: pending.length });
    events.ready();
    const buffered = pending;
    pending = [];
    for (const response of buffered) receive(response);
  }).catch(error => { log.error('transport.connect-failed', { error }); fail(CONNECTION_ERROR); });

  return {
    sendText: text => {
      if (closed || !session) {
        log.debug('transport.send-rejected', { reason: closed ? 'transport-closed' : 'setup-pending' });
        return false;
      }
      session.sendRealtimeInput({ text });
      return true;
    },
    sendAudio: audio => { if (!closed && session) session.sendRealtimeInput({ audio }); },
    endAudio: () => { if (!closed && session) session.sendRealtimeInput({ audioStreamEnd: true }); },
    close: () => {
      if (closed) return;
      log.info('transport.close-requested', { setupPending: !session, bufferedCount: pending.length });
      closed = true;
      pending = [];
      const connected = session;
      session = null;
      connected?.close();
    },
  };
}
