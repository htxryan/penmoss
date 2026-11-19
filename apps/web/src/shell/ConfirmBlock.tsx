import type { ReactNode } from 'react';

/**
 * An inline confirmation's frame (PEN-137, A938 amended): the question in Title Case on its own
 * line, which is also the block's name (`role="alertdialog"`), above the caller's sentence and
 * buttons. Each place keeps its own look through `className`; a modal one is `ConfirmDialog`.
 * `confirm-title-case.test.ts` reads every `title` given here.
 */
export function ConfirmBlock({
  title,
  className,
  testId,
  children,
}: {
  /** The question, in Title Case: "Delete This Thread?". */
  readonly title: string;
  readonly className: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={className} role="alertdialog" aria-label={title} data-testid={testId}>
      <p className="confirm-block-title">{title}</p>
      {children}
    </div>
  );
}
