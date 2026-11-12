// Packaging Penmoss for Mac (T29, D18, A225; release steps in docs/desktop.md).
//
// Signing and notarisation come only from the environment, never from this repository:
//   CSC_LINK (+ CSC_KEY_PASSWORD)  a Developer ID Application certificate (.p12, path or base64)
//   CSC_NAME                       or the name of one already in the login keychain
//   APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER        notarise with an App Store Connect key
//   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID     or with an Apple ID
//   PENMOSS_MAC_ARCH               arm64 (default, quicker locally) or universal: every build CI
//                                  makes is universal (P7, A1186), about twice the size
//   PENMOSS_BUILD_NUMBER           the CI build number (the run plus 1000, D65), shown as the
//                                  build in About Penmoss (CFBundleVersion, A403)
//   PENMOSS_APP_VERSION            the version updates compare and About Penmoss shows (P5,
//                                  A1188): X.Y.(Z+1)-alpha.<build> for a main build, X.Y.Z for a
//                                  stable one; without it, 0.1.<build> as before
// With no certificate the build is signed ad hoc (A403), is not notarised, and has no update
// feed, so its auto-update stays off (Squirrel.Mac refuses unsigned updates anyway). A signed
// build gets electron-updater's generic feed on GitHub Releases (P6): an alpha version writes
// `alpha-mac.yml` for the rolling `alpha` release, any other `latest-mac.yml` for Latest. CI
// publishes them (.github/scripts/releases.mjs); downloads.penmoss.app is retired (A1206).
const env = process.env;

/** GitHub Releases (P6): the rolling alpha release, or the latest stable one. */
const RELEASES = 'https://github.com/htxryan/penmoss/releases';

/**
 * The update feed, for signed builds only (updater.ts sets the URL it reads at run time).
 * electron-builder only writes the feed file; CI publishes it (.github/scripts/releases.mjs).
 * @param {boolean} isSigned @param {'alpha' | 'latest'} channel
 * @returns {import('electron-builder').Configuration['publish']}
 */
function updateFeed(isSigned, channel) {
  if (!isSigned) return null;
  return channel === 'alpha'
    ? [{ provider: 'generic', url: `${RELEASES}/download/alpha`, channel: 'alpha' }]
    : [{ provider: 'generic', url: `${RELEASES}/latest/download`, channel: 'latest' }];
}
const signed = Boolean(env.CSC_LINK || env.CSC_NAME);
const notaryKey = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
const notaryId = Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID);
const notarize = signed && (notaryKey || notaryId);
const build = /^\d+$/.test(env.PENMOSS_BUILD_NUMBER ?? '') ? env.PENMOSS_BUILD_NUMBER : null;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;
if (env.PENMOSS_APP_VERSION && !SEMVER.test(env.PENMOSS_APP_VERSION)) {
  throw new Error(`PENMOSS_APP_VERSION is not a version: ${env.PENMOSS_APP_VERSION}`);
}
/** The app's version (P5): CI's, else 0.1.<build> (A1001), else package.json's. */
const version = env.PENMOSS_APP_VERSION || (build ? `0.1.${build}` : null);
/** A main build is on the Alpha channel; a stable (or rehearsal) one on Latest (P6). */
const channel = version && /-alpha\./.test(version) ? 'alpha' : 'latest';
/**
 * File names (P2): a main build's are `penmoss-mac-<build>`, which the build-* releases
 * expect; a stable build's carry its version, `penmoss-mac-X.Y.Z`.
 */
const artifactBase =
  env.PENMOSS_APP_VERSION && channel === 'latest'
    ? `penmoss-mac-${env.PENMOSS_APP_VERSION}`
    : build
      ? `penmoss-mac-${build}`
      : null;
const arch = env.PENMOSS_MAC_ARCH === 'universal' ? 'universal' : 'arm64';

if (signed && !notarize) {
  console.warn('[penmoss] signing without notarisation credentials: Gatekeeper will warn');
}
if (!signed) console.warn('[penmoss] no signing identity (CSC_LINK or CSC_NAME): ad hoc signature');

/**
 * Signs an uncertified build ad hoc ('-'), always (A403). Apple Silicon runs no code without a
 * valid signature, and flipping the fuses breaks Electron's own, so an unsigned app is
 * "damaged". electron-builder looks '-' up in the keychain as a substring of identity names
 * before falling back to ad hoc, so it could pick up a real identity from the login keychain;
 * this hook ignores whatever it found. No timestamp: ad hoc signatures have none.
 * @param {import('@electron/osx-sign').SignOptions} opts
 */
async function signAdHoc(opts) {
  const { signAsync } = require('@electron/osx-sign');
  const forFile = opts.optionsForFile;
  await signAsync({
    ...opts,
    identity: '-',
    identityValidation: false,
    keychain: undefined,
    optionsForFile: (file) => ({ ...forFile?.(file), timestamp: 'none' }),
  });
}

/**
 * Builds the Mac's owner check (native/penmoss-auth.swift, T41, A504) before packing a Mac app,
 * so it ships in Contents/Resources/auth/Penmoss and is signed with the app. A Mac build
 * without it fails here: the app would refuse every admin change.
 * @param {import('electron-builder').BeforePackContext} context
 */
async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { buildAuthHelper } = await import('./scripts/build-auth-helper.mjs');
  buildAuthHelper();
}

/**
 * Makes the CLI's own bundle, Contents/Helpers/Penmoss CLI.app (PEN-121, amending A992), in each
 * Mac app it packs: agents' MCP servers run from it with a bundle id of their own, so none of
 * them stands in for Penmoss when it is opened from the Dock or the Finder.
 * @param {import('electron-builder').AfterPackContext} context
 */
async function afterPack(context) {
  const { afterPack: cliBundle } = await import('./scripts/cli-bundle.mjs');
  await cliBundle(context);
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'app.penmoss.mac',
  executableName: 'Penmoss',
  productName: 'Penmoss',
  copyright: 'Copyright © 2026 Ryan Henderson',
  // CFBundleVersion: the CI run that built it, so About Penmoss tells builds apart (A403).
  buildVersion: build ?? undefined,
  // The version updates compare (A1001, P5): every CI build is newer than the one before it.
  extraMetadata: version ? { version } : undefined,
  directories: { output: 'release', buildResources: 'build' },
  // Everything is bundled into dist/ (build.mjs and the web build): no node_modules.
  // dist/tray: the menu bar icon (T51, A945).
  // dist/embed-worker.cjs and dist/ort: search by meaning's worker and WASM (T75, A1152).
  files: [
    'package.json',
    'dist/boot.cjs',
    'dist/preload.cjs',
    'dist/embed-worker.cjs',
    'dist/embed-utility.cjs',
    'dist/ort/*',
    'dist/tray/*.png',
    'dist/web/**/*',
  ],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  beforePack,
  afterPack,
  protocols: [{ name: 'Penmoss link', schemes: ['penmoss'] }],
  // Electron's own switches, fixed in the binary (A224): no running as plain Node, no
  // NODE_OPTIONS or --inspect, only the integrity-checked app.asar, cookies encrypted.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  mac: {
    category: 'public.app-category.productivity',
    target: [
      { target: 'dmg', arch: [arch] },
      // The zip is what electron-updater downloads.
      { target: 'zip', arch: [arch] },
    ],
    // The dmg and the zip electron-updater downloads, named for their build or version (P2).
    artifactName: artifactBase ? `${artifactBase}.\${ext}` : undefined,
    icon: 'build/icon.png',
    darkModeSupport: true,
    minimumSystemVersion: '12.0',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // Without a certificate: an ad hoc signature, never a keychain identity (signAdHoc).
    identity: signed ? (env.CSC_NAME ?? undefined) : '-',
    sign: signed ? undefined : signAdHoc,
    notarize,
    // The CLI bundle (afterPack) is signed with the app, its copies of the helpers too, but not
    // again through its links to the app's frameworks and Resources: those are the app's own
    // files, signed once.
    signIgnore: ['/Penmoss CLI\\.app/Contents/(Frameworks/[^/]+\\.framework|Resources)(/|$)'],
    // The owner check, a plain Mach-O executable signed with the app (beforePack builds it).
    extraResources: [{ from: 'dist/native/Penmoss', to: 'auth/Penmoss' }],
  },
  dmg: { writeUpdateInfo: false },
  // `task desktop:package -- --linux dir`: a local check of the packaged app on Linux.
  linux: { target: ['dir'], category: 'Office', icon: 'build/icon.png' },
  publish: updateFeed(signed, channel),
};

module.exports = config;
