import type { Session } from '@google/genai/web';
import { logger as appLogger, type Logger } from '../../../../../shared/logger';
import type { TransportTurn } from '../../../model/transport';

type FunctionCall = { id?: string; name?: string; args?: unknown };
export type ProtocolMessage = {
  setupComplete?: object;
  toolCall?: { functionCalls?: FunctionCall[] };
  toolCallCancellation?: { ids?: string[] };
};

// One instance per SDK session: setup sends prepared content exactly once.
export class GeminiProtocolSession {
  private started = false;
  private canceled = new Set<string>();
  private handled = new Set<string>();

  constructor(
    private session: Pick<Session, 'sendClientContent' | 'sendToolResponse'>,
    private initialTurns: readonly TransportTurn[],
    private logger: Logger = appLogger,
  ) {}

  handle(message: ProtocolMessage) {
    for (const id of message.toolCallCancellation?.ids ?? []) {
      this.canceled.add(id);
      this.logger.debug('protocol.tool-canceled', { callId: id });
    }
    if (message.setupComplete && this.started) this.logger.debug('protocol.setup-skipped', { reason: 'initial-content-already-handled' });
    if (message.setupComplete && !this.started) {
      this.started = true;
      if (this.initialTurns.length) {
        this.session.sendClientContent({
          turns: this.initialTurns.map(({ role, text }) => ({ role, parts: [{ text }] })),
          turnComplete: true,
        });
        this.logger.debug('protocol.initial-content-sent', { turnCount: this.initialTurns.length });
      }
    }
    const functionResponses = [];
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (!call.id || !call.name) {
        this.logger.warn('protocol.tool-skipped', { reason: 'malformed-call' });
        continue;
      }
      if (this.canceled.has(call.id) || this.handled.has(call.id)) {
        this.logger.debug('protocol.tool-skipped', { callId: call.id, reason: this.canceled.has(call.id) ? 'canceled' : 'already-handled' });
        continue;
      }
      this.handled.add(call.id);
      const response = { error: { message: `Unknown tool: ${call.name}` } };
      this.logger.warn('protocol.tool-rejected', { callId: call.id, name: call.name, reason: 'unknown-tool' });
      functionResponses.push({ id: call.id, name: call.name, response });
    }
    if (functionResponses.length) this.session.sendToolResponse({ functionResponses });
  }
}
