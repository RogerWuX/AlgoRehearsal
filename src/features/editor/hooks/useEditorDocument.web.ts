import { useEffect, useRef, useState } from 'react';
import { clearDocument, readDocument, writeDocument } from '../storage/documentStorage';
import { defaultEditorLanguage, type EditorDocument, type EditorLanguage } from '../model/types';
import type { StorageStatus } from '../../../shared/storage';
import { logger } from '../../../shared/logger';

const log = logger.child({ scope: 'editor-storage' });

function readStoredDocument(persist: boolean): EditorDocument & { storageStatus: StorageStatus } {
  const empty = { text: '', language: defaultEditorLanguage };
  if (!persist) return { ...empty, storageStatus: 'session' };
  try {
    if (typeof window === 'undefined') {
      log.debug('editor.restore-skipped', { reason: 'browser-storage-unavailable', fallback: 'session' });
      return { ...empty, storageStatus: 'session' };
    }
    const document = readDocument(window.localStorage);
    log.info('editor.restored', { source: 'local-storage', characters: document.text.length });
    return {
      ...document,
      storageStatus: 'saved',
    };
  } catch (error) {
    log.warn('editor.restore-failed', { error, fallback: 'session' });
    return { ...empty, storageStatus: 'unavailable' };
  }
}

function saveDocument(document: EditorDocument, persist: boolean, previousStatus: StorageStatus): StorageStatus {
  if (typeof window === 'undefined') return 'session';
  try {
    if (!persist) {
      clearDocument(window.localStorage);
      return 'session';
    }
    writeDocument(window.localStorage, { text: document.text, language: document.language });
    if (previousStatus !== 'saved') log.info('editor.storage-recovered', { from: previousStatus, to: 'saved' });
    return 'saved';
  } catch (error) {
    if (previousStatus !== 'unavailable') log.warn('editor.storage-unavailable', { error, fallback: 'session' });
    return 'unavailable';
  }
}

export default function useEditorDocument(persist = false) {
  const [state, setState] = useState(() => readStoredDocument(persist));
  const current = useRef(state);
  const appliedPersistence = useRef<boolean | null>(null);

  // Preference changes save or remove the current draft; setters save edits immediately.
  useEffect(() => {
    if (appliedPersistence.current === persist) return;
    appliedPersistence.current = persist;
    const storageStatus = saveDocument(current.current, persist, current.current.storageStatus);
    current.current = { ...current.current, storageStatus };
    setState(current.current);
  }, [persist]);

  function updateDocument(update: Partial<EditorDocument>) {
    const document = { ...current.current, ...update };
    // The ref preserves both fields across successive updates before React rerenders.
    current.current = { ...document, storageStatus: persist ? saveDocument(document, persist, document.storageStatus) : document.storageStatus };
    setState(current.current);
  }

  function setText(text: string) {
    // With recovery disabled, editing never writes the draft to browser storage.
    updateDocument({ text });
  }

  function setLanguage(language: EditorLanguage) {
    updateDocument({ language });
  }

  return { ...state, setText, setLanguage };
}
