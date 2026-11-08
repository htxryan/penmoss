/**
 * Which notebook a quick capture goes into (T50 G8, A888; T39 pass 3 review, A914), the same on
 * the Mac as on Android's capture sheet. With one notebook there is nothing to choose. With
 * several it starts on the Journal notebook this device picked; with none picked it starts on
 * none, and Save waits: never the first one, silently.
 */
import type { OpenSourcesState } from '../sources/registry';

export function captureStart(
  state: Pick<OpenSourcesState, 'all' | 'journal' | 'journalPicked'>,
): string | null {
  if (state.all.length < 2 || state.journalPicked) return state.journal.id;
  return null;
}
