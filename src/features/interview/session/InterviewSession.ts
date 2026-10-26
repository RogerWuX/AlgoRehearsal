import { liveConfigured, thinkingConfigured, resolveSupportedModel, validateThinkingConfig, type InterviewApiConfig, type LiveConfig, type ThinkingConfig } from '../../../shared/apiConfig';
import type { Problem } from '../model/problem';
import type { InterviewAudio, InterviewContent, InterviewTransport, SessionDependencies, SessionClock } from './ports';
import type { InterviewActions, InterviewSnapshot } from './types';
import { appendTranscript, emptyTranscript, finishTurn, interruptTranscript } from './transcript';
import { DiscussionEchoMatcher } from './discussionEchoMatcher';
import type { PreparedProblemSelection, ProblemSelectionConfig } from '../selection/types';
import { logger as appLogger, type Logger } from '../../../shared/logger';
import type { CodeSubmission } from '../judgment/model';
import { captureSubmission, emptyJudgment, restoreJudgment } from '../judgment/state';
import { invokeWithSignal } from '../llm/invokeWithSignal';
import { systemClock } from '../utils';
import type { SavedInterview } from '../storage/interviewStateStorage';

export const SELECTION_TIMEOUT_MS = 300000;
export const CONNECTION_TIMEOUT_MS = 20000;
const CONNECTION_TIMEOUT_MESSAGE = 'Interviewer connection timed out. Retry with the selected problem.';
const MICROPHONE_ERROR = 'Microphone unavailable. Allow microphone access on HTTPS or localhost.';
const AUDIO_ERROR = 'Audio could not be enabled. Try again.';
let nextSessionId = 0;
type StartOptions = {
  retry?: boolean;
  selection?: ProblemSelectionConfig;
  recovery?: { automatic: boolean; handle?: string };
};

// The session owns workflow and state; adapters own provider and browser resources.
export class InterviewSession implements InterviewActions {
  private snapshot: InterviewSnapshot;
  private listeners = new Set<() => void>();
  private transcript = emptyTranscript();
  private discussionEcho = new DiscussionEchoMatcher();
  private transport: InterviewTransport | null = null;
  private audio: InterviewAudio | null = null;
  private startup: AbortController | null = null;
  private timeout: unknown = null;
  private attempt = 0;
  private micRequest = 0;
  private retryProblem: Problem | null = null;
  private clock: SessionClock;
  private logger: Logger;
  private activeLogger: Logger;
  private credentials: string[] = [];
  private recoveryEnabled = false;
  private recoveryInitialized = false;
  private lifecycle: SavedInterview['lifecycle'] = 'idle';
  private activeLive: SavedInterview['live'] = null;
  private resumptionHandle: string | null = null;

  constructor(private dependencies: SessionDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.logger = (dependencies.logger ?? appLogger).child({ scope: 'interview', sessionId: ++nextSessionId });
    this.activeLogger = this.logger;
    this.snapshot = {
      messages: [], discussion: '', status: 'disconnected', error: '', listening: false, canRetry: false, judgment: emptyJudgment(),
      canResume: false, shouldResume: false, interviewStorageStatus: 'session', recoveryWarning: '', recoveryNotice: '', audioNeedsInteraction: false,
      // The question bank supplies future interviews; only interview recovery
      // may restore a selected problem into the workspace.
      problem: null, problemStorageStatus: 'session',
      ...dependencies.selection.getBankInfo(),
    };
    this.logger.info('session.initialized', { restoredProblem: this.snapshot.problem, storedProblemCount: this.snapshot.storedProblemCount,
      problemStorageStatus: this.snapshot.problemStorageStatus });
  }

  getSnapshot = (): InterviewSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(change: Partial<InterviewSnapshot>) {
    if (change.status && change.status !== this.snapshot.status) {
      this.activeLogger.info('session.state-changed', { from: this.snapshot.status, to: change.status });
    }
    const previous = this.snapshot;
    this.snapshot = { ...previous, ...change };
    if (change.status !== undefined || change.judgment !== undefined || change.discussion !== undefined || (change.messages !== undefined && change.messages !== previous.messages)) this.persist();
    this.listeners.forEach(listener => listener());
  }

  private persist() {
    if (!this.recoveryEnabled || !this.dependencies.interviewState) return;
    const selecting = this.lifecycle === 'selecting';
    const interviewStorageStatus = this.dependencies.interviewState.write({
      version: 1, lifecycle: this.lifecycle, problem: selecting ? null : this.snapshot.problem,
      messages: selecting ? [] : this.snapshot.messages, live: this.activeLive,
      discussion: this.snapshot.discussion,
      resumptionHandle: this.resumptionHandle, judgment: this.snapshot.judgment,
    });
    if (interviewStorageStatus === 'unavailable' && this.snapshot.interviewStorageStatus !== 'unavailable') this.activeLogger.warn('recovery.save-failed');
    this.snapshot = { ...this.snapshot, interviewStorageStatus,
      recoveryWarning: interviewStorageStatus === 'unavailable' ? 'Interview progress could not be saved. Progress is kept for this session only.' : '' };
  }

  configureRecovery = (enabled: boolean) => {
    if (this.recoveryInitialized && this.recoveryEnabled === enabled) return;
    const initialize = !this.recoveryInitialized;
    const previouslyEnabled = this.recoveryEnabled;
    this.recoveryInitialized = true;
    this.recoveryEnabled = enabled;
    if (!enabled) {
      const clearStatus = this.dependencies.interviewState?.clear();
      const failedToClear = previouslyEnabled && clearStatus === 'unavailable';
      this.update({ shouldResume: false, canResume: false, interviewStorageStatus: failedToClear ? 'unavailable' : 'session',
        recoveryWarning: failedToClear ? 'Saved interview progress could not be cleared. Interview recovery is disabled.' : '' });
      return;
    }
    if (initialize && this.dependencies.interviewState) {
      const restored = this.dependencies.interviewState.read();
      const saved = restored.value;
      if (saved) {
        this.lifecycle = saved.lifecycle === 'selecting' ? 'idle' : saved.lifecycle;
        this.activeLive = saved.live;
        this.resumptionHandle = saved.resumptionHandle;
        this.transcript = { messages: saved.messages.map(message => ({ ...message })),
          sequence: saved.messages.reduce((maximum, message) => Math.max(maximum, message.id), 0), active: {} };
        const judgment = restoreJudgment(saved.judgment);
        const canResume = !!saved.problem && (saved.lifecycle === 'active' || saved.lifecycle === 'paused') && !judgment.submission;
        this.retryProblem = canResume ? saved.problem : null;
        this.snapshot = { ...this.snapshot, problem: saved.problem,
          problemStorageStatus: saved.problem ? restored.storageStatus : this.snapshot.problemStorageStatus,
          messages: this.transcript.messages, discussion: saved.discussion, judgment, canResume,
          shouldResume: canResume && saved.lifecycle === 'active',
          recoveryNotice: saved.lifecycle === 'selecting' ? 'Problem selection was interrupted. Start a new interview.' : '',
        };
        this.logger.info('recovery.restored', { lifecycle: saved.lifecycle, messageCount: saved.messages.length });
      }
      this.update({ interviewStorageStatus: restored.storageStatus, recoveryWarning: restored.warning });
    } else {
      this.persist();
      this.update({ canResume: this.snapshot.status === 'disconnected' && !!this.retryProblem && !this.snapshot.judgment.submission });
    }
  };

  acknowledgeRecovery = () => { this.update({ shouldResume: false }); };

  resume = (config: InterviewApiConfig, automatic = false) => {
    const live = this.activeLive ? { ...this.activeLive, credential: config.live.credential } : { ...config.live };
    return this.start(live, { ...config.thinking }, { retry: true, recovery: { automatic, handle: this.resumptionHandle ?? undefined } });
  };

  enableAudio = async () => {
    const audio = this.audio, attempt = this.attempt;
    if (!audio || this.snapshot.status !== 'connected') return;
    try {
      await audio.resume();
      if (this.attempt === attempt && this.audio === audio) this.update({ audioNeedsInteraction: false,
        ...(this.snapshot.error === AUDIO_ERROR ? { error: '' } : {}) });
    } catch {
      if (this.attempt === attempt && this.audio === audio) this.update({ error: AUDIO_ERROR, audioNeedsInteraction: true });
    }
  };

  private clearTimeout() {
    if (this.timeout !== null) this.clock.clearTimeout(this.timeout);
    this.timeout = null;
  }

  private stopMic() {
    this.micRequest++;
    try {
      if (this.audio?.stopMicrophone()) this.transport?.endAudio();
    } catch (error) {
      this.activeLogger.warn('microphone.stop-failed', { error });
      // A failed end-of-stream notification must not prevent disconnect cleanup.
    }
    this.update({ listening: false });
  }

  private cleanup() {
    this.cancelJudgment();
    this.activeLogger.info('session.disconnect', { status: this.snapshot.status, startupPending: !!this.startup,
      transportActive: !!this.transport });
    this.attempt++;
    this.flushInput();
    this.discussionEcho.reset();
    this.startup?.abort();
    this.startup = null;
    this.clearTimeout();
    this.stopMic();
    const transport = this.transport;
    const audio = this.audio;
    this.transport = null;
    this.audio = null;
    try { transport?.close(); } catch (error) { this.activeLogger.warn('transport.cleanup-failed', { error }); }
    try { audio?.close(); } catch (error) { this.activeLogger.warn('audio.cleanup-failed', { error }); }
    this.transcript = finishTurn(this.transcript);
    this.update({ status: 'disconnected', listening: false, audioNeedsInteraction: false });
  }

  disconnect = () => {
    this.lifecycle = this.snapshot.judgment.submission ? 'ended' : this.retryProblem ? 'paused' : 'idle';
    this.cleanup();
    this.update({ shouldResume: false, canResume: this.recoveryEnabled && !!this.retryProblem && !this.snapshot.judgment.submission });
  };

  quit = () => {
    this.lifecycle = 'idle';
    this.retryProblem = null;
    this.activeLive = null;
    this.resumptionHandle = null;
    this.cleanup();
    this.credentials = [];
    this.transcript = emptyTranscript(this.transcript.sequence);
    this.update({
      problem: null, problemStorageStatus: 'session', messages: [], discussion: '', judgment: emptyJudgment(),
      error: '', canRetry: false, canResume: false, shouldResume: false, recoveryNotice: '',
    });
  };

  releaseResources = () => {
    this.cleanup();
    this.update({ shouldResume: this.recoveryEnabled && this.lifecycle === 'active',
      canResume: this.recoveryEnabled && !!this.retryProblem && !this.snapshot.judgment.submission });
  };

  connect = (config: InterviewApiConfig) => {
    this.configureRecovery(config.saveInterviewState);
    return this.start({ ...config.live }, { ...config.thinking }, { selection: config });
  };
  retry = (config: InterviewApiConfig) => this.start({ ...config.live }, { ...config.thinking }, { retry: true });

  setDiscussion = (discussion: string) => {
    if (discussion !== this.snapshot.discussion) this.update({ discussion });
  };

  endInterview = async (submission: CodeSubmission, thinkingConfig: ThinkingConfig) => {
    if (this.snapshot.status !== 'connected' || !this.snapshot.problem || this.dependencies.judgment.isRunning()) return;
    this.flushInput();
    const captured = captureSubmission(this.snapshot.problem, this.snapshot.messages, submission, this.snapshot.discussion);
    this.disconnect();
    this.lifecycle = 'ended';
    this.resumptionHandle = null;
    this.retryProblem = null;
    this.update({ canRetry: false, canResume: false, shouldResume: false, error: '', judgment: { ...emptyJudgment(), submission: captured } });
    await this.runJudgments({ ...thinkingConfig });
  };

  retryJudgment = async (thinkingConfig: ThinkingConfig) => {
    if (this.snapshot.status !== 'disconnected' || !this.snapshot.judgment.submission || this.dependencies.judgment.isRunning()) return;
    if (this.snapshot.judgment.code && this.snapshot.judgment.interview) return;
    await this.runJudgments({ ...thinkingConfig });
  };

  cancelJudgment = () => { this.dependencies.judgment.cancel(); };

  private runJudgments(config: ThinkingConfig) {
    return this.dependencies.judgment.run(this.snapshot.judgment, config, {
      logger: this.activeLogger, secrets: this.credentials,
      onChange: judgment => this.update({ judgment, status: judgment.status === 'running' ? 'judging' : 'disconnected',
        ...(judgment.status === 'running' ? { error: '' } : {}) }),
    });
  }

  private async start(live: LiveConfig, thinking: ThinkingConfig | undefined, options: StartOptions = {}) {
    const { retry: resume = false, selection: selectionConfig, recovery } = options;
    const continuing = !!recovery, automatic = recovery?.automatic ?? false, handle = recovery?.handle;
    if (this.startup || this.transport || this.dependencies.judgment.isRunning()) {
      this.activeLogger.debug('session.start-rejected', { reason: 'startup-or-transport-already-active', resume });
      return;
    }
    const savedProblem = resume ? this.retryProblem : null;
    this.cleanup();
    let log = this.logger.child({ attemptId: this.attempt, ...(resume ? { mode: 'retry' } : {}),
      liveModel: live.model, thinkingModel: thinking?.model }, [live.credential, thinking?.apiKey ?? '']);
    this.activeLogger = log;
    this.update({ error: '', canRetry: !!savedProblem, shouldResume: false });
    if (!liveConfigured(live)) {
      log.warn('session.start-rejected', { reason: 'live-configuration-missing' });
      this.update({ error: 'Enter a Live API credential and model.' });
      return;
    }
    if (resume && !savedProblem) {
      log.warn('session.start-rejected', { reason: 'retry-problem-missing' });
      this.update({ error: 'No selected problem is available to retry. Start a new interview.' });
      return;
    }
    let selection: PreparedProblemSelection | undefined;
    if (!resume) {
      try {
        selection = this.dependencies.selection.prepare(selectionConfig!, log);
      } catch (error) {
        let message = error instanceof Error ? error.message : 'Could not prepare problem selection.';
        for (const secret of [live.credential.trim(), thinking?.apiKey.trim()]) {
          if (secret) message = message.split(secret).join('[redacted]');
        }
        this.update({ error: message });
        return;
      }
      log = log.child({ mode: selection.logContext.source });
      this.activeLogger = log;
    }
    log.info('session.start-requested', { resume, ...selection?.logContext,
      liveCredentialPresent: !!live.credential.trim(), thinkingCredentialPresent: !!thinking?.apiKey.trim() });
    if (!thinking || !thinkingConfigured(thinking)) {
      log.warn('session.start-rejected', { reason: 'thinking-configuration-missing' });
      this.update({ error: 'Enter a standard thinking API key and model.' });
      return;
    }
    try {
      resolveSupportedModel(live.model, 'live');
      validateThinkingConfig(thinking);
    } catch (error) {
      let message = error instanceof Error ? error.message : 'The model configuration is invalid.';
      for (const secret of [live.credential.trim(), thinking.apiKey.trim()]) {
        if (secret) message = message.split(secret).join('[redacted]');
      }
      this.update({ error: message });
      return;
    }
    this.credentials = [live.credential.trim(), thinking.apiKey.trim()];
    this.activeLive = { model: live.model, ...(live.thinkingEffort !== undefined ? { thinkingEffort: live.thinkingEffort } : {}) };
    const initialStatus = savedProblem ? 'connecting' : selection!.initialStatus;
    // Stored questions show Connecting immediately, but recovery stays in
    // selection until a problem has actually been accepted.
    this.lifecycle = savedProblem ? 'active' : 'selecting';
    if (!continuing) {
      this.resumptionHandle = null;
      this.transcript = emptyTranscript(this.transcript.sequence);
      this.update({ messages: [], judgment: emptyJudgment(), recoveryNotice: '',
        ...(!resume ? { discussion: '', problem: null, problemStorageStatus: 'session' as const } : {}) });
    }
    this.discussionEcho.reset(continuing ? this.transcript.messages : [], this.dependencies.formatDiscussionMessage);
    if (!resume) this.retryProblem = null;
    const request = this.attempt;
    const controller = new AbortController();
    this.startup = controller;
    let phase: 'selector' | 'interviewer' = initialStatus === 'selecting' ? 'selector' : 'interviewer';
    let established = false;
    let microphoneRequested = false;
    const current = () => {
      const valid = this.attempt === request;
      if (!valid) log.debug('session.stale-operation', { reason: 'attempt-superseded', currentAttemptId: this.attempt });
      return valid;
    };
    const startDefaultMicrophone = () => {
      if (!current() || !established || !this.transport || microphoneRequested) return;
      microphoneRequested = true;
      void this.startMic();
    };
    const fail = (message: string) => {
      if (!current()) return;
      if (continuing && handle && !established) {
        this.resumptionHandle = null;
        this.cleanup();
        this.update({ recoveryNotice: 'The original connection could not resume. Continuing from the saved discussion.' });
        // A fresh audio context after an async failure needs another user gesture.
        void this.start(live, thinking, { retry: true, recovery: { automatic: true } });
        return;
      }
      for (const secret of [live.credential.trim(), thinking?.apiKey.trim()]) {
        if (secret) message = message.split(secret).join('[redacted]');
      }
      log.error('session.failed', { phase, message, retryEligible: phase === 'interviewer' && !!this.retryProblem });
      this.update({ error: message, canRetry: phase === 'interviewer' && !!this.retryProblem });
      this.cleanup();
      this.update({ shouldResume: false, canResume: this.recoveryEnabled && !!this.retryProblem });
    };
    const armTimeout = (duration: number, message: string) => {
      this.clearTimeout();
      log.debug('session.timeout-armed', { phase, durationMs: duration });
      this.timeout = this.clock.setTimeout(() => {
        log.error('session.timeout', { phase, durationMs: duration });
        fail(message);
      }, duration);
    };
    this.update({ canRetry: false, canResume: false, status: initialStatus, audioNeedsInteraction: automatic });
    armTimeout(initialStatus === 'selecting' ? SELECTION_TIMEOUT_MS : CONNECTION_TIMEOUT_MS, initialStatus === 'selecting'
      ? 'Problem selection timed out. Check your instructions, thinking API key, model, and network.'
      : CONNECTION_TIMEOUT_MESSAGE);

    try {
      // Resume directly from the click gesture, before awaiting problem selection.
      this.audio = this.dependencies.createAudio(log);
      if (!automatic) await this.audio.resume();
      if (!current()) return;
      let problem = savedProblem;
      if (problem) log.info('problem.reused', { reason: 'interviewer-retry', problem, selectionSkipped: true });
      if (!problem) {
        const selected = await invokeWithSignal(() => selection!.getProblem(controller.signal, log), controller.signal);
        if (!current() || controller.signal.aborted) return;
        problem = selected.problem;
        this.retryProblem = problem;
        this.lifecycle = 'active';
        this.update({ ...selected, status: 'connecting' });
        phase = 'interviewer';
        armTimeout(CONNECTION_TIMEOUT_MS, CONNECTION_TIMEOUT_MESSAGE);
      }
      phase = 'interviewer';
      log.info('interviewer.connect-started', { model: live.model, problemTitle: problem.title, sourceUrl: problem.sourceUrl });
      const transport = this.dependencies.createTransport(live, problem, {
        ready: () => {
          if (!current()) return;
          if (this.snapshot.status === 'connected') {
            log.debug('interviewer.ready-skipped', { reason: 'already-connected' });
            return;
          }
          this.clearTimeout();
          established = true;
          this.startup = null;
          this.transcript = continuing ? finishTurn(this.transcript) : emptyTranscript(this.transcript.sequence);
          this.update({ messages: this.transcript.messages, status: 'connected',
            recoveryNotice: continuing && !handle ? 'Live connection recreated. Continuing from the saved discussion.' : this.snapshot.recoveryNotice });
          startDefaultMicrophone();
        },
        content: content => { if (current()) this.receive(content); },
        error: fail,
        resumption: update => {
          if (!current()) return;
          this.resumptionHandle = update.resumable && update.handle ? update.handle : null;
          this.persist();
          this.listeners.forEach(listener => listener());
        },
      }, log, { enabled: this.recoveryEnabled, continuing, messages: this.snapshot.messages, ...(handle ? { handle } : {}) });
      if (!current()) {
        try { transport.close(); } catch (error) { log.warn('transport.cleanup-failed', { reason: 'startup-canceled', error }); }
        return;
      }
      this.transport = transport;
      // A transport may signal readiness before its factory returns.
      startDefaultMicrophone();
    } catch (error) {
      fail(error instanceof Error ? error.message : 'Could not start the interview. Check your API settings and browser audio support.');
    }
  }

  private flushInput() {
    const text = this.discussionEcho.flush();
    if (!text) return;
    this.resumptionHandle = null;
    this.transcript = appendTranscript(this.transcript, 'user', text);
    this.update({ messages: this.transcript.messages });
  }

  private receive(content: InterviewContent) {
    if (content.inputText || content.inputTextFinished || content.outputText || content.interrupted) this.resumptionHandle = null;
    if (content.interrupted) {
      this.activeLogger.debug('interviewer.interrupted', { action: 'stop-playback-and-finish-active-transcript' });
      this.audio?.stopPlayback();
      this.transcript = interruptTranscript(this.transcript);
    }
    if (content.inputText || content.inputTextFinished) {
      const text = this.discussionEcho.read(content.inputText, content.inputTextFinished);
      if (text) this.transcript = appendTranscript(this.transcript, 'user', text);
      if (content.inputTextFinished) this.transcript = { ...this.transcript, active: { ...this.transcript.active, user: undefined } };
    }
    if (content.outputText) this.transcript = appendTranscript(this.transcript, 'model', content.outputText);
    if (!this.snapshot.audioNeedsInteraction) for (const chunk of content.audio) this.audio?.play(chunk);
    if (content.turnComplete) {
      this.activeLogger.debug('interviewer.turn-completed');
      const text = this.discussionEcho.endTurn();
      if (text) {
        this.resumptionHandle = null;
        this.transcript = appendTranscript(this.transcript, 'user', text);
      }
      this.transcript = finishTurn(this.transcript);
    }
    if (content.interrupted && !content.inputText && !content.outputText) this.persist();
    this.update({ messages: this.transcript.messages });
  }

  send = (text: string, options?: { kind: 'discussion' }): boolean => {
    const value = text.trim();
    if (this.snapshot.status !== 'connected' || !value) {
      this.activeLogger.debug('message.send-rejected', { reason: !value ? 'empty-message' : 'interviewer-not-connected' });
      return false;
    }
    try {
      const payload = options?.kind === 'discussion' ? this.dependencies.formatDiscussionMessage(value) : value;
      if (!this.transport?.sendText(payload)) {
        this.activeLogger.warn('message.send-rejected', { reason: 'transport-not-ready' });
        return false;
      }
      this.activeLogger.debug('message.sent', { characters: value.length });
      this.resumptionHandle = null;
      this.transcript = appendTranscript(this.transcript, 'user', value, true, options?.kind);
      if (options?.kind === 'discussion') this.discussionEcho.register(value, payload);
      this.transcript = { ...this.transcript, active: { ...this.transcript.active, user: undefined } };
      this.update({ messages: this.transcript.messages });
      return true;
    } catch (error) {
      this.activeLogger.error('message.send-failed', { error });
      this.update({ error: 'Message could not be sent. Reconnect and try again.' });
      return false;
    }
  };

  toggleMic = async () => {
    if (this.snapshot.listening) { this.activeLogger.info('microphone.stop-requested'); this.stopMic(); return; }
    // Playback activation must not hold up microphone permission or capture.
    if (this.snapshot.audioNeedsInteraction) void this.enableAudio();
    await this.startMic();
  };

  private async startMic() {
    if (this.snapshot.listening) return;
    if (this.snapshot.status !== 'connected' || !this.audio) {
      this.activeLogger.debug('microphone.start-rejected', { reason: 'interviewer-or-audio-not-ready' });
      return;
    }
    const log = this.activeLogger;
    log.info('microphone.start-requested');
    const request = ++this.micRequest;
    const attempt = this.attempt;
    const current = () => {
      const valid = request === this.micRequest && attempt === this.attempt;
      if (!valid) log.debug('microphone.stale-operation', { reason: 'microphone-request-or-attempt-superseded' });
      return valid;
    };
    const failed = () => {
      if (!current()) return;
      log.warn('microphone.failed', { reason: 'capture-or-permission-failed' });
      this.stopMic();
      this.update({ error: MICROPHONE_ERROR });
    };
    this.update({ listening: true });
    try {
      const started = await this.audio.startMicrophone(chunk => {
        if (current()) this.transport?.sendAudio(chunk);
      }, failed);
      if (current()) {
        if (!started) failed();
        else this.update({ listening: true, ...(this.snapshot.error === MICROPHONE_ERROR ? { error: '' } : {}) });
      }
    } catch (error) { log.warn('microphone.start-failed', { error }); failed(); }
  }
}
