// `task audit:secrets` (T80.1, A1185) catches a planted token and lets the reviewed false
// positives through: gitleaks with .gitleaks.toml over a temporary folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(tmpdir(), 'penmoss-audit-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Exit status of gitleaks over one file holding `text`. @param {string} name @param {string} text */
function scan(name, text) {
  const folder = mkdtempSync(path.join(dir, `${name}-`));
  writeFileSync(path.join(folder, 'sample.ts'), text);
  const run = spawnSync(
    path.join(root, 'scripts/gitleaks.sh'),
    ['dir', '--no-banner', '--redact', '--config', path.join(root, '.gitleaks.toml'), folder],
    { encoding: 'utf8' },
  );
  return run.status;
}

describe('the secret scan', () => {
  it('fails on a planted GitHub token', () => {
    // Built at run time, so this file itself holds no token-shaped string.
    const token = ['ghp', '_', 'R8x2Lq0Zt7Vb4Nc1Ws9Dk3Fh6Jm5Pa2Ey8Gu'].join('');
    assert.equal(scan('token', `const token = '${token}';\n`), 1);
  });

  it('fails on a planted private key', () => {
    const header = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    const body =
      'MIIEowIBAAKCAQEA1Zt7Vb4Nc1Ws9Dk3Fh6Jm5Pa2Ey8GuR8x2Lq0Zt7Vb4Nc1Ws9Dk3Fh6Jm5Pa2Ey8Gu';
    assert.equal(scan('key', `${header}\n${body}\n${header.replace('BEGIN', 'END')}\n`), 1);
  });

  it('passes the reviewed false positives: ids, fake anchors, shortcuts', () => {
    const text = [
      "const comment = { token: '01JD2Z7Q8R4T6Y8W0E2R4T6YT1' };",
      'const anchor = { key: "0123456789abcdef01234567" };',
      "const shortcut = { key: 'Alt+Shift+KeyH' };",
    ].join('\n');
    assert.equal(scan('fixtures', `${text}\n`), 0);
  });
});
