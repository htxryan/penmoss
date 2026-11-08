import { useId, type ReactNode } from 'react';
import { useStoredCollapse } from '../shell/collapsed';
import { useOnRevealNotebooks } from '../shell/reveal-notebooks';
import { SectionHead } from '../shell/SectionHead';

/** Whether Notebooks is collapsed on this device (T53 item 8). */
export const NOTEBOOKS_COLLAPSED_KEY = 'penmoss.sidebar.notebooks';

/**
 * Notebooks (T53 item 8, A983): a title over the notebooks, each with its own row (the personal
 * notes alone, or every source side by side, or a tag's notes), so the group can be collapsed,
 * hidden and moved like the sidebar's other sections. Collapsed or open on this device; hidden
 * or collapsed, it stays mounted (A983).
 */
export function NotebooksSection({
  tools,
  children,
}: {
  /** The section's drag handle and ✕. */
  readonly tools?: ReactNode;
  readonly children: ReactNode;
}) {
  const [collapsed, toggle] = useStoredCollapse(NOTEBOOKS_COLLAPSED_KEY);
  useOnRevealNotebooks(() => {
    if (collapsed) toggle();
  });
  const id = useId();
  return (
    <section
      className="sb-notebooks"
      aria-labelledby={`${id}-name`}
      data-testid="notebooks"
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <SectionHead
        name="Notebooks"
        nameId={`${id}-name`}
        collapsed={collapsed}
        onToggle={toggle}
        controls={`${id}-body`}
        tools={tools}
      />
      {/* Mounted while collapsed: the tree registers New Folder, New Notebook and the sort
          commands, which work from the palette and their keys whatever the sidebar shows. */}
      <div id={`${id}-body`} className="sb-notebooks-body" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
