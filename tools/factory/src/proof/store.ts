/**
 * Where proof lives (A1223): GitHub takes PR attachments only from user accounts, and the
 * factory is a GitHub App, so the host uploads each run's screenshots and videos to the
 * `penmoss-factory-proof` R2 bucket and the PR links them from its public domain. The bucket's
 * S3 key is scoped to that bucket alone, lives in the host-only `proof.env`, and never enters
 * a sandbox. Uploads are signed with AWS Signature V4, which R2's S3 API takes.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { expandHome, type FactoryConfig } from '../config.ts';
import { loadEnvFile } from '../secrets.ts';

/** The names `proof.env` may hold. It is read on the host alone. */
export const PROOF_KEYS = {
  R2_ACCOUNT_ID: 'the Penmoss Cloudflare account ID',
  R2_ACCESS_KEY_ID: "the proof bucket's R2 access key ID (Object Read & Write, that bucket only)",
  R2_SECRET_ACCESS_KEY: "that key's secret",
} as const;

const TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
};

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** S3's path encoding: every byte but unreserved characters and `/`. */
export const encodeKey = (key: string) =>
  key
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replaceAll(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');

export interface SignInput {
  readonly method: string;
  readonly host: string;
  /** Already encoded. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
  readonly accessKeyId: string;
  readonly secret: string;
  readonly region: string;
  readonly service: string;
  /** `20130524T000000Z`. */
  readonly amzDate: string;
}

/** The `Authorization` header for a request with no query string (AWS Signature V4). */
export function signV4(input: SignInput): string {
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': input.amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    input.method,
    input.path,
    '',
    ...names.map((n) => `${n}:${headers[n]}`),
    '',
    names.join(';'),
    input.payloadHash,
  ].join('\n');
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secret}`, day), input.region), input.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

export interface ProofStore {
  /** Uploads a local file under `key` and returns its public URL. */
  put(file: string, key: string): Promise<string>;
}

export interface R2Options {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secret: string;
  readonly bucket: string;
  /** The bucket's public domain, `https://proof.penmoss.app`. */
  readonly publicUrl: string;
  readonly fetcher?: Fetcher;
  readonly now?: () => Date;
}

export function createR2Store(options: R2Options): ProofStore {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const host = `${options.accountId}.r2.cloudflarestorage.com`;
  return {
    async put(file, key) {
      const type = TYPES[extname(file).toLowerCase()];
      if (!type)
        throw new Error(`${basename(file)}: only images and .mp4 videos go in the proof bucket`);
      const body = readFileSync(file);
      const path = `/${options.bucket}/${encodeKey(key)}`;
      const amzDate = now()
        .toISOString()
        .replaceAll(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
      const payloadHash = sha256(body);
      const headers = {
        'content-type': type,
        'cache-control': 'public, max-age=31536000, immutable',
      };
      const authorization = signV4({
        method: 'PUT',
        host,
        path,
        headers,
        payloadHash,
        accessKeyId: options.accessKeyId,
        secret: options.secret,
        region: 'auto',
        service: 's3',
        amzDate,
      });
      const res = await fetcher(`https://${host}${path}`, {
        method: 'PUT',
        headers: {
          ...headers,
          'x-amz-content-sha256': payloadHash,
          'x-amz-date': amzDate,
          authorization,
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
        throw new Error(`R2 refused ${basename(file)}: ${code ?? `HTTP ${res.status}`}`);
      }
      return `${options.publicUrl.replace(/\/$/, '')}/${encodeKey(key)}`;
    },
  };
}

/** The proof bucket, from `factory.config.json` and the host-only `proof.env`. */
export function loadProofStore(
  config: FactoryConfig,
): { ok: true; store: ProofStore } | { ok: false; error: string } {
  const path = expandHome(config.proof.envFile);
  const loaded = loadEnvFile(path, PROOF_KEYS);
  if (!loaded.ok) return loaded;
  const c = loaded.secrets;
  if (!c.R2_ACCOUNT_ID || !c.R2_ACCESS_KEY_ID || !c.R2_SECRET_ACCESS_KEY)
    return {
      ok: false,
      error: `${path} needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY`,
    };
  return {
    ok: true,
    store: createR2Store({
      accountId: c.R2_ACCOUNT_ID,
      accessKeyId: c.R2_ACCESS_KEY_ID,
      secret: c.R2_SECRET_ACCESS_KEY,
      bucket: config.proof.bucket,
      publicUrl: config.proof.publicUrl,
    }),
  };
}

/**
 * Uploads every file a body references as `./name` (from `dir`) under `prefix/` and points the
 * references at the uploads. A file the body doesn't reference is uploaded only if listed.
 */
export async function publishRefs(
  body: string,
  dir: string,
  files: readonly string[],
  store: ProofStore,
  prefix: string,
): Promise<string> {
  let out = body;
  for (const name of [...new Set(files)]) {
    const url = await store.put(join(dir, name), `${prefix}/${name}`);
    out = out.replaceAll(`(./${name})`, `(${url})`);
  }
  return out;
}
