import { useState } from 'react';
import { defaultEditorLanguage, type EditorDocument, type EditorLanguage } from '../model/types';
import type { StorageStatus } from '../../../shared/storage';

export default function useEditorDocument(_persist = false) {
  const [document, setDocument] = useState<EditorDocument>({ text: '', language: defaultEditorLanguage });
  function setText(text: string) {
    setDocument(previous => ({ ...previous, text }));
  }
  function setLanguage(language: EditorLanguage) {
    setDocument(previous => ({ ...previous, language }));
  }
  return { ...document, setText, setLanguage, storageStatus: 'session' as StorageStatus };
}
