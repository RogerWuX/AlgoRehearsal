import selectionTemplate from './selection.md';
import searchSystemPrompt from './search-system.md';
import { renderPrompt } from '../renderPrompt';

export const SELECTION_INSTRUCTIONS = renderPrompt(selectionTemplate, {}, {
  instructions: true, client_search: false, server_search: false,
});

export const SEARCH_SYSTEM_PROMPT = searchSystemPrompt.trim();

export function selectionSystemPrompt(instructions: string, mode: 'client-search' | 'server-search'): string {
  const guidance = renderPrompt(selectionTemplate, {}, {
    instructions: false, client_search: mode === 'client-search', server_search: mode === 'server-search',
  });
  return `${instructions}\n\n${guidance}`;
}
