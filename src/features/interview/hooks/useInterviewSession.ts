import { useState } from 'react';
import type { InterviewController } from '../session/types';
import { emptyJudgment } from '../judgment/state';

export default function useInterviewSession(): InterviewController {
  const [error, setError] = useState('');
  const [discussion, setDiscussion] = useState('');
  const unavailable = async () => { setError('Gemini Live is available in the web app.'); };
  return {
    messages: [], discussion, setDiscussion, status: 'disconnected', error, listening: false,
    problem: null, problemStorageStatus: 'session', canRetry: false,
    storedProblemCount: 0, questionImportWarning: '',
    judgment: emptyJudgment(),
    canResume: false, shouldResume: false, interviewStorageStatus: 'session', recoveryWarning: '', recoveryNotice: '', audioNeedsInteraction: false,
    connect: unavailable, retry: unavailable, disconnect: () => {},
    quit: () => { setDiscussion(''); setError(''); },
    endInterview: unavailable, retryJudgment: unavailable, cancelJudgment: () => {},
    send: () => false, toggleMic: async () => {},
    configureRecovery: () => {}, acknowledgeRecovery: () => {}, resume: unavailable, enableAudio: async () => {},
  };
}
