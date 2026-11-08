/**
 * Resolves wikilinks between their markdown text and note IDs. The app backs it
 * with the note registry; tests use an in-memory fake.
 */
export interface LinkResolver {
  /** The note a link target (a title, alias or path as written) refers to, or null. */
  resolve(target: string): string | null;
  /**
   * The text to write for a link to `noteId`: its current title, or its path
   * when the title is ambiguous. Null when the note is unknown (deleted), in
   * which case the link keeps the target it was written with.
   */
  linkText(noteId: string): string | null;
  /**
   * The note's title, when `linkText` returns something else (its path,
   * because the title is ambiguous): the link is then written
   * `[[path|Title]]`, keeping any alias it has (A10).
   */
  title?(noteId: string): string | null;
}

export interface CodecContext {
  links?: LinkResolver;
  /**
   * Rewrites the URL of every image, file and link as it is written (the git
   * mirror makes `attachments/…` relative to each note's folder, T27).
   */
  assetUrl?: (url: string) => string;
}

/** Resolves nothing: every wikilink keeps its written text. */
export const unresolvedLinks: LinkResolver = {
  resolve: () => null,
  linkText: () => null,
};
