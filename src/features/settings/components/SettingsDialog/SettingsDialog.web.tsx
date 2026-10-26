import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useWindowDimensions } from 'react-native';
import type { SettingsDialogProps } from './SettingsDialog.types';
import { LIVE_MODELS, THINKING_MODELS, requiresStandardThinkingKey } from '../../../../shared/apiConfig';
import useSettingsDraft from '../../hooks/useSettingsDraft';
import { questionSources } from '../../model/questionSources';
import { downloadLogs, logStorage } from '../../../../shared/logStorage';
import {
  SETTINGS_SIDEBAR_BREAKPOINT, SETTINGS_DIALOG_WIDTH, SETTINGS_DIALOG_HEIGHT, SETTINGS_DIALOG_MARGIN,
  settingsCategories, type SettingsCategoryId,
} from '../../model/settingsCategories';

export default function SettingsDialog({ config, locked, storedProblemCount = 0, questionImportWarning = '', preferenceStorageStatus = 'session', credentialStorageStatus = 'session', onClose, onSave }: SettingsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const categoryButtons = useRef<Partial<Record<SettingsCategoryId, HTMLButtonElement | null>>>({});
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>('interview');
  const { width } = useWindowDimensions();
  const wide = width >= SETTINGS_SIDEBAR_BREAKPOINT;
  const [logStatus, setLogStatus] = useState(logStorage.getStatus());
  const [logOperation, setLogOperation] = useState<'download' | 'clear' | null>(null);
  const [logError, setLogError] = useState('');
  const logBusy = useRef(false);
  const { draft, updateLive, updateThinking, updateProblemSource, updateProblemSearchDescription, updateSaveSearchedProblems, updateRecovery, thinkingLocked, savingSearchedProblemsLocked, valid, save } = useSettingsDraft(config, locked, onSave, storedProblemCount);
  const liveEffort = LIVE_MODELS.find(option => option.value === draft.live.model)?.thinkingEffort;
  const storedMode = draft.problemSource === 'stored';

  useEffect(() => {
    const unsubscribe = logStorage.subscribe(() => setLogStatus(logStorage.getStatus()));
    setLogStatus(logStorage.getStatus());
    return unsubscribe;
  }, []);

  async function operateLogs(operation: 'download' | 'clear') {
    if (logBusy.current) return;
    logBusy.current = true;
    setLogOperation(operation); setLogError('');
    try {
      if (operation === 'download') await downloadLogs();
      else await logStorage.clearLogs();
    } catch (error) {
      setLogError(error instanceof Error ? error.message : 'The log operation failed. Please try again.');
    } finally {
      logBusy.current = false; setLogOperation(null);
    }
  }

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  function selectCategory(category: SettingsCategoryId) {
    setActiveCategory(category);
  }

  useEffect(() => {
    categoryButtons.current[activeCategory]?.focus();
    if (content.current) content.current.scrollTop = 0;
  }, [activeCategory]);

  return (
    <dialog ref={dialog} aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); onClose(); }} style={styles.dialog}>
      <style>{'dialog::backdrop { background: rgba(25, 35, 52, 0.35); }'}</style>
      <form onSubmit={event => {
        event.preventDefault();
        save();
      }} style={styles.form}>
        <header style={styles.header}>
          <h2 id="settings-title" style={styles.title}>Settings</h2>
        </header>
        <div style={{ ...styles.body, flexDirection: wide ? 'row' : 'column' }}>
          <div role="tablist" aria-label="Settings categories" aria-orientation={wide ? 'vertical' : 'horizontal'}
            style={{ ...styles.navigation, ...(wide ? styles.sidebar : styles.tabs) }}>
            {settingsCategories.map(category => (
              <button key={category.id} ref={element => { categoryButtons.current[category.id] = element; }}
                id={`settings-${category.id}-tab`} type="button" role="tab" aria-selected={activeCategory === category.id}
                aria-controls="settings-category-panel" tabIndex={activeCategory === category.id ? 0 : -1}
                onClick={() => selectCategory(category.id)} onKeyDown={event => {
                  const previous = wide ? 'ArrowUp' : 'ArrowLeft';
                  const next = wide ? 'ArrowDown' : 'ArrowRight';
                  if (![previous, next, 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const index = settingsCategories.findIndex(item => item.id === category.id);
                  const target = event.key === 'Home' ? settingsCategories[0] : event.key === 'End' ? settingsCategories[settingsCategories.length - 1]
                    : settingsCategories[(index + (event.key === next ? 1 : -1) + settingsCategories.length) % settingsCategories.length];
                  selectCategory(target.id);
                }} style={{ ...styles.categoryTab, background: activeCategory === category.id ? '#e9eef5' : 'transparent' }}>
                {category.label}
              </button>
            ))}
          </div>
          <div key={activeCategory} ref={content} id="settings-category-panel" role="tabpanel"
            aria-labelledby={`settings-${activeCategory}-tab`} tabIndex={0} style={styles.panel}>
            <h3 style={styles.categoryTitle}>{settingsCategories.find(category => category.id === activeCategory)?.label}</h3>
            {activeCategory === 'interview' && <>
              <fieldset disabled={locked} style={styles.section}>
                <legend style={styles.legend}>Question source</legend>
                <div role="radiogroup" aria-label="Question source" style={styles.sourceChoices}>
                  {questionSources.map(option => {
                    const selected = draft.problemSource === option.value;
                    const disabled = locked || (option.value === 'stored' && storedProblemCount === 0);
                    return <label key={option.value} style={{ ...styles.sourceChoice, background: selected ? '#e9eef5' : '#fff',
                      borderColor: selected ? '#334e78' : '#dce1e8', opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}>
                      <input type="radio" name="question-source" value={option.value} aria-label={option.label}
                        aria-describedby={option.value === 'stored' && storedProblemCount === 0 ? 'settings-local-empty' : undefined}
                        disabled={disabled} checked={selected} onChange={() => updateProblemSource(option.value)} />
                      {option.label}
                    </label>;
                  })}
                </div>
                {storedProblemCount === 0 && <p id="settings-local-empty" style={styles.note}>No local questions yet.</p>}
                {storedMode ? <>
                  {storedProblemCount > 0 && <>
                    <p style={styles.note}>{`${storedProblemCount} ${storedProblemCount === 1 ? 'question' : 'questions'} available`}</p>
                    <p style={styles.note}>Pick a random question from your local collection.</p>
                  </>}
                </> : <>
                  <label style={styles.label}>
                    Problem description (optional)
                    <textarea aria-label="Problem description (optional)" aria-describedby="settings-problem-description-help"
                      rows={4} disabled={locked} value={draft.problemSearchDescription}
                      placeholder="A medium graph problem about shortest paths, preferably from LeetCode."
                      onChange={event => updateProblemSearchDescription(event.target.value)} style={{ ...styles.input, resize: 'vertical' }} />
                  </label>
                  <p id="settings-problem-description-help" style={styles.note}>Describe the topic, difficulty, or problem you want. Leave blank for the default search.</p>
                  <label style={{ ...styles.label, flexDirection: 'row', alignItems: 'center' }}>
                    <input type="checkbox" aria-label="Save found questions" disabled={savingSearchedProblemsLocked}
                      checked={draft.saveSearchedProblems} onChange={event => updateSaveSearchedProblems(event.target.checked)} />
                    Save found questions
                  </label>
                  <p style={styles.note}>Add web questions to your local collection for future interviews.</p>
                </>}
              </fieldset>
              <fieldset disabled={locked} style={styles.section}>
                <legend style={styles.legend}>Interview recovery</legend>
                <label style={{ ...styles.label, flexDirection: 'row', alignItems: 'center' }}>
                  <input type="checkbox" aria-label="Save interview progress" checked={draft.saveInterviewState}
                    onChange={event => updateRecovery({ saveInterviewState: event.target.checked })} />
                  Save interview progress
                </label>
                <p style={styles.note}>Restore your code, problem, discussion, and feedback when you reopen the app. Unfinished interviews reconnect automatically. When off, code, problem, discussion, and feedback clear when you reopen the app.</p>
              </fieldset>
            </>}
            {activeCategory === 'model' && <>
              <fieldset disabled={locked} style={styles.section}>
                <legend style={styles.legend}>Live API</legend>
                <p style={styles.note}>Used by the voice interviewer.</p>
                <label style={styles.label}>
                  API key or token
                  <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
                    value={draft.live.credential} onChange={event => updateLive({ credential: event.target.value })} style={styles.input} />
                </label>
                <p style={styles.note}>Accepts a standard API key or a Live ephemeral token.</p>
                <label style={styles.label}>
                  Live model
                  <select value={draft.live.model} onChange={event => updateLive({ model: event.target.value })} style={styles.input}>
                    {LIVE_MODELS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                {!!liveEffort?.options.length && <label style={styles.label}>
                  Thinking effort
                  <select aria-label="Thinking effort" value={draft.live.thinkingEffort}
                    onChange={event => updateLive({ thinkingEffort: event.target.value })} style={styles.input}>
                    {liveEffort.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>}
              </fieldset>
              <fieldset disabled={thinkingLocked} style={styles.section}>
                <legend style={styles.legend}>Thinking API</legend>
                <p style={styles.note}>Used to select problems and give separate code and interview feedback.</p>
                <label style={styles.label}>
                  Thinking API key
                  <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
                    value={draft.thinking.apiKey} onChange={event => updateThinking({ apiKey: event.target.value })} style={styles.input} />
                </label>
                <label style={styles.label}>
                  Thinking model
                  <select value={draft.thinking.model} onChange={event => updateThinking({ model: event.target.value })} style={styles.input}>
                    {THINKING_MODELS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                {requiresStandardThinkingKey(draft.thinking) && draft.thinking.apiKey.trim().startsWith('auth_tokens/') && <p role="alert" style={styles.note}>Thinking requires a standard API key, not a Live ephemeral token.</p>}
              </fieldset>
              <fieldset disabled={locked} style={styles.section}>
                <legend style={styles.legend}>Session key retention</legend>
                <label style={{ ...styles.label, flexDirection: 'row', alignItems: 'center' }}>
                  <input type="checkbox" aria-label="Remember API keys" checked={draft.rememberApiKeys}
                    onChange={event => updateRecovery({ rememberApiKeys: event.target.checked })} />
                  Remember API keys
                </label>
                <p style={styles.note}>Keep both keys through reloads until this browser tab closes.</p>
              </fieldset>
            </>}
            {activeCategory === 'diagnostics' && <>
              <section aria-labelledby="settings-logs-title" style={styles.section}>
                <h3 id="settings-logs-title" style={{ ...styles.legend, margin: 0 }}>Application logs</h3>
                <p role="status" style={styles.note}>{logStatus.message}</p>
                {logStatus.omittedRecords > 0 && <p style={styles.note}>{logStatus.omittedRecords} log record(s) omitted.</p>}
                {logStatus.lastOmission && <p style={styles.note}>{logStatus.lastOmission}</p>}
                <p style={styles.note}>Downloads may include provider responses and problem content. Review logs before sharing.</p>
                {logError && <p role="alert" style={styles.note}>{logError}</p>}
                <div style={styles.actions}>
                  <button type="button" disabled={logOperation !== null} onClick={() => operateLogs('download')} style={styles.cancel}>
                    {logOperation === 'download' ? 'Downloading…' : 'Download logs'}
                  </button>
                  <button type="button" disabled={logOperation !== null} onClick={() => operateLogs('clear')} style={styles.cancel}>
                    {logOperation === 'clear' ? 'Clearing…' : 'Clear logs'}
                  </button>
                </div>
              </section>
            </>}
          </div>
        </div>
        <footer style={styles.footer}>
          <div role="region" aria-label="Settings status" tabIndex={0} style={styles.notes}>
            <p style={styles.note}>{preferenceStorageStatus === 'saved'
              ? 'Saved preferences are remembered in this browser. API keys and tokens are kept for this session only.'
              : preferenceStorageStatus === 'unavailable'
                ? 'Browser storage is unavailable. Settings are kept for this session only.'
                : 'Settings are kept for this session only.'}</p>
            <p style={styles.note}>{locked ? 'Settings are locked during an interview or grading.' : 'Configure both API keys to start an interview. Saving does not start a conversation.'}</p>
            {questionImportWarning && <p role="alert" style={styles.note}>{questionImportWarning}</p>}
            {credentialStorageStatus === 'unavailable' && <p role="alert" style={styles.note}>API keys could not be remembered. Re-enter them when needed.</p>}
          </div>
          <div style={styles.actions}>
            <button type="button" onClick={onClose} style={styles.cancel}>{locked ? 'Close' : 'Cancel'}</button>
            <button type="submit" disabled={locked || !valid} style={{ ...styles.save, opacity: locked || !valid ? 0.4 : 1 }}>Save</button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}

const styles: Record<string, CSSProperties> = {
  dialog: { width: `min(${SETTINGS_DIALOG_WIDTH}px, calc(100vw - ${SETTINGS_DIALOG_MARGIN * 2}px))`, height: `min(${SETTINGS_DIALOG_HEIGHT}px, calc(100dvh - ${SETTINGS_DIALOG_MARGIN * 2}px))`, overflow: 'hidden', padding: 24, boxSizing: 'border-box', border: '1px solid #dce1e8', borderRadius: 16, color: '#192334', background: '#fff', fontFamily: 'system-ui, sans-serif', boxShadow: '0 20px 60px rgba(25,35,52,.15)' },
  form: { display: 'flex', flexDirection: 'column', gap: 20, height: '100%', minHeight: 0 },
  header: { display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  body: { display: 'flex', flex: 1, gap: 20, minHeight: 0, minWidth: 0, overflow: 'hidden' },
  navigation: { display: 'flex', gap: 4, flexShrink: 0 },
  sidebar: { flexDirection: 'column', width: 160 },
  tabs: { flexDirection: 'row', overflowX: 'auto' },
  categoryTab: { flexShrink: 0, border: 0, borderRadius: 8, padding: '12px 14px', textAlign: 'left', color: '#334e78', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  panel: { display: 'flex', flexDirection: 'column', gap: 20, flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable', padding: 2 },
  categoryTitle: { fontSize: 17, margin: 0 },
  notes: { display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'min(160px, 25dvh)', overflowY: 'auto', padding: 2 },
  footer: { display: 'flex', flexDirection: 'column', flexShrink: 0, gap: 10 },
  title: { fontSize: 20, margin: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: 16, flexShrink: 0, minWidth: 0, margin: 0, padding: 16, border: '1px solid #dce1e8', borderRadius: 8 },
  legend: { fontSize: 15, fontWeight: 600, padding: '0 6px' },
  label: { display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, fontWeight: 600 },
  sourceChoices: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  sourceChoice: { display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '1 1 120px', gap: 6, padding: '12px 8px', border: '1px solid #dce1e8', borderRadius: 8, fontSize: 13, fontWeight: 600 },
  input: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: '1px solid #dce1e8', borderRadius: 8, padding: 12, color: '#192334', font: 'inherit', fontWeight: 400 },
  note: { color: '#64748b', fontSize: 12, lineHeight: '18px', margin: 0 },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 },
  cancel: { background: '#f2f4f7', color: '#334e78', border: 0, borderRadius: 8, padding: '12px 16px', font: 'inherit', fontSize: 13, cursor: 'pointer' },
  save: { background: '#334e78', color: '#fff', border: 0, borderRadius: 8, padding: '12px 16px', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
};
