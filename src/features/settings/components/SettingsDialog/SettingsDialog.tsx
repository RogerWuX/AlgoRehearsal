import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import type { SettingsDialogProps } from './SettingsDialog.types';
import { LIVE_MODELS, THINKING_MODELS, requiresStandardThinkingKey, type SelectOption } from '../../../../shared/apiConfig';
import useSettingsDraft from '../../hooks/useSettingsDraft';
import { questionSources } from '../../model/questionSources';
import {
  SETTINGS_SIDEBAR_BREAKPOINT, SETTINGS_DIALOG_WIDTH, SETTINGS_DIALOG_HEIGHT, SETTINGS_DIALOG_MARGIN,
  settingsCategories, type SettingsCategoryId,
} from '../../model/settingsCategories';

const nativeCategories = settingsCategories.filter(category => category.id !== 'diagnostics');

function ModelDropdown({ label, value, options, locked, onChange }: {
  label: string; value: string; options: readonly SelectOption[]; locked: boolean; onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <View style={styles.dropdown}>
    <Text style={styles.label}>{label}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: locked, expanded }} disabled={locked}
      onPress={() => setExpanded(!expanded)} style={styles.input}>
      <Text>{options.find(option => option.value === value)?.label ?? value} ▾</Text>
    </Pressable>
    {expanded && !locked && options.map(option => <Pressable key={option.value} accessibilityRole="radio"
      accessibilityState={{ checked: option.value === value }} onPress={() => { onChange(option.value); setExpanded(false); }} style={styles.input}>
      <Text>{option.label}</Text>
    </Pressable>)}
  </View>;
}

export default function SettingsDialog({ config, locked, storedProblemCount = 0, questionImportWarning = '', credentialStorageStatus = 'session', onClose, onSave }: SettingsDialogProps) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('interview');
  const categoryButtons = useRef<Partial<Record<SettingsCategoryId, View | null>>>({});
  const { width, height } = useWindowDimensions();
  const wide = width >= SETTINGS_SIDEBAR_BREAKPOINT;
  const { draft, updateLive, updateThinking, updateProblemSource, updateProblemSearchDescription, updateSaveSearchedProblems, updateRecovery, thinkingLocked, savingSearchedProblemsLocked, valid, save } = useSettingsDraft(config, locked, onSave, storedProblemCount);
  const liveEffort = LIVE_MODELS.find(option => option.value === draft.live.model)?.thinkingEffort;
  const storedMode = draft.problemSource === 'stored';

  function selectCategory(category: SettingsCategoryId) {
    setActiveCategory(category);
  }

  useEffect(() => {
    const button = categoryButtons.current[activeCategory];
    const handle = button ? findNodeHandle(button) : null;
    if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
  }, [activeCategory]);

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.dialog, { height: Math.min(SETTINGS_DIALOG_HEIGHT, Math.max(0, height - SETTINGS_DIALOG_MARGIN * 2)) }]} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>Settings</Text>
          </View>
          <View style={[styles.body, wide && styles.wideBody]}>
            <ScrollView horizontal={!wide} style={wide ? styles.sidebar : styles.tabs}
              contentContainerStyle={wide ? styles.sidebarContent : styles.tabsContent} keyboardShouldPersistTaps="handled">
              <View accessibilityRole="tablist" accessibilityLabel="Settings categories" style={wide ? styles.sidebarContent : styles.tabsContent}>
                {nativeCategories.map(category => <Pressable key={category.id} ref={element => { categoryButtons.current[category.id] = element; }} nativeID={`settings-${category.id}-tab`}
                  accessibilityRole="tab" accessibilityLabel={category.label} accessibilityState={{ selected: activeCategory === category.id }}
                  onPress={() => selectCategory(category.id)} style={[styles.categoryTab, activeCategory === category.id && styles.activeTab]}>
                  <Text style={styles.tabText}>{category.label}</Text>
                </Pressable>)}
              </View>
            </ScrollView>
            <ScrollView key={activeCategory} nativeID="settings-category-panel" role="tabpanel"
              aria-labelledby={`settings-${activeCategory}-tab`} accessibilityLabel={nativeCategories.find(category => category.id === activeCategory)?.label}
              style={styles.panel} contentContainerStyle={styles.panelContent} keyboardShouldPersistTaps="handled">
              <Text accessibilityRole="header" style={styles.categoryTitle}>{nativeCategories.find(category => category.id === activeCategory)?.label}</Text>
              {activeCategory === 'interview' && <>
                <View style={styles.section}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>Question source</Text>
                  <View accessibilityRole="radiogroup" accessibilityLabel="Question source" style={styles.sourceChoices}>
                    {questionSources.map(option => {
                      const selected = draft.problemSource === option.value;
                      const disabled = locked || (option.value === 'stored' && storedProblemCount === 0);
                      return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label}
                        accessibilityHint={option.value === 'stored' && storedProblemCount === 0 ? 'No local questions yet.' : undefined}
                        accessibilityState={{ checked: selected, disabled }} disabled={disabled}
                        onPress={() => updateProblemSource(option.value)} style={[styles.sourceChoice, selected && styles.selectedSource, disabled && styles.disabled]}>
                        <Text style={styles.label}>{option.label}</Text>
                      </Pressable>;
                    })}
                  </View>
                  {storedProblemCount === 0 && <Text style={styles.note}>No local questions yet.</Text>}
                  {storedMode ? <>
                    {storedProblemCount > 0 && <>
                      <Text style={styles.note}>{`${storedProblemCount} ${storedProblemCount === 1 ? 'question' : 'questions'} available`}</Text>
                      <Text style={styles.note}>Pick a random question from your local collection.</Text>
                    </>}
                  </> : <>
                    <Text style={styles.label}>Problem description (optional)</Text>
                    <TextInput accessibilityLabel="Problem description (optional)" multiline editable={!locked}
                      accessibilityHint="Describe the topic, difficulty, or problem you want. Leave blank for the default search."
                      value={draft.problemSearchDescription} onChangeText={updateProblemSearchDescription}
                      placeholder="A medium graph problem about shortest paths, preferably from LeetCode."
                      style={[styles.input, styles.descriptionInput]} />
                    <Text style={styles.note}>Describe the topic, difficulty, or problem you want. Leave blank for the default search.</Text>
                    <Text style={styles.label}>Save found questions</Text>
                    <Switch accessibilityLabel="Save found questions" disabled={savingSearchedProblemsLocked}
                      value={draft.saveSearchedProblems} onValueChange={updateSaveSearchedProblems} />
                    <Text style={styles.note}>Add web questions to your local collection for future interviews.</Text>
                  </>}
                </View>
                <View style={styles.section}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>Interview recovery</Text>
                  <Text style={styles.label}>Save interview progress</Text>
                  <Switch accessibilityLabel="Save interview progress" disabled={locked}
                    value={draft.saveInterviewState} onValueChange={checked => updateRecovery({ saveInterviewState: checked })} />
                  <Text style={styles.note}>Restore your code, problem, discussion, and feedback when you reopen the app. Unfinished interviews reconnect automatically in the web app. When off, code, problem, discussion, and feedback clear when you reopen the app.</Text>
                </View>
              </>}
              {activeCategory === 'model' && <>
                <View style={styles.section}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>Live API</Text>
                  <Text style={styles.note}>Used by the voice interviewer.</Text>
                  <Text style={styles.label}>API key or token</Text>
                  <TextInput accessibilityLabel="API key or token" secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!locked} value={draft.live.credential} onChangeText={credential => updateLive({ credential })} style={styles.input} />
                  <Text style={styles.note}>Accepts a standard API key or a Live ephemeral token.</Text>
                  <ModelDropdown label="Live model" value={draft.live.model} options={LIVE_MODELS} locked={locked} onChange={model => updateLive({ model })} />
                  {!!liveEffort?.options.length && <ModelDropdown label="Thinking effort" value={draft.live.thinkingEffort ?? liveEffort.defaultValue}
                    options={liveEffort.options} locked={locked} onChange={thinkingEffort => updateLive({ thinkingEffort })} />}
                </View>
                <View style={styles.section}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>Thinking API</Text>
                  <Text style={styles.note}>Used to select problems and give separate code and interview feedback.</Text>
                  <Text style={styles.label}>Thinking API key</Text>
                  <TextInput accessibilityLabel="Thinking API key" secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!thinkingLocked} value={draft.thinking.apiKey} onChangeText={apiKey => updateThinking({ apiKey })} style={styles.input} />
                  <ModelDropdown label="Thinking model" value={draft.thinking.model} options={THINKING_MODELS} locked={thinkingLocked} onChange={model => updateThinking({ model })} />
                  {requiresStandardThinkingKey(draft.thinking) && draft.thinking.apiKey.trim().startsWith('auth_tokens/') && <Text accessibilityRole="alert" style={styles.note}>Thinking requires a standard API key, not a Live ephemeral token.</Text>}
                </View>
                <View style={styles.section}>
                  <Text accessibilityRole="header" style={styles.sectionTitle}>Session key retention</Text>
                  <Text style={styles.label}>Remember API keys</Text>
                  <Switch accessibilityLabel="Remember API keys" disabled={locked} value={draft.rememberApiKeys}
                    onValueChange={rememberApiKeys => updateRecovery({ rememberApiKeys })} />
                  <Text style={styles.note}>Keep both keys for this app session.</Text>
                </View>
              </>}
            </ScrollView>
          </View>
          <View style={styles.footer}>
            <ScrollView accessibilityLabel="Settings status" style={[styles.notes, { maxHeight: Math.min(160, height * 0.25) }]}
              contentContainerStyle={styles.notesContent} keyboardShouldPersistTaps="handled">
              {!!questionImportWarning && <Text accessibilityRole="alert" style={styles.note}>{questionImportWarning}</Text>}
              {credentialStorageStatus === 'unavailable' && <Text accessibilityRole="alert" style={styles.note}>API keys could not be remembered. Re-enter them when needed.</Text>}
              <Text style={styles.note}>{locked ? 'Settings are locked during an interview or grading.' : 'Settings are kept for this session only. Configure both API keys to start an interview. Saving does not start a conversation.'}</Text>
            </ScrollView>
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" accessibilityLabel={locked ? 'Close' : 'Cancel'} onPress={onClose} style={styles.cancel}><Text>{locked ? 'Close' : 'Cancel'}</Text></Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Save" accessibilityState={{ disabled: locked || !valid }} disabled={locked || !valid} onPress={save} style={[styles.save, (locked || !valid) && styles.disabled]}><Text style={styles.saveText}>Save</Text></Pressable>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SETTINGS_DIALOG_MARGIN, backgroundColor: 'rgba(25,35,52,0.35)' },
  dialog: { width: '100%', maxWidth: SETTINGS_DIALOG_WIDTH, padding: 24, gap: 16, backgroundColor: '#fff', borderRadius: 16 },
  header: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  body: { flex: 1, minHeight: 0, gap: 16 },
  wideBody: { flexDirection: 'row' },
  sidebar: { width: 160, flexGrow: 0, flexShrink: 0 },
  sidebarContent: { gap: 4 },
  tabs: { flexGrow: 0, flexShrink: 0 },
  tabsContent: { flexDirection: 'row', gap: 4 },
  categoryTab: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14 },
  activeTab: { backgroundColor: '#e9eef5' },
  tabText: { color: '#334e78', fontSize: 13, fontWeight: '600' },
  panel: { flex: 1, minWidth: 0, minHeight: 0 },
  panelContent: { gap: 16 },
  categoryTitle: { fontSize: 17, fontWeight: '600', color: '#192334' },
  notes: { flexGrow: 0, flexShrink: 1 },
  notesContent: { gap: 8 },
  footer: { flexShrink: 0, gap: 8 },
  title: { fontSize: 20, fontWeight: '700', color: '#192334', marginBottom: 8 },
  section: { borderWidth: 1, borderColor: '#dce1e8', borderRadius: 8, padding: 16, gap: 12 },
  sectionTitle: { fontSize: 15, fontWeight: '600', color: '#192334' },
  dropdown: { gap: 8 },
  label: { fontSize: 13, fontWeight: '600', color: '#192334' },
  sourceChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  sourceChoice: { flexGrow: 1, flexBasis: 120, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 8, borderWidth: 1, borderColor: '#dce1e8', borderRadius: 8 },
  selectedSource: { borderColor: '#334e78', backgroundColor: '#e9eef5' },
  input: { borderWidth: 1, borderColor: '#dce1e8', borderRadius: 8, padding: 12, fontSize: 14, color: '#192334' },
  descriptionInput: { minHeight: 104, textAlignVertical: 'top' },
  note: { fontSize: 12, lineHeight: 18, color: '#64748b', marginVertical: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 },
  cancel: { borderRadius: 8, padding: 12, backgroundColor: '#f2f4f7' },
  save: { borderRadius: 8, padding: 12, backgroundColor: '#334e78' },
  saveText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
