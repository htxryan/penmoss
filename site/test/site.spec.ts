/**
 * penmoss.app as it is served (T80.15, P9, P13, P14): the built site under `wrangler dev` with the
 * real `_headers`. The brochure pages run no script under the site-wide policy; the docs run only
 * their own, with search, the theme switch and the mobile menu working under the docs' policy,
 * and nothing loads from anywhere but this site.
 */
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

const SITE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Every request leaving the site, and every console error, while `run` runs. */
async function watch(page: Page, run: () => Promise<void>) {
  const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost').origin;
  const offsite: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (url.origin !== origin && !url.hostname.match(/^(localhost|127\.0\.0\.1)$/))
      offsite.push(url.href);
  });
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await run();
  return { offsite, errors };
}

const BROCHURE = ['/', '/features', '/privacy'];

/** What a download button looks like: the styles PEN-73 keeps equal in both sections. */
function looks(link: ReturnType<Page['locator']>) {
  return link.evaluate((el) => {
    const s = getComputedStyle(el);
    const label = getComputedStyle(el.querySelector('.label')!);
    const sub = getComputedStyle(el.querySelector('.sub')!);
    return {
      background: s.backgroundColor,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      padding: s.padding,
      radius: s.borderRadius,
      label: label.fontSize,
      sub: sub.fontSize,
      height: el.getBoundingClientRect().height,
    };
  });
}

test.describe('the brochure pages', () => {
  for (const route of BROCHURE) {
    test(`${route} runs no script and keeps the site-wide policy`, async ({ page }) => {
      const { offsite, errors } = await watch(page, async () => {
        const response = await page.goto(route);
        expect(response?.status()).toBe(200);
        expect(response?.headers()['content-security-policy']).toBe(SITE_POLICY);
        expect(response?.headers()['x-content-type-options']).toBe('nosniff');
      });
      expect(await page.locator('script').count()).toBe(0);
      expect(offsite).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('the download buttons go straight to the latest stable release on GitHub (P1, P2)', async ({
    page,
  }) => {
    await page.goto('/');
    const mac = 'https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.dmg';
    const apk = 'https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.apk';
    const hero = page.locator('.hero');
    await expect(hero.getByRole('link', { name: 'Download for Mac' })).toHaveAttribute('href', mac);
    await expect(hero.getByRole('link', { name: 'Get the Android APK' })).toHaveAttribute(
      'href',
      apk,
    );
    const downloads = page.locator('#download');
    await expect(downloads.getByRole('link', { name: 'Download for Mac' })).toHaveAttribute(
      'href',
      mac,
    );
    await expect(downloads.getByRole('link', { name: 'Get the Android APK' })).toHaveAttribute(
      'href',
      apk,
    );
    await expect(downloads.getByRole('link', { name: 'Install Guide for Mac' })).toHaveAttribute(
      'href',
      '/docs/install/mac/',
    );
    await expect(
      downloads.getByRole('link', { name: 'Install Guide for Android' }),
    ).toHaveAttribute('href', '/docs/install/android/');
    await expect(downloads.getByRole('link', { name: 'Alpha Builds' })).toHaveAttribute(
      'href',
      'https://github.com/htxryan/penmoss/releases/tag/alpha',
    );
    await expect(downloads.getByRole('link', { name: 'All Releases' })).toHaveAttribute(
      'href',
      'https://github.com/htxryan/penmoss/releases',
    );
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 375, height: 812 },
  ]) {
    test(`the hero says both lead ideas and shows both downloads without scrolling at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Your Git. Your Agents. Your Notes.',
      );
      for (const name of ['Download for Mac', 'Get the Android APK']) {
        const box = await page.locator('.hero').getByRole('link', { name }).boundingBox();
        expect(box, name).not.toBeNull();
        expect(box!.y + box!.height, name).toBeLessThanOrEqual(viewport.height);
      }
    });
  }

  test('the hero and Download Penmoss draw the same download buttons (PEN-73)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.locator('a.download-button')).toHaveCount(4);
    const css = await page.evaluate(() =>
      [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText))
        .join('\n'),
    );
    expect(css).not.toMatch(/\.hero-cta|\.download-option|\.facts\b/);
    for (const name of ['Download for Mac', 'Get the Android APK']) {
      const hero = page.locator('.hero').getByRole('link', { name });
      const bottom = page.locator('#download').getByRole('link', { name });
      await expect(hero).toHaveClass(/download-button/);
      await expect(bottom).toHaveClass(/download-button/);
      expect(await bottom.innerText(), name).toBe(await hero.innerText());
      expect(await looks(bottom), name).toEqual(await looks(hero));
    }
    await expect(page.locator('#download .install-line')).toHaveText(
      'Install Guide for Mac · Install Guide for Android',
    );
    await expect(page.locator('#download .download-group + .release-line')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('hero-1440.png') });
    const bottom = page.locator('#download');
    await bottom.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    await bottom.screenshot({ path: test.info().outputPath('download-1440.png') });
    await expect(bottom.getByRole('link', { name: 'Get the Android APK' })).toBeInViewport();
  });

  test('Download Penmoss stacks like the hero on a phone (PEN-73)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const section = page.locator('#download');
    await section.scrollIntoViewIfNeeded();
    for (const scope of [page.locator('.hero'), section]) {
      const mac = (await scope.getByRole('link', { name: 'Download for Mac' }).boundingBox())!;
      const apk = (await scope.getByRole('link', { name: 'Get the Android APK' }).boundingBox())!;
      expect(apk.y).toBeGreaterThanOrEqual(mac.y + mac.height);
      for (const box of [mac, apk])
        expect(Math.abs(box.x + box.width / 2 - 375 / 2)).toBeLessThanOrEqual(1);
    }
    await page.waitForTimeout(2000);
    await section.screenshot({ path: test.info().outputPath('download-375.png') });
    await expect(section.getByRole('link', { name: 'Get the Android APK' })).toBeInViewport();
  });

  test('download buttons hover and focus alike in both sections (PEN-73)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const state = (link: ReturnType<Page['locator']>) =>
      link.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          background: s.backgroundColor,
          border: s.borderColor,
          outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`,
        };
      });
    const accent = await page.evaluate(() => {
      const probe = document.createElement('div');
      document.body.append(probe);
      probe.style.color = 'var(--pm-accent)';
      probe.style.backgroundColor = 'var(--pm-accent-hover)';
      const s = getComputedStyle(probe);
      const out = { accent: s.color, hover: s.backgroundColor };
      probe.remove();
      return out;
    });
    for (const name of ['Download for Mac', 'Get the Android APK']) {
      const states: Record<string, unknown>[] = [];
      for (const scope of ['.hero', '#download']) {
        const link = page.locator(scope).getByRole('link', { name });
        await link.hover();
        const hovered = await state(link);
        if (name === 'Download for Mac') expect(hovered.background).toBe(accent.hover);
        else expect(hovered.border).toBe(accent.accent);
        await page.mouse.move(0, 0);
        await page.keyboard.press('Shift');
        await link.focus();
        const focused = await state(link);
        expect(focused.outline, name).toBe(`solid 2px ${accent.accent}`);
        states.push({ hovered, focused });
      }
      expect(states[1], name).toEqual(states[0]);
    }
    await page.locator('#download').getByRole('link', { name: 'Download for Mac' }).hover();
    await page.waitForTimeout(2000);
  });

  for (const width of [320, 375, 768, 1440]) {
    test(`no page scrolls sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const route of [...BROCHURE, '/no-such-page']) {
        await page.goto(route);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, route).toBe(0);
      }
    });
  }

  test('each page has its landmarks, one h1, alt text and its metadata', async ({ page }) => {
    for (const route of BROCHURE) {
      await page.goto(route);
      await expect(page.getByRole('banner'), route).toHaveCount(1);
      await expect(page.getByRole('main'), route).toHaveCount(1);
      await expect(page.getByRole('contentinfo'), route).toHaveCount(1);
      await expect(page.getByRole('navigation', { name: 'Site' }), route).toHaveCount(1);
      await expect(page.locator('h1'), route).toHaveCount(1);
      for (const img of await page.locator('img').all()) {
        expect(await img.getAttribute('alt'), route).not.toBeNull();
      }
      await expect(page.getByRole('link', { name: 'Features' }).first()).toHaveAttribute(
        'href',
        '/features',
      );
      const canonical = `https://penmoss.app${route === '/' ? '/' : route}`;
      await expect(page.locator('link[rel="canonical"]'), route).toHaveAttribute(
        'href',
        new RegExp(`^${canonical}/?$`),
      );
      await expect(page.locator('meta[property="og:image"]'), route).toHaveAttribute(
        'content',
        'https://penmoss.app/img/social.png',
      );
      await expect(page.locator('meta[name="twitter:card"]'), route).toHaveAttribute(
        'content',
        'summary_large_image',
      );
      await expect(page.locator('meta[name="description"]'), route).toHaveAttribute(
        'content',
        /.{40,}/,
      );
    }
  });

  test('the social image, favicon, robots.txt and sitemap answer', async ({ request }) => {
    const social = await request.get('/img/social.png');
    expect(social.status()).toBe(200);
    expect(social.headers()['content-type']).toBe('image/png');
    expect((await request.get('/favicon.svg')).status()).toBe(200);
    const robots = await request.get('/robots.txt');
    expect(await robots.text()).toContain('Sitemap: https://penmoss.app/sitemap-index.xml');
    const sitemap = await (await request.get('/sitemap-0.xml')).text();
    for (const path of ['/', '/features/', '/privacy/', '/docs/']) {
      expect(sitemap).toContain(`<loc>https://penmoss.app${path}</loc>`);
    }
  });

  test('every link on the brochure pages to this site answers', async ({ page, request }) => {
    const checked = new Set<string>();
    for (const route of BROCHURE) {
      await page.goto(route);
      const hrefs = await page
        .locator('a[href^="/"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
      for (const href of hrefs) {
        const path = href.split('#')[0] ?? '';
        if (checked.has(path)) continue;
        checked.add(path);
        const response = await request.get(path);
        expect(response.status(), `${route} links to ${href}`).toBe(200);
      }
    }
    expect(checked.size).toBeGreaterThan(10);
  });

  test('the footer links Ryan Henderson to ryanhenderson.dev on every brochure page', async ({
    page,
  }) => {
    for (const route of BROCHURE) {
      await page.goto(route);
      const name = page.locator('.site-footer').getByRole('link', { name: 'Ryan Henderson' });
      await expect(name, route).toHaveAttribute('href', 'https://ryanhenderson.dev');
      await expect(page.locator('.footer-brand'), route).toHaveText(/^© \d{4} Ryan Henderson$/);
    }
  });

  test('the brochure pages stay light on a dark system, as drawn (A1220)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    for (const route of [...BROCHURE, '/no-such-page']) {
      await page.goto(route);
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background, route).toBe('rgb(251, 250, 246)');
    }
  });

  test('the hero shows the release line and the agents, and the home page keeps its six features', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page).toHaveTitle('Penmoss: Your Git. Your Agents. Your Notes.');
    // No pill over the title, and the title close under the header (PEN-74).
    await expect(page.locator('.hero .pill')).toHaveCount(0);
    const header = await page.locator('.site-header').boundingBox();
    const title = await page.locator('#hero-title').boundingBox();
    expect(title!.y - (header!.y + header!.height)).toBeLessThanOrEqual(48);
    await expect(page.locator('.arch img')).toHaveCount(3);
    await expect(page.locator('#features .feature-card')).toHaveCount(6);
    await expect(page.locator('#download')).toContainText('Install Guide');
    await expect(page.getByRole('link', { name: 'All Features' })).toHaveAttribute(
      'href',
      '/features',
    );
  });

  test('a missing page answers 404 with the site 404 page', async ({ page }) => {
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle('Not found · Penmoss');
    expect(await page.locator('script').count()).toBe(0);
  });
});

test.describe('the docs', () => {
  test('the docs home has its own policy and breaks none of it', async ({ page }) => {
    const { offsite, errors } = await watch(page, async () => {
      const response = await page.goto('/docs/');
      expect(response?.status()).toBe(200);
      const policy = response?.headers()['content-security-policy'] ?? '';
      expect(policy).toMatch(/^default-src 'none'; script-src 'self' 'wasm-unsafe-eval' 'sha256-/);
      expect(policy).not.toMatch(/https?:/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Penmoss Docs');
    });
    expect(offsite).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the header has the mark, the docs home, penmoss.app and GitHub; every page links to its source', async ({
    page,
  }) => {
    for (const route of ['/docs/', '/docs/install/mac/']) {
      await page.goto(route);
      const title = page.locator('header a.site-title');
      await expect(title).toHaveAttribute('href', '/docs/');
      await expect(title).toHaveText(/Penmoss\s*Docs/);
      await expect(title.locator('svg')).toHaveCount(1);
      await expect(
        page.locator('header').getByRole('link', { name: 'penmoss.app' }),
      ).toHaveAttribute('href', '/');
      await expect(
        page.locator('header a[href="https://github.com/htxryan/penmoss"]').first(),
      ).toBeAttached();
      await expect(page.getByRole('link', { name: 'Edit This Page on GitHub' })).toHaveAttribute(
        'href',
        /^https:\/\/github\.com\/htxryan\/penmoss\/edit\/main\/site\/src\/content\/docs\/docs\/.+\.mdx?$/,
      );
    }
  });

  test('search finds a page and opens it, under the policy', async ({ page }) => {
    const { offsite, errors } = await watch(page, async () => {
      await page.goto('/docs/');
      await page.getByRole('button', { name: 'Search' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Search' }).fill('notarised');
      const result = dialog.getByRole('link', { name: /The Mac app/ }).first();
      await expect(result).toBeVisible();
      await result.click();
      await expect(page).toHaveURL(/\/docs\/install\/mac\//);
    });
    expect(offsite).toEqual([]);
    expect(errors).toEqual([]);
  });

  // T80.16: every section of the sidebar is in the search index, by a word only its page has.
  for (const { section, query, title, path } of [
    {
      section: 'Get started',
      query: 'apksigner',
      title: /The Android app/,
      path: '/docs/install/android/',
    },
    {
      section: 'Write and organise',
      query: 'lightbox',
      title: /The editor/,
      path: '/docs/editor/',
    },
    {
      section: 'Agents',
      query: 'opencode.json',
      title: /Connect an agent/,
      path: '/docs/agents/connect/',
    },
    {
      section: 'Reference',
      query: 'idempotencyKey',
      title: /MCP tools/,
      path: '/docs/reference/mcp/',
    },
    {
      section: 'Help',
      query: 'analytics',
      title: /Privacy and security/,
      path: '/docs/help/privacy/',
    },
  ]) {
    test(`search finds a page in ${section}`, async ({ page }) => {
      await page.goto('/docs/');
      await page.getByRole('button', { name: 'Search' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Search' }).fill(query);
      const result = dialog.getByRole('link', { name: title }).first();
      await expect(result).toBeVisible();
      await result.click();
      await expect(page).toHaveURL(new RegExp(`${path.replaceAll('/', '\\/')}`));
    });
  }

  test('the docs start light, even on a dark system, and the theme switch changes the theme', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/docs/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const select = page.locator('starlight-theme-select select').first();
    await select.selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await select.selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the menu opens on a phone, with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { errors } = await watch(page, async () => {
      await page.goto('/docs/');
      await page.getByRole('button', { name: 'Menu' }).click();
      await expect(
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'The Mac App' }),
      ).toBeVisible();
    });
    expect(errors).toEqual([]);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  // PEN-111 (RN13): the stable releases' notes, from the latest release's release-notes.json at
  // build time, and 0.2.0, from before notes began (releases.mjs), whether or not GitHub answered.
  test('Release notes lists the stable releases down to 0.2.0, from the page foot and Updates', async ({
    page,
  }) => {
    await page.goto('/docs/help/updates/');
    await page
      .getByRole('main')
      .getByRole('link', { name: 'Release notes', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/docs\/releases\/$/);
    await page.goto('/docs/help/updates/');
    await page
      .getByRole('navigation', { name: 'More' })
      .getByRole('link', { name: 'Release Notes' })
      .click();
    await expect(page).toHaveURL(/\/docs\/releases\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Release notes');
    const releases = page.locator('.pm-release');
    await expect(releases.first().getByRole('heading', { level: 2 })).toHaveText(/^\d+\.\d+\.\d+$/);
    const first = page.locator('.pm-release[data-version="0.2.0"]');
    await expect(first).toHaveCount(1);
    await expect(releases.last()).toHaveAttribute('data-version', '0.2.0');
    await expect(first.getByRole('heading', { level: 3 })).toHaveText(['New']);
    await expect(first).toContainText('8 November 2026');
    await expect(first).toContainText('The first public release of Penmoss');
    await expect(first.getByRole('link', { name: 'on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/htxryan/penmoss/releases/tag/v0.2.0',
    );
  });

  // A1351: a short sidebar. Only Get Started is open on the docs home; a folded section opens
  // when it holds the page you are on. Release Notes, Privacy and Send Feedback are in the foot.
  test('the sidebar starts short, and opens the section holding the page', async ({ page }) => {
    await page.goto('/docs/');
    const nav = page.getByRole('navigation', { name: 'Main' });
    const groups = nav.locator('details');
    await expect(groups).toHaveCount(5);
    await expect(nav.locator('summary')).toHaveText([
      'Get Started',
      'Write and Organise',
      'Agents',
      'Reference',
      'Help',
    ]);
    await expect(nav.locator('details[open]')).toHaveCount(1);
    await expect(nav.locator('details[open] summary')).toHaveText('Get Started');
    // 27 pages in all (34 before A1351, 26 before Time Machine), but what shows is five section
    // rows and Get Started's five pages.
    await expect(nav.locator('a[href^="/docs/"]')).toHaveCount(27);
    await expect(nav.getByRole('link')).toHaveText([
      'Introduction',
      'The Mac App',
      'The Android App',
      'Your First Notebook',
      'More Devices',
    ]);
    for (const name of ['Release Notes', 'Privacy and Security', 'Send Feedback']) {
      await expect(nav.locator('a', { hasText: name })).toHaveCount(0);
    }
    const foot = page.getByRole('navigation', { name: 'More' });
    await expect(foot.getByRole('link')).toHaveText([
      'Release Notes',
      'Privacy and Security',
      'Send Feedback',
    ]);
    await page.goto('/docs/agents/connect/');
    await expect(nav.locator('details[open] summary')).toHaveText(['Get Started', 'Agents']);
    await expect(nav.getByRole('link', { name: 'Connect an Agent' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('Connect an agent shows one agent at a time, and the choice holds for the page', async ({
    page,
  }) => {
    const { errors } = await watch(page, async () => {
      await page.goto('/docs/agents/connect/');
      const tabs = page.getByRole('tablist').first();
      await expect(tabs.getByRole('tab')).toHaveText([
        'Claude Code',
        'Codex',
        'OpenCode',
        'Other MCP clients',
      ]);
      await expect(page.getByText('claude mcp add penmoss-notes-claude-code')).toBeVisible();
      await expect(page.getByText('[mcp_servers."penmoss-notes-codex"]')).toBeHidden();
      await tabs.getByRole('tab', { name: 'Codex' }).click();
      await expect(page.getByText('[mcp_servers."penmoss-notes-codex"]')).toBeVisible();
      await expect(page.getByText('claude mcp add penmoss-notes-claude-code')).toBeHidden();
      await page.reload();
      await expect(page.getByText('[mcp_servers."penmoss-notes-codex"]')).toBeVisible();
    });
    expect(errors).toEqual([]);
  });

  // A1351: the pages that moved answer with a permanent redirect to where their text went.
  for (const [from, to] of [
    ['/docs/agents/claude-code/', '/docs/agents/connect/'],
    ['/docs/agents/codex/', '/docs/agents/connect/'],
    ['/docs/agents/opencode', '/docs/agents/connect/'],
    ['/docs/agents/other-mcp/', '/docs/agents/connect/'],
    ['/docs/mac/', '/docs/install/mac/'],
    ['/docs/android', '/docs/install/android/'],
  ]) {
    test(`${from} moved to ${to}`, async ({ page, request }) => {
      const response = await request.get(from, { maxRedirects: 0 });
      expect(response.status()).toBe(301);
      expect(new URL(response.headers()['location'] ?? '', 'http://x').pathname).toBe(to);
      await page.goto(`${from}#receive-comments-from-your-notes`);
      expect(new URL(page.url()).pathname).toBe(to);
    });
  }

  test('a moved heading keeps its anchor on its new page', async ({ page }) => {
    await page.goto('/docs/mac/#keep-on-top');
    await expect(page).toHaveURL(/\/docs\/install\/mac\/#keep-on-top$/);
    await expect(page.locator('#keep-on-top')).toBeInViewport();
    await page.goto('/docs/agents/claude-code/#receive-comments-from-your-notes');
    await expect(page.locator('#receive-comments-from-your-notes')).toBeInViewport();
  });

  test('docs pages share the social card, and the docs home names the site once', async ({
    page,
  }) => {
    await page.goto('/docs/');
    await expect(page).toHaveTitle('Penmoss Docs');
    for (const route of [
      '/docs/',
      '/docs/install/mac/',
      '/docs/agents/connect/',
      '/docs/releases/',
    ]) {
      await page.goto(route);
      await expect(page.locator('meta[property="og:image"]'), route).toHaveAttribute(
        'content',
        'https://penmoss.app/img/social.png',
      );
      await expect(page.locator('meta[name="twitter:image"]'), route).toHaveAttribute(
        'content',
        'https://penmoss.app/img/social.png',
      );
      await expect(page.locator('meta[name="twitter:card"]'), route).toHaveAttribute(
        'content',
        'summary_large_image',
      );
      await expect(page.locator('title'), route).toHaveCount(1);
      expect(await page.title(), route).not.toMatch(/Penmoss Docs \| Penmoss Docs/);
    }
    await page.goto('/docs/install/mac/');
    await expect(page).toHaveTitle('The Mac app | Penmoss Docs');
  });
});
