/**
 * AI Descriptions' IPC (PEN-161): any main or note window reads the providers' status and asks for
 * a description; saving and removing the Anthropic key are Settings', in the main window, after a
 * key press or click. The key is never sent back. Every argument is checked here.
 */
import type { IpcHandlers } from '../ipc';
import { aiProviders } from '../services';

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length <= max ? value : null;

export function registerAiIpc(ipc: IpcHandlers): void {
  ipc.handle('aiStatus', () => aiProviders.status());
  ipc.handle('aiSaveKey', (_call, key) => {
    const value = text(key, 400);
    return value === null
      ? { ok: false as const, message: 'That doesn’t look like an API key.' }
      : aiProviders.saveKey(value);
  });
  ipc.handle('aiRemoveKey', () => aiProviders.removeKey());
  ipc.handle('aiAsked', () => aiProviders.markAsked());
  ipc.handle('aiTest', (_call, provider) => aiProviders.test(text(provider, 40) ?? ''));
  ipc.handle('aiDescribe', (_call, provider, model, prompt) => {
    const id = text(provider, 40);
    const name = text(model, 80);
    const body = text(prompt, 200_000);
    if (id === null || name === null || body === null) {
      return { ok: false as const, code: 'failed', message: 'The request was not valid.' };
    }
    return aiProviders.describe(id, name, body);
  });
}
