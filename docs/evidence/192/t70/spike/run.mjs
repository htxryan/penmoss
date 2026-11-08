import { chromium } from '/Users/redhale/src/penmoss/node_modules/.pnpm/playwright@1.64.1/node_modules/playwright/index.mjs';
const b = await chromium.launch({ args: ['--allow-file-access-from-files', '--enable-unsafe-webgpu'] });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
await p.goto('file://' + process.argv[2]);
await p.waitForFunction('window.ready === true', null, { timeout: 30000 });
console.log(JSON.stringify(await p.evaluate(() => window.run('wasm'))));
await b.close();
