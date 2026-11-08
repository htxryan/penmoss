// Messages from the web editor to the Android shell.
//
// The shell registers a WebMessageListener (androidx.webkit) named `penmossNative`
// for the https://appassets.androidplatform.net origin only, so this object exists
// only inside the spike app. In a desktop browser every call is a no-op.

export type NativeMessage =
  | { type: 'ready'; timings: Record<string, number | null> }
  | { type: 'state'; active: Record<string, boolean>; canUndo: boolean; canRedo: boolean }
  | { type: 'export'; mode: 'share' | 'copy'; payload: string }
  | { type: 'testResult'; summary: string }
  | { type: 'log'; message: string };

interface NativePort {
  postMessage(message: string): void;
}

function port(): NativePort | undefined {
  return (window as unknown as { penmossNative?: NativePort }).penmossNative;
}

export function hasNative(): boolean {
  return port() !== undefined;
}

export function postToNative(message: NativeMessage): void {
  port()?.postMessage(JSON.stringify(message));
}
