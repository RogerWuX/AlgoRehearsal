import type { ChatMessage } from './types';

export type Transcript = {
  messages: ChatMessage[];
  sequence: number;
  active: Partial<Record<ChatMessage['role'], number>>;
};

export function emptyTranscript(sequence = 0): Transcript {
  return { messages: [], sequence, active: {} };
}

export function appendTranscript(state: Transcript, role: ChatMessage['role'], text: string, fresh = false, kind?: ChatMessage['kind']): Transcript {
  if (!text) return state;
  const existing = fresh ? undefined : state.active[role];
  const id = existing ?? state.sequence + 1;
  return {
    sequence: existing === undefined ? id : state.sequence,
    active: { ...state.active, [role]: id },
    messages: existing === undefined
      ? [...state.messages, { id, role, text, ...(kind ? { kind } : {}) }]
      : state.messages.map(item => item.id === id ? { ...item, text: item.text + text } : item),
  };
}

export function finishTurn(state: Transcript): Transcript {
  return { ...state, active: {} };
}

export function interruptTranscript(state: Transcript): Transcript {
  return { ...state, active: { ...state.active, model: undefined } };
}
