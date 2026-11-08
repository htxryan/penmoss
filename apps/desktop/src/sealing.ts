/**
 * Whether safeStorage really encrypts what the Mac app seals: git notebooks' tokens and writer
 * secrets (A853) and the person's GitHub token (A1012). On Linux its `basic_text` backend (no
 * keyring) uses a fixed key, which is no better than plain text. Only an unpackaged test build
 * may accept it (`PENMOSS_TEST_BASIC_TEXT_STORAGE`, config.ts), since CI's xvfb has no keyring.
 */
export function encryptionUsable(options: {
  readonly platform: NodeJS.Platform;
  readonly available: boolean;
  readonly backend: string;
  readonly allowBasicText?: boolean;
}): boolean {
  if (!options.available) return false;
  if (options.platform !== 'linux') return true;
  return options.backend !== 'basic_text' || options.allowBasicText === true;
}
