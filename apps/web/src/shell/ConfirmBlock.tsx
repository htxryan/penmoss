import { useEffect, useRef, type ReactNode } from 'react';

/**
 * An inline confirmation's frame (PEN-137, A938 amended): the question in Title Case on its own
 * line, which is also the block's name (`role="alertdialog"`), above the caller's sentence and
 * buttons. Each place keeps its own look through `className`; a modal one is `ConfirmDialog`.
 * `confirm-title-case.test.ts` reads every `title` given here.
 *
 * Given `onCancel`, it asks as a destructive question does (Privacy's, CommentsPanel's Delete
 * Thread): focus moves to its Cancel (the `data-ui="dismiss"` button) as it opens, scrolled into
 * view, and Escape cancels, so nothing is deleted by a stray key.
 */
export function ConfirmBlock({
  title,
  className,
  testId,
  onCancel,
  children,
}: {
  /** The question, in Title Case: "Delete This Thread?". */
  readonly title: string;
  readonly className: string;
  readonly testId?: string;
  /** Escape cancels with this, and focus starts on Cancel. */
  readonly onCancel?: () => void;
  readonly children: ReactNode;
}) {
  const block = useRef<HTMLDivElement>(null);
  const cancels = onCancel !== undefined;
  useEffect(() => {
    if (!cancels) return;
    const cancel = block.current?.querySelector<HTMLElement>('[data-ui="dismiss"]');
    cancel?.focus({ preventScroll: true });
    cancel?.scrollIntoView?.({ block: 'nearest' });
  }, [cancels]);
  return (
    <div
      ref={block}
      className={className}
      role="alertdialog"
      aria-label={title}
      data-testid={testId}
      onKeyDown={
        onCancel
          ? (event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          : undefined
      }
    >
      <p className="confirm-block-title">{title}</p>
      {children}
    </div>
  );
}
