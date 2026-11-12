/**
 * The app's log lines go to stdout and stderr, which may be a pipe that closes early (PEN-122,
 * A-NEW-1): `Penmoss | head -3`, or an agent or a script that stops reading. A write then fails
 * with EPIPE, emitted on the stream after console's own guard has gone, and with no listener it
 * is an uncaught exception: Electron's modal "A JavaScript error occurred in the main process",
 * and an app stuck behind it. Logging never takes the app down, so a failed write to either
 * stream is dropped, as is everything written after it.
 */
export function ignoreClosedOutput(
  streams: readonly NodeJS.EventEmitter[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) stream.on('error', dropWriteError);
}

function dropWriteError(): void {
  // Nothing to tell: the stream that would carry the message is the one that failed.
}
