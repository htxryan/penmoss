/** Local writes retried until they land (the notes service, service.ts, and its Trash). */
const RETRY_MAX_MS = 30_000;

/** Retries a local write with backoff until it lands (a full disk or a closing tab may fail it). */
export async function untilStored(write: () => Promise<unknown>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await write();
      return;
    } catch (error) {
      console.error('[notes] could not save locally; retrying', error);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(RETRY_MAX_MS, 200 * 2 ** attempt)),
      );
    }
  }
}
