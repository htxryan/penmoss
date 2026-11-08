/**
 * Mermaid diagrams (T12): a code block whose language is `mermaid` (ADR
 * 0002) renders as a diagram. Mermaid loads the first time a note shows a
 * diagram. Its colours come from the app's theme tokens, read when a diagram
 * renders, and it draws again when the theme or its mode changes (T28), so
 * diagrams follow every theme; `securityLevel: 'strict'` keeps diagram text
 * from running script or links.
 */
type Mermaid = (typeof import('mermaid'))['default'];

let mermaid: Promise<Mermaid> | null = null;

export function loadMermaid(): Promise<Mermaid> {
  mermaid ??= import('mermaid').then((module) => module.default);
  // A failed chunk load (offline before it was cached) may be retried by the next diagram.
  mermaid.catch(() => (mermaid = null));
  return mermaid;
}

export const isMermaid = (language: unknown): boolean =>
  typeof language === 'string' && language.trim().toLowerCase() === 'mermaid';

/** A theme token as `rgb(…)`, which Mermaid's colour maths can read (tokens may use other syntaxes). */
function tokenColour(probe: HTMLElement, token: string, fallback: string): string {
  probe.style.color = fallback;
  probe.style.color = `var(${token}, ${fallback})`;
  return getComputedStyle(probe).color || fallback;
}

/** Mermaid's `base` theme variables, from the theme tokens in effect at `element`. */
export function mermaidThemeVariables(element: Element): Record<string, string | boolean> {
  const probe = document.createElement('span');
  probe.hidden = true;
  (element.isConnected ? element : document.body).append(probe);
  try {
    const colour = (token: string, fallback: string) => tokenColour(probe, token, fallback);
    // Without the theme (a page that never set it), the browser's own system colours.
    const bg = colour('--pm-bg', 'Canvas');
    const fg = colour('--pm-fg', 'CanvasText');
    const muted = colour('--pm-muted', 'GrayText');
    const accent = colour('--pm-accent', 'LinkText');
    const border = colour('--pm-border', 'GrayText');
    const raised = colour('--pm-raised', 'Canvas');
    const sidebar = colour('--pm-sidebar', 'Canvas');
    const note = colour('--pm-warn-bg', 'Mark');
    const dark = luminance(bg) < 0.4;
    const font = getComputedStyle(probe).getPropertyValue('--pm-font').trim();
    return {
      darkMode: dark,
      background: bg,
      fontFamily: font || 'system-ui, sans-serif',
      primaryColor: raised,
      primaryTextColor: fg,
      primaryBorderColor: accent,
      secondaryColor: sidebar,
      secondaryTextColor: fg,
      secondaryBorderColor: border,
      tertiaryColor: bg,
      tertiaryTextColor: fg,
      tertiaryBorderColor: border,
      mainBkg: raised,
      nodeBorder: accent,
      nodeTextColor: fg,
      textColor: fg,
      titleColor: fg,
      lineColor: muted,
      edgeLabelBackground: bg,
      clusterBkg: sidebar,
      clusterBorder: border,
      actorBkg: raised,
      actorBorder: accent,
      actorTextColor: fg,
      actorLineColor: muted,
      signalColor: fg,
      signalTextColor: fg,
      labelBoxBkgColor: raised,
      labelBoxBorderColor: accent,
      labelTextColor: fg,
      loopTextColor: fg,
      noteBkgColor: note,
      noteTextColor: fg,
      noteBorderColor: border,
      activationBkgColor: sidebar,
      activationBorderColor: accent,
      sequenceNumberColor: bg,
    };
  } finally {
    probe.remove();
  }
}

/** Relative luminance (0 dark … 1 light) of an `rgb(…)` colour. */
function luminance(rgb: string): number {
  const [r = 255, g = 255, b = 255] = (rgb.match(/[\d.]+/g) ?? []).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export type DiagramRender = { svg: string } | { error: string };

let renders = 0;

/** Renders `source` with the theme in effect at `element`, or explains why it cannot. */
export async function renderMermaid(source: string, element: Element): Promise<DiagramRender> {
  const instance = await loadMermaid();
  instance.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: mermaidThemeVariables(element),
    // Errors show in the block (source and message), not as Mermaid's error diagram.
    suppressErrorRendering: true,
  });
  const id = `pm-mermaid-${(renders += 1)}`;
  try {
    // With suppressErrorRendering, render throws for invalid source: no separate parse.
    const { svg } = await instance.render(id, source);
    return { svg };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.trim() || 'This diagram could not be drawn.' };
  } finally {
    // Mermaid draws in a temporary element in <body>; a failed render can leave it behind.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** How long typing must pause before an edited diagram is drawn again. */
export const DIAGRAM_DEBOUNCE_MS = 300;
/** How long theme changes must settle before diagrams are drawn again (T28). */
const THEME_REDRAW_MS = 150;

/**
 * The diagram under (or instead of) a Mermaid code block's source. It sets
 * `data-mode` (`preview`: the diagram only; `edit`: source and diagram) and
 * `data-diagram` (`pending` until scrolled near, `loading`, `rendered`,
 * `error`, `empty`) on the block; the
 * stylesheet shows the source whenever the diagram has an error, so a block
 * is never blank. The mode is view state only.
 */
export class MermaidPreview {
  readonly element: HTMLElement;
  readonly toggle: HTMLButtonElement;
  private readonly output: HTMLElement;
  private readonly message: HTMLElement;
  private source: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticket = 0;
  private destroyed = false;
  /** Whether the diagram has come near the viewport: a note's diagrams draw as they are scrolled to. */
  private visible = false;
  private observer: IntersectionObserver | null = null;
  private readonly scheme: MediaQueryList | null;
  private readonly onScheme = () => void this.draw();
  /** The page's theme (T28): its id, mode and token values on `<html>`. */
  private readonly theme: MutationObserver | null;
  private themeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: HTMLElement,
    source: string,
    private readonly onEdit: () => void,
  ) {
    this.source = source;
    this.element = document.createElement('div');
    this.element.className = 'pm-diagram';
    this.element.contentEditable = 'false';
    this.output = document.createElement('div');
    this.output.className = 'pm-diagram-output';
    this.output.title = 'Edit Diagram';
    this.output.addEventListener('click', (event) => {
      // A click edits the diagram; a link in it (`click A href …`) is never followed.
      event.preventDefault();
      if (this.host.dataset['mode'] === 'preview') this.setMode('edit');
      this.onEdit();
    });
    this.message = document.createElement('div');
    this.message.className = 'pm-diagram-error';
    this.message.setAttribute('aria-live', 'polite');
    this.element.append(this.output, this.message);

    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'pm-diagram-toggle';
    this.toggle.addEventListener('mousedown', (event) => event.preventDefault());
    this.toggle.addEventListener('click', () => {
      const editing = this.host.dataset['mode'] === 'edit';
      this.setMode(editing ? 'preview' : 'edit');
      if (!editing) this.onEdit();
    });

    this.setMode(source.trim() ? 'preview' : 'edit');
    this.scheme =
      typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    this.scheme?.addEventListener('change', this.onScheme);
    // Live edits in the theme editor change the tokens many times a second: draw once they settle.
    this.theme =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            if (this.themeTimer !== null) clearTimeout(this.themeTimer);
            this.themeTimer = setTimeout(() => {
              this.themeTimer = null;
              void this.draw();
            }, THEME_REDRAW_MS);
          })
        : null;
    this.theme?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode', 'style'],
    });
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          this.observer?.disconnect();
          this.observer = null;
          this.visible = true;
          void this.draw();
        },
        { rootMargin: '400px 0px' },
      );
      this.observer.observe(host);
    } else {
      this.visible = true;
    }
    void this.draw();
  }

  private setMode(mode: 'preview' | 'edit') {
    this.host.dataset['mode'] = mode;
    this.toggle.textContent = mode === 'edit' ? 'Preview' : 'Edit';
    this.toggle.setAttribute('aria-label', mode === 'edit' ? 'Preview Diagram' : 'Edit Diagram');
  }

  /** Shows the source (the caret is going into it). */
  showSource(): void {
    if (this.host.dataset['mode'] === 'preview') this.setMode('edit');
  }

  /** The block's text changed: draw it again once typing pauses. */
  setSource(source: string): void {
    if (source === this.source) return;
    this.source = source;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.draw();
    }, DIAGRAM_DEBOUNCE_MS);
  }

  /** Draws the current source; a newer draw supersedes an older one still in flight. */
  async draw(): Promise<void> {
    const ticket = ++this.ticket;
    const source = this.source;
    if (!source.trim()) {
      this.host.dataset['diagram'] = 'empty';
      this.output.textContent = 'Empty diagram';
      this.message.textContent = '';
      return;
    }
    if (!this.visible) {
      this.host.dataset['diagram'] = 'pending';
      if (!this.output.firstChild) this.output.textContent = 'Diagram';
      return;
    }
    this.host.dataset['diagram'] = 'loading';
    if (!this.output.firstChild || !this.output.querySelector('svg'))
      this.output.textContent = 'Drawing diagram…';
    let result: DiagramRender;
    try {
      result = await renderMermaid(source, this.host);
    } catch (error) {
      result = { error: `Could not load the diagram renderer (${String(error)})` };
    }
    if (this.destroyed || ticket !== this.ticket) return;
    if ('svg' in result) {
      this.host.dataset['diagram'] = 'rendered';
      this.output.innerHTML = result.svg;
      this.message.textContent = '';
    } else {
      this.host.dataset['diagram'] = 'error';
      this.output.replaceChildren();
      this.message.textContent = `Mermaid: ${result.error}`;
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.scheme?.removeEventListener('change', this.onScheme);
    this.theme?.disconnect();
    if (this.themeTimer !== null) clearTimeout(this.themeTimer);
    this.observer?.disconnect();
  }
}
