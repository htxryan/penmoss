// Vite's `import.meta.glob` (used to bundle the fixture corpus for workerd).
// Declared here because core does not depend on vite directly.
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query?: string; import?: string; eager: true },
  ): Record<string, T>;
}
