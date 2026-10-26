import { useEffect, useRef } from 'react';
import type { ChatInputProps } from './ChatInput.types';

function fitToContent(element: HTMLTextAreaElement) {
  if (!element.clientWidth) return;
  const scrollTop = element.scrollTop;
  element.style.height = 'auto';
  element.style.height = `${Math.min(140, Math.max(40, element.scrollHeight + 2))}px`;
  element.scrollTop = scrollTop;
}

export default function ChatInput({ value, onChange, onSend, sendDisabled }: ChatInputProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    fitToContent(element);
  }, [value]);

  useEffect(() => {
    const element = input.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fitToContent(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <textarea ref={input} rows={1} aria-label="Chat message" aria-describedby="chat-send-shortcut" value={value}
      placeholder="Type a message…" onChange={event => onChange(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey
          || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (!event.repeat && !sendDisabled && value.trim()) onSend();
      }}
      style={{ display: 'block', boxSizing: 'border-box', width: '100%', minWidth: 0, minHeight: 40, maxHeight: 140,
        padding: 8, border: '1px solid #dce1e8', borderRadius: 8, color: '#192334', background: '#fff',
        fontFamily: 'inherit', fontSize: 14, lineHeight: '22px', resize: 'none', overflow: 'auto' }} />
    <span id="chat-send-shortcut" style={{ color: '#64748b', fontSize: 12 }}>Ctrl/Cmd+Enter to send. Enter adds a new line.</span>
  </div>;
}
