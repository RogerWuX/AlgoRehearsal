import { createThinkingRuntime as createRuntime } from '../llm/runtime';
import { createAntigravityModel } from './models/antigravity';
import { createGoogleModel } from './models/google';

export function createThinkingRuntime() {
  return createRuntime({ google: createGoogleModel, antigravity: createAntigravityModel });
}
