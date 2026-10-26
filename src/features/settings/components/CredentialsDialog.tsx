import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { liveConfigured, thinkingConfigured, trimApiConfig, type InterviewApiConfig } from '../../../shared/apiConfig';

type Props = {
  config: InterviewApiConfig;
  requireLive: boolean;
  onContinue(config: InterviewApiConfig): void;
  onCancel(): void;
};

export default function CredentialsDialog({ config, requireLive, onContinue, onCancel }: Props) {
  const [liveKey, setLiveKey] = useState(config.live.credential);
  const [thinkingKey, setThinkingKey] = useState(config.thinking.apiKey);
  const [remember, setRemember] = useState(config.rememberApiKeys);
  const next = { ...config, rememberApiKeys: remember,
    live: { ...config.live, credential: liveKey }, thinking: { ...config.thinking, apiKey: thinkingKey } };
  const valid = (!requireLive || liveConfigured(next.live)) && thinkingConfigured(next.thinking);

  return <Modal transparent visible animationType="fade" onRequestClose={onCancel}>
    <View style={styles.backdrop}>
      <View style={styles.dialog} accessibilityViewIsModal>
        <Text accessibilityRole="header" style={styles.title}>Re-enter API keys</Text>
        <Text style={styles.note}>Your interview progress is restored. Enter the required keys to continue.</Text>
        {requireLive && <>
          <Text style={styles.label}>Live API key or ephemeral token</Text>
          <TextInput accessibilityLabel="Live API key or ephemeral token" autoFocus secureTextEntry autoCapitalize="none" autoCorrect={false}
            value={liveKey} onChangeText={setLiveKey} style={styles.input} />
        </>}
        <Text style={styles.label}>Thinking API key</Text>
        <TextInput accessibilityLabel="Thinking API key" autoFocus={!requireLive} secureTextEntry autoCapitalize="none" autoCorrect={false}
          value={thinkingKey} onChangeText={setThinkingKey} style={styles.input} />
        {thinkingKey.trim().startsWith('auth_tokens/') && <Text accessibilityRole="alert" style={styles.note}>Thinking requires a standard API key, not a Live ephemeral token.</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel="Remember API keys for this session" accessibilityState={{ selected: remember }}
          onPress={() => setRemember(!remember)} style={styles.secondary}>
          <Text>Remember API keys for this session: {remember ? 'On' : 'Off'}</Text>
        </Pressable>
        <Text style={styles.note}>When enabled, both keys are retained within the current browser tab for reloads.</Text>
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={onCancel} style={styles.secondary}><Text>Cancel</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Continue" accessibilityState={{ disabled: !valid }} disabled={!valid}
            onPress={() => { if (valid) onContinue(trimApiConfig(next)); }} style={[styles.primary, !valid && styles.disabled]}>
            <Text style={styles.primaryText}>Continue</Text>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: 'rgba(25,35,52,.35)' },
  dialog: { width: '100%', maxWidth: 440, padding: 24, gap: 12, backgroundColor: '#fff', borderRadius: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#192334' },
  label: { fontSize: 13, fontWeight: '600', color: '#192334' },
  note: { fontSize: 12, lineHeight: 18, color: '#64748b' },
  input: { borderWidth: 1, borderColor: '#dce1e8', borderRadius: 8, padding: 12 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  secondary: { padding: 12, backgroundColor: '#f2f4f7', borderRadius: 8 },
  primary: { padding: 12, backgroundColor: '#334e78', borderRadius: 8 },
  primaryText: { color: '#fff', fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
