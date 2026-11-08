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
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPOSITORY }],
      editLink: { baseUrl: `${REPOSITORY}/edit/main/site/` },
      customCss: ['./src/styles/tokens.css', './src/styles/docs.css'],
      // The header, theme menu and page foot as drawn on the design canvas (Docs.dc.html).
      components: {
        Header: './src/components/docs/Header.astro',
        SiteTitle: './src/components/docs/SiteTitle.astro',
        ThemeProvider: './src/components/docs/ThemeProvider.astro',
        ThemeSelect: './src/components/docs/ThemeSelect.astro',
        Footer: './src/components/docs/Footer.astro',
      },
      // The site has its own 404 page (src/pages/404.astro).
      disable404Route: true,
      // The sections and pages of the plan's docs table (T80.16, A1215), labelled as on the canvas.
      sidebar: [
        {
          label: 'Get Started',
          items: [
            { label: 'Introduction', link: '/docs/' },
            { label: 'Install on Mac', slug: 'docs/install/mac' },
            { label: 'Install on Android', slug: 'docs/install/android' },
            { label: 'Your First Notebook', slug: 'docs/first-notebook' },
            { label: 'More Devices', slug: 'docs/more-devices' },
          ],
        },
        {
          label: 'Write and Organise',
          items: [
            { label: 'The Editor', slug: 'docs/editor' },
            { label: 'Notebooks, Folders and Tags', slug: 'docs/organise' },
            { label: 'Daily and Weekly Notes', slug: 'docs/journal' },
            { label: 'Quick Capture', slug: 'docs/quick-capture' },
            { label: 'Links and the Graph', slug: 'docs/links' },
            { label: 'Search', slug: 'docs/search' },
            { label: 'History and Trash', slug: 'docs/history' },
            { label: 'Comments', slug: 'docs/comments' },
            { label: 'Themes and Fonts', slug: 'docs/themes' },
            { label: 'Keyboard Shortcuts', slug: 'docs/shortcuts' },
          ],
        },
        {
          label: 'Apps',
          items: [
            { label: 'The Mac App', slug: 'docs/mac' },
            { label: 'The Android App', slug: 'docs/android' },
          ],
        },
        {
          label: 'Agents',
          items: [
            { label: 'How Agents Work', slug: 'docs/agents' },
            { label: 'Claude Code', slug: 'docs/agents/claude-code' },
            { label: 'Codex', slug: 'docs/agents/codex' },
            { label: 'OpenCode', slug: 'docs/agents/opencode' },
            { label: 'Other MCP Clients', slug: 'docs/agents/other-mcp' },
            { label: 'Comments to Agents', slug: 'docs/agents/comments' },
            { label: 'Agent Activity', slug: 'docs/agents/activity' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'The penmoss CLI', slug: 'docs/reference/cli' },
            { label: 'MCP Tools', slug: 'docs/reference/mcp' },
            { label: 'Notebooks on Disk', slug: 'docs/reference/notebook-format' },
            { label: 'Settings', slug: 'docs/reference/settings' },
          ],
        },
        {
          label: 'Help',
          items: [
            { label: 'Updates and the Alpha Channel', slug: 'docs/help/updates' },
            { label: 'Sync', slug: 'docs/help/sync' },
            { label: 'Privacy and Security', slug: 'docs/help/privacy' },
            { label: 'FAQ', slug: 'docs/help/faq' },
            { label: 'Send Feedback', slug: 'docs/help/feedback' },
          ],
        },
      ],
      // The brochure's own pages are not Starlight's, so the validator cannot check them.
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false, exclude: ['/privacy'] })],
    }),
  ],
});
