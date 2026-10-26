import { useState } from 'react';
import { StyleSheet, TextInput, useWindowDimensions } from 'react-native';
import type { DiscussionInputProps } from './DiscussionInput.types';

export default function DiscussionInput({ value, onChange }: DiscussionInputProps) {
  const [contentHeight, setContentHeight] = useState(120);
  const { height: windowHeight } = useWindowDimensions();
  const height = Math.min(contentHeight, Math.max(120, Math.floor(windowHeight * 0.65)));
  return <TextInput accessibilityLabel="Discussion" multiline value={value} onChangeText={onChange}
    placeholder="Write your approach or mindset…" placeholderTextColor="#8b929e" textAlignVertical="top" scrollEnabled={contentHeight > height}
    onContentSizeChange={event => setContentHeight(Math.max(120, Math.ceil(event.nativeEvent.contentSize.height) + 2))}
    style={[styles.input, { height }]} />;
}

const styles = StyleSheet.create({
  input: { minHeight: 120, padding: 12, borderWidth: 1, borderColor: '#dce1e8', borderRadius: 8, color: '#192334', fontSize: 14, lineHeight: 22 },
});
