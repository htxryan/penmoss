import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createR2Store,
  encodeKey,
  loadProofStore,
  publishRefs,
  signV4,
  type Fetcher,
} from '../src/proof/store.ts';
import { testConfig } from './helpers.ts';

describe('AWS Signature V4 (A1223)', () => {
  it("matches AWS's own example (GET Object, s3 header-based auth)", () => {
    expect(
      signV4({
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/test.txt',
        headers: { Range: 'bytes=0-9' },
        payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        region: 'us-east-1',
        service: 's3',
        amzDate: '20130524T000000Z',
      }),
    ).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('encodes keys the way S3 does, keeping the slashes', () => {
    expect(encodeKey("runs/36-a b/it's(1).png")).toBe('runs/36-a%20b/it%27s%281%29.png');
  });
});

describe('the proof bucket', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-proof-'));
  writeFileSync(join(dir, 'web-1.png'), 'png-bytes');
  writeFileSync(join(dir, 'web-1.mp4'), 'mp4-bytes');
  writeFileSync(join(dir, 'notes.txt'), 'x');

  const store = (status = 200) => {
    const puts: { url: string; headers: Record<string, string> }[] = [];
    const fetcher: Fetcher = (url, init) => {
      puts.push({ url, headers: init.headers as Record<string, string> });
      return Promise.resolve(
        new Response(status === 200 ? '' : '<Error><Code>AccessDenied</Code></Error>', { status }),
      );
    };
    return {
      puts,
      store: createR2Store({
        accountId: 'acct',
        accessKeyId: 'AK',
        secret: 'SK',
        bucket: 'penmoss-factory-proof',
        publicUrl: 'https://proof.penmoss.app/',
        fetcher,
        now: () => new Date('2026-11-08T12:00:00.123Z'),
      }),
    };
  };

  it('uploads each referenced file and points the body at its public URL', async () => {
    const { puts, store: s } = store();
    const body = await publishRefs(
      'Before\n\n![web](./web-1.png)\n\n[▶ Watch the recording (MP4)](./web-1.mp4)\n\n![web](./web-1.png)',
      dir,
      ['web-1.png', 'web-1.mp4', 'web-1.png'],
      s,
      'runs/36-abc',
    );
    expect(body).toBe(
      'Before\n\n![web](https://proof.penmoss.app/runs/36-abc/web-1.png)\n\n[▶ Watch the recording (MP4)](https://proof.penmoss.app/runs/36-abc/web-1.mp4)\n\n![web](https://proof.penmoss.app/runs/36-abc/web-1.png)',
    );
    expect(puts.map((p) => p.url)).toEqual([
      'https://acct.r2.cloudflarestorage.com/penmoss-factory-proof/runs/36-abc/web-1.png',
      'https://acct.r2.cloudflarestorage.com/penmoss-factory-proof/runs/36-abc/web-1.mp4',
    ]);
    expect(puts[1]!.headers).toMatchObject({
      'content-type': 'video/mp4',
      'x-amz-date': '20261108T120000Z',
    });
    expect(puts[1]!.headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AK\/20261108\/auto\/s3\/aws4_request, SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("names R2's refusal, and refuses files that aren't proof", async () => {
    await expect(store(403).store.put(join(dir, 'web-1.png'), 'k/web-1.png')).rejects.toThrow(
      'R2 refused web-1.png: AccessDenied',
    );
    await expect(store().store.put(join(dir, 'notes.txt'), 'k/notes.txt')).rejects.toThrow(
      'only images and .mp4 videos',
    );
  });

  it('needs all three keys in a mode-600 proof.env', () => {
    const env = join(dir, 'proof.env');
    writeFileSync(env, 'R2_ACCOUNT_ID=a\nR2_ACCESS_KEY_ID=b\n');
    chmodSync(env, 0o600);
    const config = { ...testConfig(), proof: { ...testConfig().proof, envFile: env } };
    expect(loadProofStore(config)).toEqual({
      ok: false,
      error: `${env} needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY`,
    });
    writeFileSync(env, 'R2_ACCOUNT_ID=a\nR2_ACCESS_KEY_ID=b\nR2_SECRET_ACCESS_KEY=c\n');
    expect(loadProofStore(config).ok).toBe(true);
  });
});
