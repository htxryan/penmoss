// The app's modules the replay's frame (PEN-178) reads at build time bring apps/web's sources into
// this project's type check, and some of them are written for Vite: what they need of it, here.
interface ImportMetaEnv {
  readonly [key: string]: string | boolean | undefined;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
declare module '*.css';
