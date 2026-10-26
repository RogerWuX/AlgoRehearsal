export const editorLanguages = ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++'] as const;
export type EditorLanguage = (typeof editorLanguages)[number];
export const defaultEditorLanguage: EditorLanguage = 'C++';
export interface EditorDocument {
  text: string;
  language: EditorLanguage;
}
export const editorTabs = ['workspace', 'results'] as const;
export type EditorTab = (typeof editorTabs)[number];
