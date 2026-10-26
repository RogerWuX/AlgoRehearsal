import useSessionController from './useSessionController';
import { BrowserAudio } from '../adapters/audio/browserAudio.web';
import { createLiveTransport } from '../adapters/liveTransport.web';
import { createInterviewerFactory } from '../agents/interviewer/createInterviewer';
import { formatDiscussionMessage } from '../agents/interviewer/prompts';
import { createThinkingRuntime } from '../adapters/thinkingModels';
import { createProblemRepository } from '../storage/problemStorage';
import { loadProjectQuestions } from '../adapters/projectQuestions.web';
import { createJudgmentWorkflow } from '../judgment/createJudgmentWorkflow';
import { createInterviewStateRepository } from '../storage/interviewStateStorage';
import { createProblemSelector } from '../selection/createProblemSelector';

export default function useInterviewSession() {
  return useSessionController(() => {
    const imported = loadProjectQuestions();
    const thinking = createThinkingRuntime();
    const problems = createProblemRepository(() => typeof window === 'undefined' ? null : window.localStorage, {
      initialProblems: imported.problems,
      importWarning: imported.warning,
    });
    return {
      selection: createProblemSelector({ problems, thinking }),
      judgment: createJudgmentWorkflow({ thinking }),
      formatDiscussionMessage,
      createTransport: createInterviewerFactory(createLiveTransport),
      interviewState: createInterviewStateRepository(() => typeof window === 'undefined' ? null : window.localStorage),
      createAudio: logger => new BrowserAudio(logger),
    };
  });
}
