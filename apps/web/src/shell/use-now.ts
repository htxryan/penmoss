import { useEffect, useState } from 'react';

/**
 * Now (epoch ms), read again every `ms` while the component is shown, so words such as
 * "Synced 2 min ago" or "Checked 5 min ago" keep true while a page stays open.
 */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
