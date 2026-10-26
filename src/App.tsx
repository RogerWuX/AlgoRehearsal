import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { EditorWorkspace, useEditorDocument, type EditorTab } from './features/editor';
import { ChatPanel, ResultsPanel, formatProblem, useInterviewSession } from './features/interview';
import { CredentialsDialog, SettingsDialog, useSettingsPreferences } from './features/settings';
import { liveConfigured, thinkingConfigured, type InterviewApiConfig } from './shared/apiConfig';

export default function App() {
  useEffect(() => { if (typeof document !== 'undefined') document.title = 'AlgoRehearsal'; }, []);
  const live = useInterviewSession();
  const { configureRecovery, shouldResume, acknowledgeRecovery, resume } = live;
  const { config, saveConfig, storageStatus, credentialStorageStatus } = useSettingsPreferences(live.storedProblemCount);
  const editorDocument = useEditorDocument(config.saveInterviewState);
  const [tab, setTab] = useState<EditorTab>('workspace');
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const showResults = !!(live.judgment.code || live.judgment.interview);
  useEffect(() => {
    setTab(showResults ? 'results' : 'workspace');
  }, [showResults]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<'resume' | 'end' | 'judgment' | null>(null);
  useEffect(() => { configureRecovery(config.saveInterviewState); }, [configureRecovery, config.saveInterviewState]);
  useEffect(() => {
    if (!shouldResume) return;
    acknowledgeRecovery();
    if (liveConfigured(config.live) && thinkingConfigured(config.thinking)) void resume(config, true);
    else setPendingAction('resume');
  }, [shouldResume, acknowledgeRecovery, resume, config]);
  const { width } = useWindowDimensions();

  function continueAction(action: NonNullable<typeof pendingAction>, next: InterviewApiConfig) {
    if (action === 'resume') void live.resume(next);
    else if (action === 'end') void live.endInterview({ code: editorDocument.text, language: editorDocument.language }, next.thinking);
    else void live.retryJudgment(next.thinking);
  }
  function requestAction(action: NonNullable<typeof pendingAction>) {
    if (!thinkingConfigured(config.thinking) || (action === 'resume' && !liveConfigured(config.live))) setPendingAction(action);
    else continueAction(action, config);
  }

  function quitInterview() {
    live.quit();
    editorDocument.setText('');
    setPendingAction(null);
    setTab('workspace');
    // Remount the inputs to discard the chat draft and CodeMirror undo history.
    setWorkspaceRevision(previous => previous + 1);
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.content}>
          <View style={styles.toolbar}>
            <Pressable accessibilityRole="button" onPress={() => setSettingsOpen(true)} style={styles.settingsButton}>
              <Text style={styles.settingsText}>Settings</Text>
            </Pressable>
          </View>
          {storageStatus === 'unavailable' && <Text accessibilityRole="alert" style={styles.storageWarning}>
            Browser storage is unavailable. Settings apply to this session only.
          </Text>}
          {!!live.recoveryWarning && <Text accessibilityRole="alert" style={styles.storageWarning}>{live.recoveryWarning}</Text>}
          {editorDocument.storageStatus === 'unavailable' && <Text accessibilityRole="alert" style={styles.storageWarning}>
            Editor progress could not be saved. Progress is kept for this session only.
          </Text>}
          {credentialStorageStatus === 'unavailable' && <Text accessibilityRole="alert" style={styles.storageWarning}>
            API keys could not be remembered. Re-enter them when needed.
          </Text>}

          <View style={[styles.workspace, width < 900 && styles.stacked]}>
            <View style={width < 900 ? styles.chatNarrow : styles.chatColumn}>
              <ChatPanel
                key={workspaceRevision}
                live={live}
                configured={liveConfigured(config.live) && thinkingConfigured(config.thinking) && (config.problemSource !== 'stored' || live.storedProblemCount > 0)}
                useStoredQuestions={config.problemSource === 'stored'}
                retryConfigured={liveConfigured(config.live) && thinkingConfigured(config.thinking)}
                onOpenSettings={() => setSettingsOpen(true)}
                onStart={() => void live.connect(config)}
                onRetry={() => void live.retry(config)}
                onResume={() => requestAction('resume')}
                onEnd={() => requestAction('end')}
                onQuit={quitInterview}
                onRetryJudgment={() => requestAction('judgment')}
              />
            </View>
            <View style={styles.editorColumn}>
              <EditorWorkspace
                key={workspaceRevision}
                tab={showResults ? tab : 'workspace'}
                showResults={showResults}
                onTabChange={setTab}
                problemText={live.problem ? formatProblem(live.problem) : 'Start an interview to select a problem.'}
                discussion={live.discussion}
                onDiscussionChange={live.setDiscussion}
                onDiscussionSend={() => { live.send(live.discussion, { kind: 'discussion' }); }}
                canSendDiscussion={live.status === 'connected'}
                text={editorDocument.text}
                onTextChange={editorDocument.setText}
                language={editorDocument.language}
                onLanguageChange={editorDocument.setLanguage}
                results={<ResultsPanel judgment={live.judgment} retryConfigured={thinkingConfigured(config.thinking)}
                  onRetry={() => requestAction('judgment')} onCancel={live.cancelJudgment} onOpenSettings={() => requestAction('judgment')} />}
              />
            </View>
          </View>
        </View>
      </ScrollView>
      {settingsOpen && <SettingsDialog
        config={config}
        locked={live.status !== 'disconnected'}
        storedProblemCount={live.storedProblemCount}
        questionImportWarning={live.questionImportWarning}
        preferenceStorageStatus={storageStatus}
        credentialStorageStatus={credentialStorageStatus}
        onClose={() => setSettingsOpen(false)}
        onSave={next => { saveConfig(next); setSettingsOpen(false); }}
      />}
      {pendingAction && <CredentialsDialog config={config} requireLive={pendingAction === 'resume'}
        onCancel={() => { if (pendingAction === 'resume') live.disconnect(); setPendingAction(null); }}
        onContinue={next => { saveConfig(next); setPendingAction(null); continueAction(pendingAction, next); }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f5f6f8' },
  page: { flexGrow: 1, paddingHorizontal: 20, paddingVertical: 20, alignItems: 'center' },
  content: { width: '100%', maxWidth: 1400 },
  workspace: { flexDirection: 'row', gap: 24, alignItems: 'flex-start' },
  stacked: { flexDirection: 'column' },
  chatColumn: { width: 360 },
  chatNarrow: { width: '100%' },
  editorColumn: { flex: 1, minWidth: 0, width: '100%' },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginBottom: 12 },
  storageWarning: { color: '#64748b', fontSize: 12, marginBottom: 12 },
  settingsButton: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, backgroundColor: '#e9eef5' },
  settingsText: { color: '#334e78', fontSize: 13, fontWeight: '600' },
});
