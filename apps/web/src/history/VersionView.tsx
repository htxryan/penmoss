/**
 * View This Version (A1572; Ryan's pick of the round 2 designs, C "Side by Side with Now"): a
 * modal over the window, all but History's panel, which stays beside it and usable. The chosen
 * version is on the left and the note as it is now on the right, both read-only, rendered as the
 * note is, and level with each other in one scroll. A block that differs is tinted on each side,
 * so the two sides show what Restore would change: on the left what it would bring back, on the
 * right what it would take away. Picking another version in the panel (a click, ↑ or ↓) swaps
 * the left side.
 *
 * Nothing is read again for it: the version is the markdown the docked preview read, and now is
 * this window's copy of the note (`HistorySource.current`).
 */
import type { DocJson } from '@penmoss/core/links';
import { renderBlocks, type ImageServices } from '@penmoss/editor';
import { editorSchema } from '@penmoss/editor/schema';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  blocksOf,
  compareRows,
  differs,
  readMarkdown,
  type CompareBlock,
  type CompareRow,
  type ReadNote,
} from './compare';
import { authorName, time } from './format';
import { AuthorMark } from './parts';
import type { HistoryDetail, HistorySource, HistoryVersion } from './source';

type Side = 'left' | 'right';

/** Where the sides' images come from: the editor's own (this device's attachments, A1032). */
export type ViewImages = Pick<ImageServices, 'resolve' | 'release'>;

const WEB_IMAGE = /^https?:\/\//i;

/**
 * Shows the images in `host` (rendered with their path in `data-src`) as the editor does: a web
 * address as it is, an attachment from this device's store or the notebook. An attachment's path
 * names its bytes (`attachments/<sha256>.<ext>`), so a version's image is the one it had then.
 * Returns the way to let them go.
 */
function showImages(host: HTMLElement, images: ViewImages | undefined): () => void {
  const controller = new AbortController();
  const held: string[] = [];
  for (const img of host.querySelectorAll<HTMLImageElement>('img[data-src]')) {
    const src = img.dataset['src'] ?? '';
    if (WEB_IMAGE.test(src)) {
      img.src = src;
      continue;
    }
    if (!images) continue;
    void images.resolve(src, controller.signal).then((url) => {
      if (!url) return;
      if (controller.signal.aborted) {
        images.release?.(src);
        return;
      }
      held.push(src);
      img.src = url;
    });
  }
  return () => {
    controller.abort();
    for (const src of held.splice(0)) images?.release?.(src);
  };
}

/** What a tinted block is, for a screen reader: the tint says it to the eye. */
const CHANGE_WORDS: Record<Side, string> = { left: 'Not in now: ', right: 'Added since: ' };

/** A block's text alone: what shows when it does not fit the editor's schema. */
function textOf(json: DocJson): string {
  return json.text ?? (json.content ?? []).map(textOf).join(json.type === 'doc' ? '\n' : '');
}

/** One block as the note shows it, read-only: its checkboxes disabled, its links out of Tab. */
function blockElement(block: CompareBlock, doc: Document): HTMLElement {
  if (block.kind === 'title') {
    const title = doc.createElement('h1');
    title.className = 'history-view-title';
    title.textContent = block.text;
    return title;
  }
  const rendered = renderBlocks(editorSchema(), [block.json], doc);
  const only = rendered?.childElementCount === 1 ? rendered.firstElementChild : null;
  let element: HTMLElement;
  if (only instanceof HTMLElement) element = only;
  else if (rendered) element = rendered;
  else {
    element = doc.createElement('p');
    element.textContent = textOf(block.json);
  }
  for (const control of element.querySelectorAll('input, button, select, textarea')) {
    control.setAttribute('disabled', '');
    control.setAttribute('tabindex', '-1');
  }
  for (const link of element.querySelectorAll('a[href]')) link.setAttribute('tabindex', '-1');
  return element;
}

/** A row's cell on one side: its block, tinted where it differs, or the gap held open. */
function cellOf(row: CompareRow, side: Side, doc: Document): HTMLElement {
  const block = row[side];
  if (!block) {
    const gap = doc.createElement('div');
    gap.className = 'history-view-gap';
    gap.setAttribute('aria-hidden', 'true');
    return gap;
  }
  const element = blockElement(block, doc);
  if (row.change !== 'same') {
    element.dataset['change'] = side === 'left' ? 'removed' : 'added';
    const words = doc.createElement('span');
    words.className = 'sr-only';
    words.textContent = CHANGE_WORDS[side];
    (element.querySelector('p, h1, h2, h3, h4, h5, h6, pre, th, td') ?? element).prepend(words);
  }
  return element;
}

/**
 * One side's blocks, a cell per row. The two sides share the rows (a subgrid of one grid), so a
 * block and its counterpart, or the gap beside it, stay level however tall either is. The blocks
 * are the side's own children, as in the editor, so the note's styles lay them out the same.
 */
function SideBlocks({
  rows,
  side,
  label,
  images,
}: {
  rows: readonly CompareRow[];
  side: Side;
  label: string;
  images: ViewImages | undefined;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.replaceChildren(...rows.map((row) => cellOf(row, side, host.ownerDocument)));
    return showImages(host, images);
  }, [rows, side, images]);
  return (
    <article
      ref={ref}
      className="ProseMirror history-view-side"
      data-side={side}
      data-testid={`history-view-${side}`}
      aria-label={label}
      style={{ gridRow: `1 / span ${Math.max(1, rows.length)}` }}
    />
  );
}

/** Where History's panel begins in the window: the modal ends there, and the cap above it. */
interface Edge {
  readonly left: number;
  readonly top: number;
}

export function VersionView({
  source,
  version,
  detail,
  nowKey,
  synced,
  panel,
  images,
  canRevert,
  busy,
  onRestore,
  onRevert,
  onCopy,
  onClose,
}: {
  source: HistorySource;
  version: HistoryVersion;
  /** What the docked preview read for the version, or null while it reads. */
  detail: HistoryDetail | null;
  /** Changes when the note may have changed since (the list read again): now is read again. */
  nowKey: unknown;
  /** Whether the note has no changes waiting to sync. */
  synced: boolean;
  /** History's panel, beside the modal: it owns it (`aria-owns`), and Tab goes round both. */
  panel: HTMLElement | null;
  /** The editor's images: each side shows its own, a version's as it had them. */
  images?: ViewImages;
  canRevert: boolean;
  busy: boolean;
  onRestore: () => void;
  onRevert: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [edge, setEdge] = useState<Edge | null>(null);

  useLayoutEffect(() => {
    if (!panel) return;
    const measure = () => {
      const box = panel.getBoundingClientRect();
      setEdge((last) =>
        last?.left === box.left && last.top === box.top ? last : { left: box.left, top: box.top },
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(panel);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [panel]);

  // Esc closes it from anywhere in it or in the panel, before the panel's own Esc closes the
  // panel. Not from elsewhere: a menu or the palette over it takes its own Esc.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const active = document.activeElement;
      const within =
        !active ||
        active === document.body ||
        Boolean(dialogRef.current?.contains(active)) ||
        Boolean(panel?.contains(active));
      if (!within) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [panel]);

  /** The note as it is now, read from this window's copy; 'missing' when there is none. */
  const [now, setNow] = useState<ReadNote | 'missing' | null>(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const markdown = (await source.current?.()) ?? null;
      const note = markdown === null ? null : await readMarkdown(markdown);
      if (current) setNow(note ?? 'missing');
    })().catch(() => current && setNow('missing'));
    return () => {
      current = false;
    };
  }, [source, nowKey]);

  /** The version, read from the markdown the preview already has. */
  const [then, setThen] = useState<{ readonly id: number; readonly note: ReadNote } | null>(null);
  useEffect(() => {
    if (!detail) return;
    let current = true;
    void readMarkdown(detail.markdown).then((note) => current && setThen({ id: detail.id, note }));
    return () => {
      current = false;
    };
  }, [detail]);

  const rows = useMemo(
    () =>
      then && then.id === version.id && now && now !== 'missing'
        ? compareRows(blocksOf(then.note), blocksOf(now))
        : null,
    [then, now, version.id],
  );
  const when = time(version.createdAt);
  const different = rows ? differs(rows) : false;

  /** A link in either side does not leave: the sides are to read. */
  const keepLinks = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('a')) event.preventDefault();
  };

  return createPortal(
    <>
      {/* Over the window's rows above the panel (the note's bar, the tabs): only the panel shows. */}
      <div
        className="history-view-cap"
        aria-hidden="true"
        style={edge ? { left: edge.left, height: edge.top } : { display: 'none' }}
      />
      <section
        ref={dialogRef}
        className="history-view"
        role="dialog"
        aria-modal="true"
        aria-label={`Version of ${when}`}
        aria-owns={panel?.id || undefined}
        data-testid="history-view"
        style={edge ? { width: edge.left } : undefined}
      >
        <div className="history-view-head">
          <AuthorMark authors={version.authors} />
          <h2 className="history-view-when">{when}</h2>
          <span className="history-view-who muted">
            {version.authors.map(authorName).join(', ')}
          </span>
          <span className="history-view-chip">
            <Icon name="lock" size={12} />
            Read Only
          </span>
          <span className="history-view-space" />
          {/* The short names, as in the docked preview, the full ones in tooltips (Ryan). */}
          <button
            type="button"
            className="btn primary"
            data-ui="submit"
            aria-label="Restore This Version"
            data-tip="Restore This Version"
            disabled={busy}
            onClick={onRestore}
          >
            <Icon name="history" />
            Restore
          </button>
          {canRevert ? (
            <button
              type="button"
              className="btn"
              data-ui="submit"
              aria-label="Revert This Edit"
              data-tip="Revert This Edit"
              disabled={busy}
              onClick={onRevert}
            >
              <Icon name="undo" />
              Revert
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            data-ui="submit"
            aria-label="Copy Text"
            data-tip="Copy Text"
            disabled={!detail}
            onClick={onCopy}
          >
            <Icon name="copy" />
            Copy
          </button>
          <span className="history-view-sep" aria-hidden="true" />
          <button
            type="button"
            className="btn quiet"
            data-ui="dismiss"
            aria-label="Close"
            data-tip="Close (Esc)"
            onClick={onClose}
            data-testid="history-view-close"
          >
            Close
            <kbd aria-hidden="true">Esc</kbd>
          </button>
        </div>
        <div className="history-view-sides-head" aria-hidden="true">
          <div>
            <strong>This Version</strong>
            <span className="muted">{when}</span>
            <span className="history-view-space" />
            {different ? (
              <span className="history-view-key" data-change="removed">
                Not in Now
              </span>
            ) : null}
          </div>
          <div>
            <strong>Now</strong>
            <span className="muted">{synced ? 'Synced' : 'Not synced yet'}</span>
            <span className="history-view-space" />
            {different ? (
              <span className="history-view-key" data-change="added">
                Added Since
              </span>
            ) : rows ? (
              <span className="muted" data-testid="history-view-same">
                The Same as This Version
              </span>
            ) : null}
          </div>
        </div>
        {/* One scroll for both sides, so they move together and stay level. */}
        <div
          className="history-view-scroll"
          role="group"
          aria-label={`${when} Beside Now`}
          tabIndex={0}
          data-testid="history-view-scroll"
        >
          {rows ? (
            <div className="note-body history-view-grid" onClick={keepLinks}>
              <SideBlocks rows={rows} side="left" label={when} images={images} />
              <SideBlocks rows={rows} side="right" label="Now" images={images} />
            </div>
          ) : now === 'missing' ? (
            <p className="muted history-view-loading" role="status">
              The note as it is now could not be read here.
            </p>
          ) : (
            <p className="muted history-view-loading" role="status">
              Reading the version…
            </p>
          )}
        </div>
      </section>
    </>,
    document.body,
  );
}
