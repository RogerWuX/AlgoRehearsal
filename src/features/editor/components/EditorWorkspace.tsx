import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import CodeEditor from './CodeEditor/CodeEditor';
import DiscussionInput from './DiscussionInput/DiscussionInput';
import EditorTabs from './EditorTabs/EditorTabs';
import LanguageSelector from './LanguageSelector/LanguageSelector';
import type { EditorLanguage, EditorTab } from '../model/types';

type EditorWorkspaceProps = {
  tab: EditorTab;
  onTabChange: (tab: EditorTab) => void;
  problemText: string;
  discussion: string;
  onDiscussionChange: (text: string) => void;
  onDiscussionSend: () => void;
  canSendDiscussion: boolean;
  text: string;
  onTextChange: (text: string) => void;
  language: EditorLanguage;
  onLanguageChange: (language: EditorLanguage) => void;
  results: ReactNode;
  showResults: boolean;
};

export default function EditorWorkspace({ tab, onTabChange, problemText, discussion, onDiscussionChange, onDiscussionSend, canSendDiscussion, text, onTextChange, language, onLanguageChange, results, showResults }: EditorWorkspaceProps) {
  const characterCount = Array.from(text).length;
  const activeTab = showResults ? tab : 'workspace';
  const sendDisabled = !canSendDiscussion || !discussion.trim();
  const sendDiscussion = () => { if (!sendDisabled) onDiscussionSend(); };
  return (
    <View style={styles.card}>
      <View style={styles.editorHeader}>
        <EditorTabs value={activeTab} onChange={onTabChange} showResults={showResults} />
      </View>
      <View nativeID="workspace-panel" role="tabpanel" accessibilityLabel="Workspace" aria-labelledby="workspace-tab" style={activeTab !== 'workspace' && styles.hidden}>
        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.title}>Problem</Text>
          <Text selectable style={styles.problemText}>{problemText}</Text>
        </View>
        <View style={styles.section}>
          <View style={styles.discussionHeader}>
            <Text accessibilityRole="header" style={styles.title}>Discussion</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Send discussion to Live API"
              accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled} onPress={sendDiscussion}
              style={[styles.sendButton, sendDisabled && styles.disabled]}>
              <Text style={styles.sendButtonText}>Send to Live</Text>
            </Pressable>
          </View>
          <DiscussionInput value={discussion} onChange={onDiscussionChange} onSend={sendDiscussion} sendDisabled={sendDisabled} />
          {Platform.OS === 'web' && <Text style={styles.footerText}>Ctrl/Cmd+Enter to send. Enter adds a new line.</Text>}
        </View>
        <View style={styles.codeHeader}>
          <Text accessibilityRole="header" style={styles.title}>Code</Text>
          <LanguageSelector value={language} onChange={onLanguageChange} />
        </View>
        <CodeEditor value={text} onChange={onTextChange} language={language} />
        <View style={styles.editorFooter}>
          <Text style={styles.footerText}>
            {`${characterCount.toLocaleString()} ${characterCount === 1 ? 'character' : 'characters'}`}
          </Text>
        </View>
      </View>
      {showResults && <View nativeID="results-panel" role="tabpanel" accessibilityLabel="Results" aria-labelledby="results-tab" style={activeTab !== 'results' && styles.hidden}>
        {results}
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: '#dce1e8', borderRadius: 16, overflow: 'hidden' },
  editorHeader: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#edf0f4' },
  section: { padding: 20, gap: 12, borderBottomWidth: 1, borderBottomColor: '#edf0f4' },
  discussionHeader: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' },
  sendButton: { backgroundColor: '#334e78', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center' },
  sendButtonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  disabled: { opacity: 0.4 },
  title: { color: '#192334', fontSize: 16, fontWeight: '700' },
  problemText: { color: '#192334', fontSize: 14, lineHeight: 22 },
  codeHeader: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#edf0f4' },
  editorFooter: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1, borderTopColor: '#edf0f4', backgroundColor: '#fafbfc' },
  hidden: { display: 'none' },
  footerText: { color: '#64748b', fontSize: 12 },
});
