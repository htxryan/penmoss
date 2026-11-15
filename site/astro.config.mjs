// penmoss.app (D64, P9, P13): the brochure pages in src/pages, written by hand and shipping no
// JavaScript, and the user docs at /docs, built with Starlight. `node build.mjs` builds it into
// dist/ and writes the docs' Content-Security-Policy (P14) into dist/_headers.
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

export const REPOSITORY = 'https://github.com/htxryan/penmoss';
const SITE = 'https://penmoss.app';
const SOCIAL_IMAGE = `${SITE}/img/social.png`;
const SOCIAL_IMAGE_ALT =
  'Penmoss: Your Git. Your Agents. Your Notes. A free, open source notes app for Mac and Android.';

export default defineConfig({
  site: SITE,
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
      // The social card the brochure pages share (T80.11), so a docs link unfurls with it too.
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: SOCIAL_IMAGE } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { property: 'og:image:alt', content: SOCIAL_IMAGE_ALT } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: SOCIAL_IMAGE } },
      ],
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
      // The sections and pages of the plan's docs table (T80.16, A1215), labelled as on the canvas,
      // made shorter (A1351): every section but Get Started starts folded (Starlight opens the
      // one holding the page you are on), the agents share one page, each app's page also holds
      // its install steps, and Release Notes, Privacy and Send Feedback live in the page foot.
      sidebar: [
        {
          label: 'Get Started',
          items: [
            { label: 'Introduction', link: '/docs/' },
            { label: 'The Mac App', slug: 'docs/install/mac' },
            { label: 'The Android App', slug: 'docs/install/android' },
            { label: 'Your First Notebook', slug: 'docs/first-notebook' },
            { label: 'More Devices', slug: 'docs/more-devices' },
          ],
        },
        {
          label: 'Write and Organise',
          collapsed: true,
          items: [
            { label: 'The Editor', slug: 'docs/editor' },
            { label: 'Notebooks, Folders and Tags', slug: 'docs/organise' },
            { label: 'Daily and Weekly Notes', slug: 'docs/journal' },
            { label: 'Quick Capture', slug: 'docs/quick-capture' },
            { label: 'Links and the Graph', slug: 'docs/links' },
            { label: 'Search', slug: 'docs/search' },
            { label: 'History and Trash', slug: 'docs/history' },
            { label: 'Time Machine', slug: 'docs/time-machine' },
            { label: 'Comments', slug: 'docs/comments' },
            { label: 'Themes and Fonts', slug: 'docs/themes' },
            { label: 'Keyboard Shortcuts', slug: 'docs/shortcuts' },
          ],
        },
        {
          label: 'Agents',
          collapsed: true,
          items: [
            { label: 'How Agents Work', slug: 'docs/agents' },
            { label: 'Connect an Agent', slug: 'docs/agents/connect' },
            { label: 'Comments to Agents', slug: 'docs/agents/comments' },
            { label: 'Agent Activity', slug: 'docs/agents/activity' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            { label: 'The penmoss CLI', slug: 'docs/reference/cli' },
            { label: 'MCP Tools', slug: 'docs/reference/mcp' },
            { label: 'Notebooks on Disk', slug: 'docs/reference/notebook-format' },
            { label: 'Settings', slug: 'docs/reference/settings' },
          ],
        },
        {
          label: 'Help',
          collapsed: true,
          items: [
            { label: 'Updates and the Alpha Channel', slug: 'docs/help/updates' },
            { label: 'Sync', slug: 'docs/help/sync' },
            { label: 'FAQ', slug: 'docs/help/faq' },
          ],
        },
      ],
      // The brochure's own pages are not Starlight's, so the validator cannot check them.
      plugins: [starlightLinksValidator({ errorOnLocalLinks: false, exclude: ['/privacy'] })],
    }),
  ],
});
