/**
 * GitHub's device sign-in as a page shows it (T82, D63, A1170): Settings' Add form
 * (GitHubSignIn.tsx) and the first run's GitHub Access screens (FirstRunGitHub.tsx) share it.
 */
import { useEffect, useEffectEvent, useState } from 'react';
import type { DesktopGitHubSignIn, GitHubSignInState } from '../desktop/bridge';

/** What a sign-in that did not finish says, and the button's words then. */
const ENDED: Partial<Record<GitHubSignInState['state'], string>> = {
  denied: 'GitHub says the sign-in was not approved.',
  expired: 'The code ran out before it was approved. Ask for a new one.',
  cancelled: 'Sign-in cancelled.',
};

/** A device sign-in as a page shows it: its state, and Start, Cancel and Copy Code. */
export interface DeviceSignIn {
  /** False in a build without Penmoss's OAuth app, or a window that can't sign in. */
  readonly available: boolean;
  readonly state: GitHubSignInState;
  /** How a sign-in that did not finish ended, or why it could not start. */
  readonly ended: string | null;
  /** Main is asking GitHub for a code. */
  readonly asking: boolean;
  readonly copied: boolean;
  readonly start: () => Promise<void>;
  readonly cancel: () => void;
  readonly copy: () => void;
}

/**
 * GitHub's device sign-in (T82), for Settings' form and the first run: `onSignedIn` runs when a
 * sign-in started here, or one still waiting from before, is approved.
 */
export function useDeviceSignIn(
  signIn: DesktopGitHubSignIn | undefined,
  onSignedIn: () => void,
): DeviceSignIn {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<GitHubSignInState>({ state: 'idle' });
  const [started, setStarted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [asking, setAsking] = useState(false);
  const finished = useEffectEvent((next: GitHubSignInState) => {
    setState(next);
    if (next.state === 'signed-in' && started) onSignedIn();
  });

  useEffect(() => {
    if (!signIn) return;
    let live = true;
    void signIn
      .status()
      .catch(() => null)
      .then((status) => {
        if (!live || !status) return;
        setAvailable(status.available);
        // A sign-in still waiting from before (the form was closed and opened again) is shown,
        // and its approval lists the repositories as one started here would (review).
        if (status.state.state === 'waiting') {
          setState(status.state);
          setStarted(true);
        }
      });
    const stop = signIn.onChange((next) => finished(next));
    return () => {
      live = false;
      stop();
    };
  }, [signIn]);

  const start = async () => {
    // One start at a time: a second click would ask GitHub for a second code (review).
    if (asking || !signIn) return;
    setAsking(true);
    setProblem(null);
    setCopied(false);
    setStarted(true);
    try {
      const answer = await signIn.start().catch(() => null);
      if (!answer) {
        setProblem('This window can’t sign in to GitHub.');
      } else if ('ok' in answer) {
        setProblem(answer.ok ? null : answer.error.message);
      } else {
        setState(answer);
      }
    } finally {
      setAsking(false);
    }
  };

  const ended =
    state.state === 'waiting'
      ? null
      : (problem ?? (state.state === 'failed' ? state.message : (ENDED[state.state] ?? null)));
  return {
    available: available && signIn !== undefined,
    state,
    ended,
    asking,
    copied,
    start,
    cancel: () => void signIn?.cancel(),
    copy: () => {
      if (state.state !== 'waiting') return;
      void navigator.clipboard
        .writeText(state.userCode)
        .then(() => setCopied(true))
        .catch(() => setCopied(false));
    },
  };
}
