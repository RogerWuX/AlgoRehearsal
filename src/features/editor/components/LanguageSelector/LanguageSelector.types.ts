import type { EditorLanguage } from '../../model/types';

export interface LanguageSelectorProps {
  value: EditorLanguage;
  onChange: (language: EditorLanguage) => void;
}
