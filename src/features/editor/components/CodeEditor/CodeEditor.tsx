import { TextInput, StyleSheet } from 'react-native';
import type { CodeEditorProps } from './CodeEditor.types';

export default function CodeEditor({ value, onChange, readOnly = false }: CodeEditorProps) {
  return <TextInput accessibilityLabel={readOnly ? "Problem description" : "Code editor"} editable={!readOnly} multiline value={value} onChangeText={onChange}
    placeholder={readOnly ? "Start an interview to select a problem." : "Start writing code here…"} placeholderTextColor="#8b929e" textAlignVertical="top" style={styles.editor} />;
}

const styles = StyleSheet.create({
  editor: { minHeight: 360, padding: 24, color: '#192334', fontSize: 16, lineHeight: 26, fontFamily: 'monospace' },
});
