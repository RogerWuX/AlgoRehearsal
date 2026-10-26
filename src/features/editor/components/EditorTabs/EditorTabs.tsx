import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { EditorTabsProps } from './EditorTabs.types';
import { editorTabs } from '../../model/types';

export default function EditorTabs({ value, onChange, showResults }: EditorTabsProps) {
  return <View accessibilityRole="tablist" style={styles.tabs}>
    {editorTabs.filter(tab => tab !== 'results' || showResults).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: value === tab }} onPress={() => onChange(tab)} style={[styles.tab, value === tab && styles.active]}>
      <Text style={styles.text}>{tab === 'workspace' ? 'Workspace' : 'Results'}</Text>
    </Pressable>)}
  </View>;
}
const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 4 },
  tab: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8 },
  active: { backgroundColor: '#e9eef5' },
  text: { fontSize: 13, fontWeight: '600', color: '#334e78' },
});
