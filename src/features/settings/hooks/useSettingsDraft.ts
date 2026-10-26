import { useState } from 'react';
import {
  trimApiConfig, validSettingsModels, normalizeLiveConfig,
  type InterviewApiConfig, type LiveConfig, type ThinkingConfig, type ProblemSource,
} from '../../../shared/apiConfig';
import { logger } from '../../../shared/logger';

const log = logger.child({ scope: 'settings' });

export default function useSettingsDraft(config: InterviewApiConfig, locked: boolean, onSave: (config: InterviewApiConfig) => void, storedProblemCount = 0) {
  const [draft, setDraft] = useState({ ...config, live: normalizeLiveConfig(config.live) });
  const storedMode = draft.problemSource === 'stored';
  const thinkingLocked = locked;
  const savingSearchedProblemsLocked = locked || storedMode;
  const valid = validSettingsModels(draft) && (!storedMode || storedProblemCount > 0);

  function updateLive(change: Partial<LiveConfig>) {
    if (!locked) setDraft(previous => ({ ...previous, live: normalizeLiveConfig({ ...previous.live, ...change }) }));
  }

  function updateThinking(change: Partial<ThinkingConfig>) {
    if (!thinkingLocked) setDraft(previous => ({ ...previous, thinking: { ...previous.thinking, ...change } }));
  }

  function updateSaveSearchedProblems(saveSearchedProblems: boolean) {
    if (!savingSearchedProblemsLocked) setDraft(previous => ({ ...previous, saveSearchedProblems }));
  }

  function updateProblemSearchDescription(problemSearchDescription: string) {
    if (!locked && !storedMode) setDraft(previous => ({ ...previous, problemSearchDescription }));
  }

  function updateRecovery(change: Pick<Partial<InterviewApiConfig>, 'saveInterviewState' | 'rememberApiKeys'>) {
    if (!locked) setDraft(previous => ({ ...previous, ...change }));
  }

  function updateProblemSource(problemSource: ProblemSource) {
    if (!locked && (problemSource === 'agent' || storedProblemCount > 0)) {
      setDraft(previous => ({ ...previous, problemSource }));
      log.debug('settings.source-changed', { problemSource, storedProblemCount });
    } else {
      log.debug('settings.source-rejected', { reason: locked ? 'session-active' : 'stored-bank-empty', problemSource });
    }
  }

  function save() {
    const saveLog = log.child({}, [draft.live.credential, draft.thinking.apiKey]);
    if (!valid || locked) {
      saveLog.debug('settings.save-rejected', { reason: locked ? 'session-active' : 'invalid-model-or-source',
        problemSource: draft.problemSource, storedProblemCount });
      return;
    }
    saveLog.info('settings.saved', { problemSource: draft.problemSource, saveSearchedProblems: draft.saveSearchedProblems, liveModel: draft.live.model,
      liveThinkingEffort: draft.live.thinkingEffort,
      thinkingProvider: draft.thinking.provider, thinkingModel: draft.thinking.model,
      liveCredentialPresent: !!draft.live.credential.trim(), thinkingCredentialPresent: !!draft.thinking.apiKey.trim(),
      thinkingValidationSkipped: false });
    onSave(trimApiConfig(draft));
  }

  return { draft, updateLive, updateThinking, updateProblemSource, updateProblemSearchDescription, updateSaveSearchedProblems, updateRecovery, thinkingLocked, savingSearchedProblemsLocked, valid, save };
}
