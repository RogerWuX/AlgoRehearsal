import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import type { ChatInputProps } from './ChatInput.types';

export default function ChatInput({ value, onChange }: ChatInputProps) {
  const [contentHeight, setContentHeight] = useState(40);
  const height = value ? Math.min(140, Math.max(40, contentHeight)) : 40;
  return <TextInput accessibilityLabel="Chat message" placeholder="Type a message…" multiline value={value}
    onChangeText={onChange} scrollEnabled={!!value && contentHeight > height}
    onContentSizeChange={event => setContentHeight(Math.ceil(event.nativeEvent.contentSize.height) + 2)}
    style={[styles.input, { height }]} />;
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: '#dce1e8', borderRadius: 8, padding: 8, fontSize: 14, lineHeight: 22, color: '#192334',
    minHeight: 40, maxHeight: 140, textAlignVertical: 'top' },
});
