// penmoss.app (D64, P9, P13): the brochure pages in src/pages, written by hand and shipping no
// JavaScript, and the user docs at /docs, built with Starlight. `node build.mjs` builds it into
// dist/ and writes the docs' Content-Security-Policy (P14) into dist/_headers.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

export const REPOSITORY = 'https://github.com/htxryan/penmoss';

export default defineConfig({
  site: 'https://penmoss.app',
  // /privacy, as the Play listing's URL expects, and /docs/install/mac/.
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  devToolbar: { enabled: false },
  // Starlight turns on prefetching, a script on every page; the brochure pages ship none (P9).
  prefetch: false,
  integrations: [
    starlight({
      title: 'Penmoss Docs',
      description:
        'How to install and use Penmoss, the notes app for your git repository and your AI agents.',
      logo: {
        light: './src/assets/moss-pen-light.svg',
        dark: './src/assets/moss-pen-dark.svg',
        alt: 'Penmoss',
      },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPOSITORY }],
      editLink: { baseUrl: `${REPOSITORY}/edit/main/site/` },
      customCss: ['./src/styles/tokens.css', './src/styles/docs.css'],
      // The site has its own 404 page (src/pages/404.astro).
      disable404Route: true,
      // The sections and pages of the plan's docs table (T80.16, A1215).
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Introduction', link: '/docs/' },
            { label: 'Install on Mac', slug: 'docs/install/mac' },
            { label: 'Install on Android', slug: 'docs/install/android' },
            { label: 'Your first notebook', slug: 'docs/first-notebook' },
            { label: 'More devices', slug: 'docs/more-devices' },
          ],
        },
        {
          label: 'Write and organise',
          items: [
            { label: 'The editor', slug: 'docs/editor' },
            { label: 'Notebooks, folders and tags', slug: 'docs/organise' },
            { label: 'Daily and weekly notes', slug: 'docs/journal' },
            { label: 'Quick capture', slug: 'docs/quick-capture' },
            { label: 'Links and the graph', slug: 'docs/links' },
            { label: 'Search', slug: 'docs/search' },
            { label: 'History and Trash', slug: 'docs/history' },
            { label: 'Comments', slug: 'docs/comments' },
            { label: 'Themes and fonts', slug: 'docs/themes' },
            { label: 'Keyboard shortcuts', slug: 'docs/shortcuts' },
          ],
        },
        {
          label: 'Apps',
          items: [
            { label: 'The Mac app', slug: 'docs/mac' },
            { label: 'The Android app', slug: 'docs/android' },
          ],
        },
        {
          label: 'Agents',
          items: [
            { label: 'How agents work', slug: 'docs/agents' },
            { label: 'Claude Code', slug: 'docs/agents/claude-code' },
            { label: 'Codex', slug: 'docs/agents/codex' },
            { label: 'OpenCode', slug: 'docs/agents/opencode' },
            { label: 'Other MCP clients', slug: 'docs/agents/other-mcp' },
            { label: 'Comments to agents', slug: 'docs/agents/comments' },
            { label: 'Agent activity and undo', slug: 'docs/agents/activity' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'The penmoss CLI', slug: 'docs/reference/cli' },
            { label: 'MCP tools', slug: 'docs/reference/mcp' },
            { label: 'Notebooks on disk', slug: 'docs/reference/notebook-format' },
            { label: 'Settings', slug: 'docs/reference/settings' },
          ],
        },
        {
          label: 'Help',
          items: [
            { label: 'Updates and the Alpha channel', slug: 'docs/help/updates' },
            { label: 'Sync, offline and merging', slug: 'docs/help/sync' },
            { label: 'Privacy and security', slug: 'docs/help/privacy' },
            { label: 'FAQ', slug: 'docs/help/faq' },
            { label: 'Send feedback', slug: 'docs/help/feedback' },
          ],
        },
      ],
      // The brochure's own pages are not Starlight's, so the validator cannot check them.
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false, exclude: ['/privacy'] })],
    }),
  ],
});
