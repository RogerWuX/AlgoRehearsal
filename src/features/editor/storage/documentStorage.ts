import type { KeyValueStorage } from '../../../shared/storage';
import { defaultEditorLanguage, editorLanguages, type EditorDocument } from '../model/types';

export const EDITOR_DOCUMENT_STORAGE_KEY = 'interview-practice.editor.document';

export function readDocument(storage: Pick<KeyValueStorage, 'getItem'>): EditorDocument {
  const stored = storage.getItem(EDITOR_DOCUMENT_STORAGE_KEY);
  if (stored !== null) {
    try {
      const document = JSON.parse(stored);
      if (document?.version === 1 && typeof document.text === 'string') {
        return {
          text: document.text,
          language: editorLanguages.includes(document.language) ? document.language : defaultEditorLanguage,
        };
      }
    } catch {
      // Invalid documents restore an empty draft.
    }
  }
  return { text: '', language: defaultEditorLanguage };
}

export function writeDocument(storage: Pick<KeyValueStorage, 'setItem'>, document: EditorDocument): void {
  storage.setItem(EDITOR_DOCUMENT_STORAGE_KEY, JSON.stringify({ version: 1, ...document }));
}

export function clearDocument(storage: Pick<Storage, 'removeItem'>): void {
  storage.removeItem(EDITOR_DOCUMENT_STORAGE_KEY);
}
