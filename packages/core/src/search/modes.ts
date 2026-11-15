/**
 * How a search is asked for: by its words, by meaning, or both fused (A1155), as the apps' search,
 * `penmoss search --mode` and the MCP search tool name them.
 */
export const SEARCH_MODES = ['full-text', 'semantic', 'hybrid'] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
