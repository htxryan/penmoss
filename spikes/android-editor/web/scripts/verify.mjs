// Headless check of the built bundle at a Pixel-sized viewport.
//
//   pnpm build && node scripts/verify.mjs [screenshot.png]
//
// Serves dist/ at the same origin the Android app uses
// (https://appassets.androidplatform.net/assets/editor/), then:
//  1. loads the note and asserts zero console errors,
//  2. types the test paragraph with the keyboard and expects an exact match,
//  3. types a corrupted paragraph and expects the checker to flag it,
//  4. types the paragraph through IME composition events (CDP
//     Input.imeSetComposition + Input.insertText) and checks the IME log.
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const origin = 'https://appassets.androidplatform.net';
const url = `${origin}/assets/editor/index.html`;
const screenshot = process.argv[2];
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const failures = [];
const diffNote = (r) =>
  r.exact ? '' : ` ${JSON.stringify(r.ops.filter((o) => o.op !== 'equal'))}`;
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await context.route(`${origin}/**`, async (route) => {
  const path = new URL(route.request().url()).pathname.replace('/assets/editor/', '');
  try {
    const body = await readFile(join(dist, path));
    await route.fulfill({ body, contentType: types[extname(path)] ?? 'application/octet-stream' });
  } catch {
    await route.fulfill({ status: 404 });
  }
});

await page.goto(url);
await page.waitForFunction(() => window.penmoss?.isReady());
const stats = await page.evaluate(() => window.penmoss.getStats());
console.log('timings', JSON.stringify(stats.timings));
console.log('document', JSON.stringify(stats.document));
check(stats.document.words >= 5000, `sample note has >= 5000 words (${stats.document.words})`);
const counts = await page.evaluate(() => {
  const json = JSON.stringify(window.penmoss.getJSON());
  const n = (t) => json.split(`"type":"${t}"`).length - 1;
  return {
    codeBlock: n('codeBlock'),
    image: n('image'),
    table: n('table'),
    taskItem: n('taskItem'),
    link: n('link'),
    blockquote: n('blockquote'),
  };
});
console.log('nodes', JSON.stringify(counts));
check(
  counts.codeBlock >= 6 &&
    counts.image >= 4 &&
    counts.table >= 1 &&
    counts.taskItem > 0 &&
    counts.link > 0,
  'note has code blocks, images, a table, checklists and links',
);
if (screenshot) await page.screenshot({ path: screenshot });

const paragraph = await page.evaluate(() => window.penmoss.testParagraph);

// 2. Plain keyboard typing.
await page.evaluate(() => window.penmoss.startTest('playwright keyboard'));
await page.keyboard.type(paragraph, { delay: 2 });
let result = await page.evaluate(() => window.penmoss.checkTest());
check(
  result.exact,
  `keyboard typing: exact match (lost ${result.lost}, dup ${result.duplicated}, extra ${result.extra})${diffNote(result)}`,
);
const typedJson = await page.evaluate(() => window.penmoss.getTestJSON());
check(
  JSON.stringify(typedJson).includes(JSON.stringify(paragraph).slice(1, -1)),
  'getTestJSON contains the typed paragraph',
);

// 3. Corrupted typing: drop one character, duplicate one word.
const corrupted = paragraph.replace('quick', 'quik').replace('lazy dog', 'lazy lazy dog');
await page.evaluate(() => window.penmoss.startTest('playwright corrupted'));
await page.keyboard.type(corrupted, { delay: 1 });
result = await page.evaluate(() => window.penmoss.checkTest());
check(
  result.lost === 1 && result.duplicated === 5 && !result.exact,
  `checker flags corruption (lost ${result.lost}, dup ${result.duplicated}, extra ${result.extra})`,
);
if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, '-diff.png') });

// 4. IME composition via CDP, word by word like a keyboard with suggestions.
const cdp = await context.newCDPSession(page);
await page.evaluate(() => window.penmoss.startTest('cdp ime composition'));
const words = paragraph.split(' ');
for (const [index, word] of words.entries()) {
  for (let i = 1; i <= word.length; i++) {
    await cdp.send('Input.imeSetComposition', {
      text: word.slice(0, i),
      selectionStart: i,
      selectionEnd: i,
    });
  }
  await cdp.send('Input.insertText', { text: word });
  if (index < words.length - 1) await cdp.send('Input.insertText', { text: ' ' });
}
result = await page.evaluate(() => window.penmoss.checkTest());
check(
  result.exact,
  `IME composition: exact match (lost ${result.lost}, dup ${result.duplicated}, extra ${result.extra})${diffNote(result)}`,
);
const log = await page.evaluate(() => window.penmoss.imeLogTail(4000));
const kinds = new Set(log.map((e) => (e.inputType ? `${e.ev}:${e.inputType}` : e.ev)));
for (const kind of [
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'beforeinput:insertCompositionText',
  'tx',
]) {
  check(kinds.has(kind), `IME log records ${kind}`);
}

// 5. Formatting commands through the bridge.
const execOk = await page.evaluate(() => {
  const p = window.penmoss;
  const before = p.getText().length;
  const ok = ['bold', 'italic', 'bulletList', 'taskList', 'codeBlock', 'undo', 'redo'].map((c) =>
    p.exec(c),
  );
  return { ok, before, after: p.getText().length };
});
check(execOk.ok.every(Boolean), `exec() commands all ran (${execOk.ok.join(',')})`);

const exportSize = await page.evaluate(() => window.penmoss.exportLog().length);
check(exportSize > 1000, `export payload builds (${exportSize} bytes)`);

// 6. Native bridge contract: stub the WebMessageListener object the Android
//    shell injects (`penmossNative`) and check the messages it relies on.
const nativePage = await context.newPage();
nativePage.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
nativePage.on('pageerror', (e) => errors.push(String(e)));
await nativePage.addInitScript(() => {
  window.__nativeMessages = [];
  window.penmossNative = { postMessage: (m) => window.__nativeMessages.push(JSON.parse(m)) };
});
await nativePage.goto(url);
await nativePage.waitForFunction(() => window.__nativeMessages.some((m) => m.type === 'ready'));
// State is published once per animation frame, so let a frame pass after exec.
await nativePage.evaluate(() => window.penmoss.exec('bold'));
await nativePage.waitForTimeout(200);
await nativePage.evaluate(() => {
  window.penmoss.startTest('bridge');
  window.penmoss.checkTest();
  window.penmoss.requestExport('share');
});
await nativePage.waitForTimeout(200);
const messages = await nativePage.evaluate(() => window.__nativeMessages);
const byType = (t) => messages.filter((m) => m.type === t);
const ready = byType('ready')[0];
check(
  ready?.timings?.notePainted > 0,
  `bridge: ready message carries timings (notePainted ${ready?.timings?.notePainted} ms)`,
);
check(
  byType('state').some((m) => m.active.bold === true),
  'bridge: state message reports bold active',
);
check(byType('testResult').length === 1, 'bridge: testResult message sent');
const exported = byType('export')[0];
check(
  exported?.mode === 'share' && JSON.parse(exported.payload).imeLog.count > 0,
  'bridge: export message carries the JSON payload',
);
check(
  await nativePage.locator('#debug-bar').isHidden(),
  'bridge: browser debug bar hidden inside the app',
);

check(errors.length === 0, `zero console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);

await browser.close();
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
