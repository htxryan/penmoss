/**
 * Syntax highlighting for code blocks (T9, decision A21): lowlight
 * (highlight.js grammars) rather than Shiki. Each grammar is its own lazily
 * loaded chunk (0.3–4 kB gzipped), and the highlighter itself (9 kB) loads
 * with the first code block that names a known language. Tokens carry
 * highlight.js class names (`hljs-keyword`, …), which the app's stylesheet maps
 * to theme tokens, so colours follow the active theme without re-highlighting.
 */
import type { LanguageFn } from 'highlight.js';

export interface CodeLanguage {
  /** highlight.js grammar name; also the picker's key. */
  readonly id: string;
  readonly label: string;
  /** What the language picker writes after the fence (```ts). */
  readonly fence: string;
  /** Other fence names that select this language (lower case). */
  readonly aliases: readonly string[];
}

type GrammarLoader = () => Promise<{ default: LanguageFn }>;

const GRAMMARS: Record<string, GrammarLoader> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  latex: () => import('highlight.js/lib/languages/latex'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  nix: () => import('highlight.js/lib/languages/nix'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

const language = (
  id: string,
  label: string,
  fence: string,
  aliases: readonly string[] = [],
): CodeLanguage => ({ id, label, fence, aliases: [id, fence, ...aliases] });

/** Languages the picker offers, in display order (Mermaid is added by the picker). */
export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  language('bash', 'Bash / Shell', 'bash', ['sh', 'shell', 'zsh', 'console', 'shellscript']),
  language('c', 'C', 'c', ['h']),
  language('cpp', 'C++', 'cpp', ['c++', 'cc', 'cxx', 'hpp', 'hh']),
  language('csharp', 'C#', 'cs', ['c#']),
  language('css', 'CSS', 'css'),
  language('dart', 'Dart', 'dart'),
  language('diff', 'Diff', 'diff', ['patch']),
  language('dockerfile', 'Dockerfile', 'dockerfile', ['docker']),
  language('elixir', 'Elixir', 'elixir', ['ex', 'exs']),
  language('go', 'Go', 'go', ['golang']),
  language('graphql', 'GraphQL', 'graphql', ['gql']),
  language('haskell', 'Haskell', 'haskell', ['hs']),
  language('xml', 'HTML / XML', 'html', ['xhtml', 'svg', 'plist']),
  language('ini', 'INI / TOML', 'ini', ['toml', 'conf', 'cfg']),
  language('java', 'Java', 'java'),
  language('javascript', 'JavaScript', 'js', ['jsx', 'mjs', 'cjs', 'node']),
  language('json', 'JSON', 'json', ['jsonc', 'json5']),
  language('kotlin', 'Kotlin', 'kotlin', ['kt', 'kts']),
  language('latex', 'LaTeX', 'latex', ['tex']),
  language('lua', 'Lua', 'lua'),
  language('makefile', 'Makefile', 'makefile', ['make', 'mk']),
  language('markdown', 'Markdown', 'md', ['mkd']),
  language('nginx', 'Nginx', 'nginx', ['nginxconf']),
  language('nix', 'Nix', 'nix'),
  language('objectivec', 'Objective-C', 'objc', ['objective-c', 'mm']),
  language('perl', 'Perl', 'perl', ['pl', 'pm']),
  language('php', 'PHP', 'php'),
  language('powershell', 'PowerShell', 'powershell', ['ps1', 'pwsh', 'ps']),
  language('protobuf', 'Protocol Buffers', 'protobuf', ['proto']),
  language('python', 'Python', 'python', ['py', 'gyp']),
  language('r', 'R', 'r'),
  language('ruby', 'Ruby', 'ruby', ['rb', 'gemspec']),
  language('rust', 'Rust', 'rust', ['rs']),
  language('scala', 'Scala', 'scala'),
  language('scss', 'SCSS', 'scss'),
  language('sql', 'SQL', 'sql', ['postgres', 'postgresql', 'mysql', 'sqlite']),
  language('swift', 'Swift', 'swift'),
  language('typescript', 'TypeScript', 'ts', ['tsx', 'mts', 'cts']),
  language('yaml', 'YAML', 'yaml', ['yml']),
];

const byAlias = new Map<string, CodeLanguage>();
for (const entry of CODE_LANGUAGES) {
  for (const alias of entry.aliases) byAlias.set(alias, entry);
}

/** The highlightable language a fence name selects, or null (plain text). */
export function resolveLanguage(name: string | null | undefined): CodeLanguage | null {
  return name ? (byAlias.get(name.trim().toLowerCase()) ?? null) : null;
}

/** A highlighted range in a code block's text, with highlight.js class names. */
export interface CodeToken {
  readonly from: number;
  readonly to: number;
  readonly className: string;
}

type Lowlight = ReturnType<(typeof import('lowlight'))['createLowlight']>;
type HastNode = ReturnType<Lowlight['highlight']>['children'][number];

let lowlight: Promise<Lowlight> | null = null;
let ready: Lowlight | null = null;
const loading = new Map<string, Promise<void>>();

function loadLowlight(): Promise<Lowlight> {
  lowlight ??= import('lowlight').then(({ createLowlight }) => (ready = createLowlight()));
  return lowlight;
}

function collect(nodes: readonly HastNode[], classes: string, offset: number, out: CodeToken[]) {
  let at = offset;
  for (const node of nodes) {
    if (node.type === 'text') {
      const to = at + node.value.length;
      if (classes && to > at) out.push({ from: at, to, className: classes });
      at = to;
    } else if (node.type === 'element') {
      const own = node.properties['className'];
      const names = Array.isArray(own) ? own.join(' ') : '';
      at = collect(node.children, [classes, names].filter(Boolean).join(' '), at, out);
    }
  }
  return at;
}

/**
 * The shared highlighter. `tokens` is synchronous once a grammar has loaded,
 * so the decoration plugin can highlight inside a transaction.
 */
export const codeHighlighter = {
  isLoaded(id: string): boolean {
    return ready?.registered(id) ?? false;
  },

  /** Loads the highlighter and one grammar; resolves at once when already loaded. */
  load(id: string): Promise<void> {
    const grammar = GRAMMARS[id];
    if (!grammar) return Promise.reject(new Error(`No grammar for ${id}`));
    let pending = loading.get(id);
    if (!pending) {
      pending = Promise.all([loadLowlight(), grammar()]).then(([instance, module]) => {
        instance.register({ [id]: module.default });
      });
      // A failed chunk load (offline before it was cached) may be retried later.
      pending.catch(() => loading.delete(id));
      loading.set(id, pending);
    }
    return pending;
  },

  /** Highlighted ranges of `code`, or null when the grammar has not loaded. */
  tokens(id: string, code: string): CodeToken[] | null {
    if (!ready?.registered(id)) return null;
    const tree = ready.highlight(id, code);
    const out: CodeToken[] = [];
    collect(tree.children, '', 0, out);
    return out;
  },
};
