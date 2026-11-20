/**
 * Where AI Descriptions' calls go (PEN-161): the Mac app's main process (`penmossDesktop.ai`), or
 * Android's Kotlin side (`penmossAndroidAi`, T6). Null in a plain browser: nothing is sent there.
 */
import type { AiBridge } from './describer';

/** Android's bridge, set on the WebView by the app (a JSON string in, a promise of JSON out). */
interface AndroidAi {
  describe(provider: string, model: string, prompt: string): Promise<string>;
}

declare global {
  interface Window {
    penmossAndroidAi?: AndroidAi;
  }
}

export function aiBridge(): AiBridge | null {
  if (typeof window === 'undefined') return null;
  const desktop = window.penmossDesktop?.ai;
  if (desktop)
    return { describe: (provider, model, prompt) => desktop.describe(provider, model, prompt) };
  const android = window.penmossAndroidAi;
  if (android) {
    return {
      describe: async (provider, model, prompt) => {
        const answer: unknown = JSON.parse(await android.describe(provider, model, prompt));
        return answer as Awaited<ReturnType<AiBridge['describe']>>;
      },
    };
  }
  return null;
}
