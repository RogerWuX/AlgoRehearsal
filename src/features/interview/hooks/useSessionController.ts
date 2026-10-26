import { useEffect, useState, useSyncExternalStore } from 'react';
import { InterviewSession } from '../session/InterviewSession';
import type { SessionDependencies } from '../session/ports';
import type { InterviewController } from '../session/types';

export default function useSessionController(createDependencies: () => SessionDependencies): InterviewController {
  const [session] = useState(() => new InterviewSession(createDependencies()));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  // Resource cleanup preserves recovery intent across reloads and Strict Mode.
  useEffect(() => () => { session.releaseResources(); }, [session]);
  return {
    ...snapshot,
    connect: session.connect, retry: session.retry, disconnect: session.disconnect, quit: session.quit,
    endInterview: session.endInterview, retryJudgment: session.retryJudgment, cancelJudgment: session.cancelJudgment,
    send: session.send, toggleMic: session.toggleMic, setDiscussion: session.setDiscussion,
    configureRecovery: session.configureRecovery, acknowledgeRecovery: session.acknowledgeRecovery,
    resume: session.resume, enableAudio: session.enableAudio,
  };
}
