/**
 * A note holding node types a later version of Penmoss wrote (A158). The
 * editor cannot bind to it without failing or overwriting them, so its text
 * shows read-only, and nothing is written: the server keeps the note as it
 * is for the version that knows those types.
 */
export function UnsupportedNote({
  types,
  text,
}: {
  readonly types: readonly string[];
  readonly text: string;
}) {
  return (
    <div className="note-unsupported" data-testid="note-unsupported">
      <p className="notice" role="status">
        A newer version of Penmoss wrote part of this note ({types.join(', ')}), so it opens
        read-only here and nothing in it changes. Reload Penmoss to update it and edit the note.
      </p>
      <div className="note-unsupported-text" aria-label="Note text (read-only)" tabIndex={0}>
        {text}
      </div>
    </div>
  );
}
