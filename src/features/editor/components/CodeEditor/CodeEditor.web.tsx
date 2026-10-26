import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import type { CodeEditorProps } from './CodeEditor.types';
import type { EditorLanguage } from '../../model/types';

function languageExtension(language: EditorLanguage) {
  switch (language) {
    case 'JavaScript': return javascript();
    case 'TypeScript': return javascript({ typescript: true });
    case 'Python': return python();
    case 'Java': return java();
    case 'C++': return cpp();
  }
}

const theme = EditorView.theme({
  '&': { color: '#192334', backgroundColor: '#ffffff', fontSize: '16px', minHeight: '360px' },
  '&.cm-focused': { outline: '2px solid #94a3b8', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto', maxHeight: '65vh', minHeight: '360px' },
  '.cm-content': { padding: '20px 0', lineHeight: '26px' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': { backgroundColor: '#fafbfc', color: '#64748b', borderColor: '#edf0f4' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#f1f5f9' },
  '.cm-cursor': { borderLeftColor: '#192334' },
});

export default function CodeEditor({ value, onChange, language, readOnly = false }: CodeEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const readOnlySlot = useRef(new Compartment());
  const languageSlot = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initial = useRef({ value, language, readOnly });

  useEffect(() => {
    if (!container.current) return;
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          lineNumbers(), highlightActiveLine(), highlightActiveLineGutter(), history(),
          indentOnInput(), bracketMatching(), syntaxHighlighting(defaultHighlightStyle),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping, theme,
          EditorView.contentAttributes.of({ 'aria-label': initial.current.readOnly ? 'Problem description' : 'Code editor', 'aria-multiline': 'true', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
          readOnlySlot.current.of([EditorState.readOnly.of(initial.current.readOnly), EditorView.editable.of(!initial.current.readOnly), EditorView.contentAttributes.of({ 'aria-readonly': String(initial.current.readOnly), tabindex: '0' })]),
          languageSlot.current.of(languageExtension(initial.current.language)),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.state.facet(EditorState.readOnly)) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => { view.destroy(); editor.current = null; };
  }, []);

  useEffect(() => {
    editor.current?.dispatch({ effects: languageSlot.current.reconfigure(languageExtension(language)) });
  }, [language]);

  useEffect(() => {
    editor.current?.dispatch({ effects: readOnlySlot.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({ 'aria-readonly': String(readOnly), tabindex: '0' })]) });
  }, [readOnly]);

  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={container} style={{ minWidth: 0 }} />;
}
