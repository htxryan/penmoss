import type { TokenLocation, TokenStore } from './io';

/**
 * A secret store in memory, standing in for a keychain: what the tests give
 * `nodeNotebooks` for git notebooks' tokens and writer secrets.
 */
export function memoryTokenStore(): TokenStore {
  const tokens = new Map<string, string>();
  return {
    describe: () => ({ keychain: 'memory', file: '(none)' }),
    get: (api) => {
      const token = tokens.get(api);
      return Promise.resolve(token ? { token, location: 'keychain' as const } : null);
    },
    set: (api, token) => {
      tokens.set(api, token);
      return Promise.resolve({ location: 'keychain' as const });
    },
    delete: (api) => {
      const removed: TokenLocation[] = tokens.delete(api) ? ['keychain'] : [];
      return Promise.resolve(removed);
    },
  };
}
