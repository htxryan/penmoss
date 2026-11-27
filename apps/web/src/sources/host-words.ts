/**
 * The words in Add Notebook that name where it runs (A1701): the Mac app, or a Penmoss relay,
 * which shows the app's own Add Notebook flow unchanged (`apps/web/src/relay`). Only these differ,
 * as "this Mac" and "this phone" do between the apps (ux-conventions, Every platform the same).
 */
export interface HostWords {
  /** Where an added notebook is: "this Mac". */
  readonly here: string;
  /** The sign-in found without asking, on the switcher's button. */
  readonly foundSignInTitle: string;
  /** The same, as a line under an account. */
  readonly foundSignInLine: string;
  /** Above Pick Repository's list when that sign-in read it. */
  readonly signedInThrough: string;
  readonly lookingForSignIn: string;
  /** Paste a URL, as a way to pick a repository. */
  readonly urlLine: string;
  readonly urlHint: string;
  readonly urlChecking: string;
  /** Where Penmoss's GitHub accounts are kept. */
  readonly accountsKept: string;
  readonly accountsCantKeep: string;
  /** An account other than the first, on the accounts' rows. */
  readonly otherAccount: string;
  /** Send Feedback files with the first account (the Mac's); a relay sends none. */
  readonly feedback: boolean;
}

export const MAC_WORDS: HostWords = {
  here: 'this Mac',
  foundSignInTitle: 'This Mac’s Git Sign-In',
  foundSignInLine: 'This Mac’s git sign-in',
  signedInThrough: 'Signed in through this Mac’s git',
  lookingForSignIn: 'Looking for this Mac’s GitHub sign-in…',
  urlLine: 'Anywhere this Mac’s git can push to',
  urlHint: 'SSH or HTTPS, anywhere this Mac’s git can push to.',
  urlChecking: 'Asking git about the repository…',
  accountsKept: 'kept in this Mac’s Keychain',
  accountsCantKeep: 'This Mac’s Keychain is not available, so no sign-in can be kept.',
  otherAccount: 'Signed in on this Mac',
  feedback: true,
};

export const RELAY_WORDS: HostWords = {
  here: 'this relay',
  foundSignInTitle: 'This Relay’s GitHub App',
  foundSignInLine: 'This relay’s GitHub App',
  signedInThrough: 'Signed in through this relay’s GitHub App',
  lookingForSignIn: 'Looking for this relay’s GitHub App…',
  urlLine: 'Any GitHub repository this relay can reach',
  urlHint: 'A GitHub repository this relay’s App is installed on, or an account here can push to.',
  urlChecking: 'Asking GitHub about the repository…',
  accountsKept: 'kept by this relay',
  accountsCantKeep: 'This relay can’t keep a sign-in.',
  otherAccount: 'Kept by this relay',
  feedback: false,
};

let words = MAC_WORDS;

export const hostWords = (): HostWords => words;

/** Once, before anything renders: the relay's page says it is a relay. */
export function setHostWords(next: HostWords): void {
  words = next;
}
