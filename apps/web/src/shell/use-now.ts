import { useEffect, useState } from 'react';

/**
 * Now (epoch ms), read again every `ms` while the component is shown, so words such as
 * "Synced 2 min ago" or "checked 5 minutes ago" keep true while a page stays open.
 */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
