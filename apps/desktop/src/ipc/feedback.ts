/**
 * Send feedback's IPC (T49, A798; T57, A1010, A1011): a PNG of the asking window's own page,
 * never another window's, and the outbox's entry filed with the person's GitHub token.
 */
import { screenshotsOf } from '../github-token';
import type { IpcHandlers } from '../ipc';
import { log } from '../app-state';
import { githubToken } from '../services';

export function registerFeedbackIpc(ipc: IpcHandlers): void {
  ipc.handle('feedbackFile', (_call, payload, screenshots) => {
    const shots = screenshotsOf(screenshots);
    if (!shots) {
      return {
        status: 400,
        body: { error: { code: 'invalid_request', message: 'Screenshots are not readable' } },
      };
    }
    // The outbox's result, by its status only (PEN-137): never the report's text.
    return githubToken.file(payload, shots).then((answer) => {
      log(`feedback filed: ${answer.status}`);
      return answer;
    });
  });
  ipc.handle('feedbackCapture', async ({ event }) => {
    try {
      const image = await event.sender.capturePage();
      return image.isEmpty() ? null : new Uint8Array(image.toPNG());
    } catch {
      return null;
    }
  });
}
