import { useRef } from 'react';
import type { EditorTabsProps } from './EditorTabs.types';
import type { EditorTab } from '../../model/types';
import { editorTabs } from '../../model/types';
export default function EditorTabs({ value, onChange, showResults }: EditorTabsProps) {
  const buttons = useRef<Partial<Record<EditorTab, HTMLButtonElement | null>>>({});
  const visibleTabs = editorTabs.filter(tab => tab !== 'results' || showResults);
  return <div role="tablist" aria-label="Workspace" style={{ display: 'flex', gap: 4 }}>
    {visibleTabs.map(tab => <button key={tab} ref={element => { buttons.current[tab] = element; }} id={`${tab}-tab`} role="tab" aria-selected={value === tab} aria-controls={`${tab}-panel`} tabIndex={value === tab ? 0 : -1}
      onClick={() => onChange(tab)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = visibleTabs.indexOf(tab);
        const next = event.key === 'Home' ? visibleTabs[0] : event.key === 'End' ? visibleTabs[visibleTabs.length - 1]
          : visibleTabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length];
        onChange(next); buttons.current[next]?.focus();
      }} style={{ border: 0, borderRadius: 8, padding: '9px 14px', background: value === tab ? '#e9eef5' : 'transparent', color: '#334e78', fontFamily: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
      {tab === 'workspace' ? 'Workspace' : 'Results'}
    </button>)}
  </div>;
}
