import { editorLanguages } from '../../model/types';
import type { EditorLanguage } from '../../model/types';
import type { LanguageSelectorProps } from './LanguageSelector.types';

export default function LanguageSelector({ value, onChange }: LanguageSelectorProps) {
  return <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#64748b', fontSize: 12 }}>
    Language
    <select value={value} onChange={event => onChange(event.target.value as EditorLanguage)}
      style={{ background: '#f1f5f9', color: '#334155', border: '1px solid #dce1e8', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}>
      {editorLanguages.map(language => <option key={language} value={language}>{language}</option>)}
    </select>
  </label>;
}
