import type { ChatMessage } from '../model/chat';

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();

// Typed notes can echo in transcription fragments, including one model turn
// late. Stop matching after two completed turns or any distinct spoken input.
export class DiscussionEchoMatcher {
  private pending: { alternatives: string[]; turns: number }[] = [];
  private buffered = '';
  private discardWhitespace = false;

  register(text: string, payload = text) {
    const value = normalize(text);
    if (value) this.pending.push({ alternatives: [...new Set([value, normalize(payload)])], turns: 0 });
  }

  reset(messages: readonly ChatMessage[] = [], formatDiscussionMessage?: (text: string) => string) {
    this.pending = [];
    this.buffered = '';
    this.discardWhitespace = false;
    for (const message of messages) if (message.kind === 'discussion') this.register(message.text, formatDiscussionMessage?.(message.text));
  }

  read(text = '', finished?: boolean): string {
    if (this.discardWhitespace && !text.trim()) {
      if (finished) this.discardWhitespace = false;
      return '';
    }
    this.discardWhitespace = false;
    const combined = this.buffered + text;
    const value = normalize(combined);
    const match = this.pending.findIndex(({ alternatives }) => alternatives.includes(value));
    if (match !== -1 && finished !== false) {
      this.pending.splice(match, 1);
      this.buffered = '';
      this.discardWhitespace = !finished;
      return '';
    }
    if (!finished && this.pending.some(({ alternatives }) => alternatives.some(expected => expected.startsWith(value)))) {
      this.buffered = combined;
      return '';
    }
    this.buffered = '';
    if (value) this.pending = [];
    return combined;
  }

  endTurn(): string {
    this.pending = this.pending.filter(note => ++note.turns < 2);
    const value = normalize(this.buffered);
    if (!this.buffered || this.pending.some(({ alternatives }) => alternatives.some(expected => expected.startsWith(value)))) return '';
    return this.read('', true);
  }

  flush(): string {
    return this.read('', true);
  }
}
