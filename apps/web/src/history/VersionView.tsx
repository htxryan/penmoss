/**
 * View This Version (A1572; Ryan's pick of the round 2 designs, C "Side by Side with Now"): a
 * modal over the window, all but History's panel, which stays beside it and usable. The chosen
 * version is on the left and the note as it is now on the right, both read-only, rendered as the
 * note is, and level with each other in one scroll. A block that differs is tinted on each side,
 * so the two sides show what Restore would change: on the left what it would bring back, on the
 * right what it would take away. Picking another version in the panel (a click, ↑ or ↓) swaps
 * the left side.
 *
 * Diff (the default, remembered on this device) shows only the changed blocks, each with a few
 * of the same blocks around it, as a code review does; a fold stands for the rest and opens on a
 * click. Full File shows every block. Each block carries its line in the markdown, in a gutter.
 *
 * Nothing is read again for it: the version is the markdown the docked preview read, and now is
 * this window's copy of the note (`HistorySource.current`).
 */
import type { DocJson } from '@penmoss/core/links';
import { renderBlocks, type ImageServices } from '@penmoss/editor';
import { editorSchema } from '@penmoss/editor/schema';
import { Icon } from '@penmoss/ui/icons';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { DialogClose } from '../shell/DialogClose';
import { devicePref, useDevicePref } from '../shell/device-pref';
import {
  blocksOf,
  compareRows,
  diffItems,
  differs,
  fullItems,
  readMarkdown,
  type CompareBlock,
  type CompareRow,
  type DiffItem,
  type ReadNote,
} from './compare';
import { useFit } from './fit';
import { authorName, time } from './format';
import { AuthorMark } from './parts';
import type { HistoryDetail, HistorySource, HistoryVersion } from './source';

type Side = 'left' | 'right';

/** Where the sides' images come from: the editor's own (this device's attachments, A1032). */
export type ViewImages = Pick<ImageServices, 'resolve' | 'release'>;

const WEB_IMAGE = /^https?:\/\//i;

/** Diff (just the changes) or Full File (every block). */
export type ViewMode = 'diff' | 'full';

/** Diff or Full File, as last chosen on this device: Diff unless Full File was. */
export const VIEW_MODE_KEY = 'penmoss.historyView.mode';
const viewMode = devicePref<ViewMode>(VIEW_MODE_KEY, {
  parse: (stored) => (stored === 'full' ? 'full' : 'diff'),
  serialise: (mode) => (mode === 'diff' ? null : mode),
});

/** Wrap Lines, as last chosen on this device: on unless it was turned off (Ryan's review of #210). */
export const VIEW_WRAP_KEY = 'penmoss.historyView.wrap';
const viewWrap = devicePref<boolean>(VIEW_WRAP_KEY, {
  parse: (stored) => stored !== 'off',
  serialise: (wrap) => (wrap ? null : 'off'),
});

/** The toggle's names, for what it switches to: in full, and short for a narrow head. */
const MODE_NAMES: Record<ViewMode, { readonly long: string; readonly short: string }> = {
  diff: { long: 'Show Diff', short: 'Diff' },
  full: { long: 'Show Full File', short: 'Full File' },
};

/** A commit's short name, as git shows it. */
const shortSha = (commit: string) => commit.slice(0, 7);

/** The folds' words: `⋯ 12 unchanged lines`. */
const foldWords = (lines: number) => `⋯ ${lines} unchanged ${lines === 1 ? 'line' : 'lines'}`;

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
 * One side's blocks, a cell per row shown, each after its line number in the markdown (a gap's
 * gutter is empty). The two sides share the rows (a subgrid of one grid), so a block and its
 * counterpart, or the gap beside it, stay level however tall either is; a fold's row is empty on
 * both, under the fold. The blocks are the side's own children, as in the editor, so the note's
 * styles lay them out the same.
 */
function SideBlocks({
  rows,
  items,
  side,
  label,
  images,
}: {
  rows: readonly CompareRow[];
  items: readonly DiffItem[];
  side: Side;
  label: string;
  images: ViewImages | undefined;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const doc = host.ownerDocument;
    const cells: HTMLElement[] = [];
    items.forEach((item, at) => {
      const row = item.kind === 'row' ? rows[item.index] : undefined;
      if (!row) return;
      const gridRow = String(at + 1);
      const number = doc.createElement('span');
      number.className = 'history-view-line';
      number.setAttribute('aria-hidden', 'true');
      number.dataset['testid'] = 'history-view-line';
      const start = row[side]?.lines?.start;
      if (start !== undefined) number.textContent = String(start);
      number.style.gridRow = gridRow;
      const cell = cellOf(row, side, doc);
      cell.style.gridRow = gridRow;
      cells.push(number, cell);
    });
    // The gutter's band, under the numbers in every row (Ryan's review of #210).
    const band = document.createElement('div');
    band.className = 'history-view-gutter';
    band.setAttribute('aria-hidden', 'true');
    band.style.gridRow = '1 / -1';
    host.replaceChildren(band, ...cells);
    return showImages(host, images);
  }, [rows, items, side, images]);
  return (
    <article
      ref={ref}
      className="ProseMirror history-view-side"
      data-side={side}
      data-testid={`history-view-${side}`}
      aria-label={label}
      style={{ gridRow: `1 / span ${Math.max(1, items.length)}` }}
    />
  );
}

/** The most digits a line number has on either side: the gutters' width. */
function gutterDigits(rows: readonly CompareRow[]): number {
  let most = 1;
  for (const row of rows) {
    for (const block of [row.left, row.right]) {
      const end = block?.lines?.start;
      if (end !== undefined) most = Math.max(most, String(end).length);
    }
  }
  return most;
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
  onCopySha,
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
  /** Copies the version's commit (its full SHA), from the short one over the left side. */
  onCopySha: (commit: string) => void;
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
  /** Read, and the same as now: one placeholder, in Diff and Full File alike (Ryan's review of #210). */
  const same = rows !== null && rows !== undefined && !different;

  const [mode, setMode] = useDevicePref(viewMode);
  const [wrap, setWrap] = useDevicePref(viewWrap);
  /** The folds opened, by their first row, for these rows: another version's start closed. */
  const [opened, setOpened] = useState<{
    readonly rows: readonly CompareRow[] | null;
    readonly folds: ReadonlySet<number>;
  }>({ rows: null, folds: new Set() });
  const folds = useMemo(
    () => (opened.rows === rows ? opened.folds : new Set<number>()),
    [opened, rows],
  );
  const items = useMemo(
    () => (rows ? (mode === 'diff' ? diffItems(rows, folds) : fullItems(rows)) : null),
    [rows, mode, folds],
  );
  const openFold = (from: number) => setOpened({ rows, folds: new Set([...folds, from]) });
  const next: ViewMode = mode === 'diff' ? 'full' : 'diff';

  // A head too narrow for every word: the toggle's short name, then words drop (as History's).
  const [fit, headRef] = useFit(3, `${canRevert} ${same}`);

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
        <div className="history-view-head" ref={headRef} data-fit={fit || undefined}>
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
          {/* Named for what it switches to; short in a narrow head (`data-fit`). None when the
              version is the note as it is now: both modes show the one placeholder. */}
          {same ? null : (
            <button
              type="button"
              className="btn"
              data-ui="option"
              aria-pressed={wrap}
              aria-label="Wrap Lines"
              data-tip="Wrap Lines"
              data-testid="history-view-wrap"
              onClick={() => setWrap(!wrap)}
            >
              <Icon name="wrap" />
              <span className="history-action-word">Wrap Lines</span>
            </button>
          )}
          {same ? null : (
            <button
              type="button"
              className="btn"
              data-ui="option"
              aria-label={MODE_NAMES[next].long}
              data-tip={MODE_NAMES[next].long}
              data-testid="history-view-mode"
              onClick={() => setMode(next)}
            >
              <Icon name={next === 'diff' ? 'diff' : 'file'} />
              <span className="history-action-word history-view-long">{MODE_NAMES[next].long}</span>
              <span className="history-action-word history-view-short">
                {MODE_NAMES[next].short}
              </span>
            </button>
          )}
          {same ? null : <span className="history-view-sep" aria-hidden="true" />}
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
            <span className="history-action-word">Restore</span>
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
              <span className="history-action-word">Revert</span>
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
            <span className="history-action-word">Copy</span>
          </button>
          <span className="history-view-sep" aria-hidden="true" />
          {/* The app's × for a dialog (Ryan): Close, its tooltip Close (Esc). */}
          <DialogClose label="Close" onClose={onClose} />
        </div>
        {/* One scroll for both sides, so they move together and stay level. The sides' names
            scroll in it too, over them, so the two lines between the sides are one. */}
        <div
          className="history-view-scroll"
          role="group"
          aria-label={`${when} Beside Now`}
          tabIndex={0}
          data-testid="history-view-scroll"
        >
          {same ? null : (
            <div className="history-view-sides-head" data-testid="history-view-sides-head">
              <span className="history-view-divider" aria-hidden="true" />
              <div>
                {version.commit ? (
                  <>
                    <button
                      type="button"
                      className="history-view-sha"
                      data-ui="submit"
                      aria-label={`Copy Commit SHA ${shortSha(version.commit)}`}
                      data-tip="Copy Commit SHA"
                      data-testid="history-view-sha"
                      onClick={() => version.commit && onCopySha(version.commit)}
                    >
                      {shortSha(version.commit)}
                    </button>
                    <span className="muted" aria-hidden="true">
                      ·
                    </span>
                  </>
                ) : (
                  <strong>This Version</strong>
                )}
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
                ) : null}
              </div>
            </div>
          )}
          {same ? (
            <div className="empty-state history-view-empty" data-testid="history-view-no-changes">
              <span className="history-view-empty-icon" aria-hidden="true">
                <Icon name="check" size={28} />
              </span>
              <h2>No Changes</h2>
              <p>
                {version.commit ? `${shortSha(version.commit)}, ${when}` : `This version, ${when}`},
                is the same as the note is now. Pick another version to see what changed.
              </p>
            </div>
          ) : rows && items ? (
            <div
              className="note-body history-view-grid"
              data-mode={mode}
              data-wrap={wrap ? undefined : 'off'}
              style={{ '--history-gutter': gutterDigits(rows) } as CSSProperties}
              onClick={keepLinks}
            >
              <span className="history-view-divider" aria-hidden="true" />
              <SideBlocks rows={rows} items={items} side="left" label={when} images={images} />
              <SideBlocks rows={rows} items={items} side="right" label="Now" images={images} />
              {items.map((item, at) =>
                item.kind === 'fold' ? (
                  <button
                    key={item.from}
                    type="button"
                    className="history-view-fold"
                    data-ui="item"
                    data-testid="history-view-fold"
                    style={{ gridRow: at + 1 }}
                    onClick={() => openFold(item.from)}
                  >
                    {foldWords(item.lines)}
                  </button>
                ) : null,
              )}
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
