import { Icon } from '@penmoss/ui/icons';
import type { ReactNode } from 'react';

/**
 * A sidebar section's title row (T53 item 8, A988): the toggle, with the sections' chevron and
 * the section's name, and the section's tools (a drag handle and ✕) laid over the row's end.
 * Quick Access, Recent Notes, Notebooks, Calendar and Tags all draw it, so their chevrons and
 * names line up and every row is the same height, its tools shown or not.
 */
export function SectionHead({
  name,
  nameId,
  collapsed,
  onToggle,
  controls,
  tools,
  hint,
  testId,
}: {
  readonly name: string;
  /** The name's id, which labels the section. */
  readonly nameId: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /** The id of what the toggle shows and hides; none while the section has nothing to show. */
  readonly controls: string | undefined;
  readonly tools?: ReactNode;
  /** Quiet words at the row's end, under the tools: an empty section's (A989). */
  readonly hint?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <header className="sb-section-head sb-part-head">
      {/* A heading, so a screen reader moves between the sections by their names. */}
      <h2 className="sb-section-title">
        <button
          type="button"
          className="sb-section-toggle"
          data-ui="item"
          aria-expanded={!collapsed}
          aria-controls={controls}
          data-testid={testId}
          onClick={onToggle}
        >
          <Icon name={collapsed ? 'chevR' : 'chevD'} size={12} />
          <span id={nameId} className="sb-section-name">
            {name}
          </span>
        </button>
      </h2>
      {hint}
      {tools}
    </header>
  );
}
