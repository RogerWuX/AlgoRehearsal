import type { EditorLanguage } from '../../model/types';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: EditorLanguage;
  readOnly?: boolean;
}
