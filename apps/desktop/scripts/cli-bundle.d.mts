// Types for cli-bundle.mjs (the Mac app's CLI bundle, PEN-121).
export declare const CLI_BUNDLE_ID: string;
export declare const CLI_APP_NAME: string;
export declare const CLI_APP_IN_CONTENTS: string;
export declare function makeCliBundle(appPath: string): string;
export declare function afterPack(context: {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}): Promise<void>;
