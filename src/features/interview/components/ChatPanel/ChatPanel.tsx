import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { InterviewController } from '../../session/types';
import ChatInput from '../ChatInput/ChatInput';
import MicrophoneIcon from '../MicrophoneIcon';

type ChatPanelProps = {
  live: Pick<InterviewController, 'messages' | 'status' | 'error' | 'listening' | 'canRetry' | 'send' | 'toggleMic' | 'judgment' | 'cancelJudgment' | 'canResume' | 'recoveryNotice' | 'audioNeedsInteraction' | 'enableAudio'>;
  configured: boolean;
  useStoredQuestions?: boolean;
  retryConfigured: boolean;
  onOpenSettings: () => void;
  onStart: () => void;
  onRetry: () => void;
  onResume: () => void;
  onEnd: () => void;
  onQuit: () => void;
  onRetryJudgment: () => void;
};

export default function ChatPanel({ live, configured, useStoredQuestions, retryConfigured, onOpenSettings, onStart, onRetry, onResume, onEnd, onQuit, onRetryJudgment }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const history = useRef<ScrollView>(null);
  const connected = live.status === 'connected';
  const hasFeedback = !!(live.judgment.code || live.judgment.interview);
  const gradingUnfinished = live.status === 'disconnected' && !!live.judgment.submission && !hasFeedback;
  let sessionMessage = 'Ready to practice your interview?';
  if (live.judgment.submission) sessionMessage = hasFeedback
    ? 'Interview ended. Review your Results or start a new interview.'
    : 'Interview ended. Grading is unfinished. Retry grading or start a new interview.';
  if (!configured) sessionMessage = useStoredQuestions
    ? 'Configure the Live and Thinking APIs and make sure stored questions are available to get started.'
    : 'Configure the Live and thinking API keys and models to get started.';
  const sendDisabled = !connected || !draft.trim();
  const send = () => { if (!sendDisabled && live.send(draft)) setDraft(''); };
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>Chat history</Text>
        <Text style={styles.status}>Gemini Live · {live.status}</Text>
      </View>
      {!!live.error && <Text accessibilityRole="alert" style={styles.error}>{live.error}</Text>}
      {!!live.recoveryNotice && <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={styles.empty}>{live.recoveryNotice}</Text>}
      {connected && live.audioNeedsInteraction && <Pressable accessibilityRole="button" onPress={() => void live.enableAudio()} style={styles.secondaryButton}>
        <Text style={styles.micText}>Enable audio</Text>
      </Pressable>}
      {(live.status === 'selecting' || live.status === 'connecting') && <View style={styles.session}>
        <Text style={styles.empty}>{live.status === 'selecting' ? 'Selecting a problem…' : 'Connecting interviewer…'}</Text>
        <Pressable accessibilityRole="button" onPress={onQuit} style={styles.secondaryButton}>
          <Text style={styles.micText}>Cancel connection</Text>
        </Pressable>
      </View>}
      {connected && <View style={styles.endActions}>
        <Pressable accessibilityRole="button" accessibilityHint="Quit without evaluation and clear the workspace." onPress={onQuit} style={styles.secondaryButton}><Text style={styles.micText}>Quit interview</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={onEnd} style={styles.button}><Text style={styles.buttonText}>End interview</Text></Pressable>
      </View>}
      {live.status === 'judging' && <View style={styles.session}>
        <Text accessibilityLiveRegion="polite" style={styles.empty}>Interview ended. Judging {live.judgment.phase === 'interview' ? 'interview performance' : 'code'}…</Text>
        <Pressable accessibilityRole="button" onPress={live.cancelJudgment} style={styles.secondaryButton}><Text style={styles.micText}>Cancel grading</Text></Pressable>
      </View>}
      {live.status === 'disconnected' && <View style={styles.session}>
        {gradingUnfinished && <>
          {(['code', 'interview'] as const).map(kind => live.judgment.errors[kind] && <Text key={kind} accessibilityRole="alert" style={styles.error}>
            {kind === 'code' ? 'Code' : 'Interview'}: {live.judgment.errors[kind]}
          </Text>)}
          <Pressable accessibilityRole="button" onPress={onRetryJudgment} style={styles.button}>
            <Text style={styles.buttonText}>Retry grading</Text>
          </Pressable>
        </>}
        {live.canResume && <Pressable accessibilityRole="button" onPress={onResume} style={styles.button}>
          <Text style={styles.buttonText}>Resume interview</Text>
        </Pressable>}
        <Text style={styles.empty}>{sessionMessage}</Text>
        <Pressable accessibilityRole="button" onPress={configured ? onStart : onOpenSettings} style={styles.button}>
          <Text style={styles.buttonText}>{configured ? 'Start interview' : 'Open settings'}</Text>
        </Pressable>
      </View>}
      {live.status === 'disconnected' && live.canRetry && !live.canResume && retryConfigured && <Pressable accessibilityRole="button" onPress={onRetry} style={styles.secondaryButton}>
        <Text style={styles.micText}>Retry interviewer with selected problem</Text>
      </Pressable>}
      <ScrollView ref={history} style={styles.history} contentContainerStyle={styles.messages} onContentSizeChange={() => history.current?.scrollToEnd({ animated: true })}>
        {connected && live.messages.length === 0 && <Text style={styles.empty}>The interviewer is preparing the first question…</Text>}
        {live.messages.map(message => message.kind === 'discussion' ? (
          <View key={message.id} style={styles.discussionNotice}>
            <Text style={styles.discussionNoticeText}>Discussion sent</Text>
          </View>
        ) : (
          <View key={message.id} style={[styles.message, message.role === 'user' && styles.userMessage]}>
            <Text style={styles.role}>{message.role === 'user' ? 'You' : 'Gemini'}</Text>
            <Text selectable style={styles.messageText}>{message.text}</Text>
          </View>
        ))}
      </ScrollView>
      {connected && <View style={styles.composer}>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel={live.listening ? 'Disable microphone' : 'Enable microphone'}
            accessibilityState={{ selected: live.listening }} onPress={() => void live.toggleMic()}
            style={[styles.microphoneButton, !live.listening && styles.microphoneMuted]}>
            <MicrophoneIcon enabled={live.listening} />
          </Pressable>
          <View style={styles.textInput}>
            <ChatInput value={draft} onChange={setDraft} onSend={send} sendDisabled={sendDisabled} />
          </View>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: sendDisabled }} disabled={sendDisabled} onPress={send} style={[styles.sendButton, sendDisabled && styles.disabled]}>
            <Text style={styles.micText}>Send</Text>
          </Pressable>
        </View>
      </View>}
    </View>
  );
}
const styles = StyleSheet.create({
  panel: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#dce1e8', borderRadius: 16, overflow: 'hidden', height: 720 },
  header: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#edf0f4' },
  title: { fontSize: 18, fontWeight: '700', color: '#192334' },
  status: { fontSize: 12, color: '#64748b', marginTop: 6 },
  session: { gap: 16, padding: 20 },
  secondaryButton: { alignItems: 'center', padding: 12 },
  endActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: 12 },
  button: { backgroundColor: '#334e78', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 11, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  error: { color: '#b42318', fontSize: 12, lineHeight: 18, padding: 16 },
  history: { flex: 1 }, messages: { padding: 16, gap: 12 },
  empty: { color: '#64748b', fontSize: 14, lineHeight: 22 },
  message: { padding: 12, borderRadius: 10, backgroundColor: '#f2f4f7' },
  userMessage: { backgroundColor: '#e9f0fb' },
  discussionNotice: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#f5f6f8' },
  discussionNoticeText: { color: '#64748b', fontSize: 12, textAlign: 'center' },
  role: { fontSize: 11, fontWeight: '700', color: '#475569', marginBottom: 6 },
  messageText: { fontSize: 14, lineHeight: 22, color: '#192334' },
  composer: { padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: '#edf0f4' },
  actions: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  textInput: { flex: 1, minWidth: 0 },
  microphoneButton: { backgroundColor: '#334e78', borderRadius: 22, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  microphoneMuted: { backgroundColor: '#edf0f4' },
  sendButton: { borderWidth: 1, borderColor: '#dce1e8', borderRadius: 8, minHeight: 40, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  micText: { color: '#334e78', fontSize: 12, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
