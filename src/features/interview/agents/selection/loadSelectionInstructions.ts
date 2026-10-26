import { SELECTION_INSTRUCTIONS } from './prompts';

export async function loadSelectionInstructions(signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return SELECTION_INSTRUCTIONS;
}
