import type { LinkResolver } from '../../src/markdown/context';

/**
 * The markdown fixture corpus, bundled by Vite so it loads the same way in
 * Node and in workerd (which has no file system).
 */
const files = import.meta.glob<string>('../fixtures/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export interface Fixture {
  name: string;
  input: string;
  /** The normalised output: `name.expected.md` when present, else the input itself. */
  expected: string;
}

export const fixtures: Fixture[] = Object.entries(files)
  .filter(([path]) => !path.endsWith('.expected.md'))
  .map(([path, input]) => {
    const name = path.replace(/^.*\//, '').replace(/\.md$/, '');
    const expected = files[path.replace(/\.md$/, '.expected.md')] ?? input;
    return { name, input, expected };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const NOTES: Record<string, string> = {
  n1: 'Penmoss — sync design',
  n2: 'Penmoss — MCP tools',
  n3: 'Penmoss — product brief',
};

/** The note registry the fixtures link into; other titles stay unresolved. */
export const fixtureLinks: LinkResolver = {
  resolve: (target) => Object.keys(NOTES).find((id) => NOTES[id] === target) ?? null,
  linkText: (noteId) => NOTES[noteId] ?? null,
};
