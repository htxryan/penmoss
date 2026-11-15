/**
 * The fonts at their real size (A1582), beside Settings' shrunk previews: each role's sample in
 * the app's own classes and tokens, so it is exactly the text the app draws, and labelled with
 * the role, the family it asks for and its size, read back from the page as drawn. The interface
 * samples use the type roles (shell/type.css); the note's sit in the note's own `.note-body
 * .ProseMirror` and `.doc-title`, so the Note Font and Note Font Size set them as they set a
 * note. `style` lays the same variables over it as over the preview (a size being dragged, or
 * the theme editor's variant). The labels follow every change to `<html>`'s style or theme.
 * The samples are hidden from screen readers (a note's headings are not the page's); their
 * labels are read.
 */
import { useId, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { fontLabel } from './specimen-label';

interface Sample {
  readonly role: string;
  readonly text: string;
}

const NOTE: readonly (Sample & { readonly tag: 'title' | 'h1' | 'h2' | 'h3' | 'p' | 'code' })[] = [
  { role: 'Title', tag: 'title', text: 'Garden Plan' },
  { role: 'Heading 1', tag: 'h1', text: 'Raised Beds' },
  { role: 'Heading 2', tag: 'h2', text: 'By the Fence' },
  { role: 'Heading 3', tag: 'h3', text: 'Next Year' },
  { role: 'Text', tag: 'p', text: 'Tomatoes and basil, watered in the morning.' },
  { role: 'Code', tag: 'code', text: 'plant("tomato")' },
];

const INTERFACE: readonly (Sample & { readonly className: string })[] = [
  { role: 'Page Title', className: 't-page-title', text: 'Appearance' },
  { role: 'Sidebar', className: 'type-specimen-sidebar', text: 'Reading List' },
  { role: 'Setting', className: 't-row-label', text: 'Note Font Size' },
  { role: 'Body', className: 't-body', text: 'The notebooks on this Mac.' },
  { role: 'Help', className: 't-help', text: 'Syncs to your other devices.' },
];

export function TypeSpecimen({
  style,
  note = true,
  interfaceText = true,
  testId = 'type-specimen',
}: {
  readonly style?: CSSProperties | undefined;
  /** The note's text: its title, headings, text and code. */
  readonly note?: boolean;
  /** The interface's text: the type roles. */
  readonly interfaceText?: boolean;
  readonly testId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  // Each label reads its sample as drawn: after every render, and whenever <html>'s style (the
  // fonts and size) or theme changes, or a font finishes loading.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const label = () => {
      for (const sample of element.querySelectorAll<HTMLElement>('[data-specimen]')) {
        const target = sample.querySelector<HTMLElement>('[data-specimen-text]');
        const out = sample.querySelector<HTMLElement>('[data-specimen-label]');
        if (!target || !out) continue;
        const drawn = getComputedStyle(target);
        const text = fontLabel(sample.dataset['specimen'] ?? '', drawn.fontFamily, drawn.fontSize);
        if (out.textContent !== text) out.textContent = text;
        sample.dataset['size'] = drawn.fontSize;
      }
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme', 'data-mode'],
    });
    const fonts = document.fonts as FontFaceSet | undefined;
    fonts?.addEventListener('loadingdone', label);
    return () => {
      observer.disconnect();
      fonts?.removeEventListener('loadingdone', label);
    };
  });
  return (
    <>
      <p className="lf-label" id={`${id}-label`}>
        Fonts at Real Size
      </p>
      <div
        ref={root}
        className="type-specimen"
        style={style}
        data-testid={testId}
        role="group"
        aria-labelledby={`${id}-label`}
      >
        {interfaceText ? (
          <div className="type-specimen-group">
            <p className="lf-label">Interface</p>
            {INTERFACE.map((sample) => (
              <div key={sample.role} className="type-specimen-row" data-specimen={sample.role}>
                <span className={sample.className} data-specimen-text aria-hidden="true">
                  {sample.text}
                </span>
                <span className="t-meta" data-specimen-label />
              </div>
            ))}
          </div>
        ) : null}
        {note ? (
          <div className="type-specimen-group">
            <p className="lf-label">Note</p>
            <div className="note-body type-specimen-note">
              {NOTE.filter((sample) => sample.tag === 'title').map((sample) => (
                <div key={sample.role} className="type-specimen-row" data-specimen={sample.role}>
                  <span className="doc-title" data-specimen-text aria-hidden="true">
                    {sample.text}
                  </span>
                  <span className="t-meta" data-specimen-label />
                </div>
              ))}
              <div className="ProseMirror">
                {NOTE.filter((sample) => sample.tag !== 'title').map((sample) => (
                  <div key={sample.role} className="type-specimen-row" data-specimen={sample.role}>
                    {sample.tag === 'code' ? (
                      <p>
                        <code data-specimen-text aria-hidden="true">
                          {sample.text}
                        </code>
                      </p>
                    ) : sample.tag === 'h1' ? (
                      <h1 data-specimen-text aria-hidden="true">
                        {sample.text}
                      </h1>
                    ) : sample.tag === 'h2' ? (
                      <h2 data-specimen-text aria-hidden="true">
                        {sample.text}
                      </h2>
                    ) : sample.tag === 'h3' ? (
                      <h3 data-specimen-text aria-hidden="true">
                        {sample.text}
                      </h3>
                    ) : (
                      <p data-specimen-text aria-hidden="true">
                        {sample.text}
                      </p>
                    )}
                    <span className="t-meta" data-specimen-label />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
