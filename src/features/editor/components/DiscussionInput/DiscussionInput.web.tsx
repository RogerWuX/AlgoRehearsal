import { useEffect, useRef } from 'react';
import type { DiscussionInputProps } from './DiscussionInput.types';

function fitToContent(input: HTMLTextAreaElement) {
  // Hidden workspace panels have no layout measurements; keep the user's size.
  if (!input.clientWidth) return;
  const scrollTop = input.scrollTop;
  // Reset before measuring so deleting content can shrink the field too.
  input.style.height = 'auto';
  input.style.height = `${Math.max(120, input.scrollHeight + 2)}px`;
  input.scrollTop = scrollTop;
}

export default function DiscussionInput({ value, onChange, onSend, sendDisabled }: DiscussionInputProps) {
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (input.current) fitToContent(input.current);
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

  return <textarea ref={input} aria-label="Discussion" value={value} placeholder="Write your approach or mindset…"
    onChange={event => { fitToContent(event.currentTarget); onChange(event.currentTarget.value); }}
    onKeyDown={event => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey
        || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      event.preventDefault();
      if (!event.repeat && !sendDisabled && value.trim()) onSend();
    }}
    style={{ display: 'block', boxSizing: 'border-box', width: '100%', minWidth: 0, minHeight: 120, maxHeight: '65vh',
      padding: 12, border: '1px solid #dce1e8', borderRadius: 8, color: '#192334', background: '#ffffff',
      fontFamily: 'inherit', fontSize: 14, lineHeight: '22px', resize: 'none', overflow: 'auto' }} />;
}
