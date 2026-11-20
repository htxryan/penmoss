/** AI Descriptions' providers as this Mac reports them (PEN-161): Settings and the first run. */
import { useEffect, useState } from 'react';
import { desktop, type DesktopAiStatus } from '../desktop/bridge';

/** The providers' status on this Mac, read again when a key or a sign-in changes. */
export function useAiStatus(): DesktopAiStatus | null {
  const [status, setStatus] = useState<DesktopAiStatus | null>(null);
  useEffect(() => {
    const ai = desktop()?.ai;
    if (!ai) return;
    let live = true;
    const read = () =>
      void ai.status().then((next) => {
        if (live) setStatus(next);
      });
    read();
    const off = ai.onChange(read);
    return () => {
      live = false;
      off();
    };
  }, []);
  return status;
}
