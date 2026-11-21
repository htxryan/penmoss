/**
 * Analytics Data's entry in Settings' nav (PEN-137, ac36): right after Privacy, flush with the
 * other entries, its icon in their column as a notebook's is (Ryan, 21 Nov 2026).
 * `aria-current="page"` while it is open.
 */
import { Icon } from '@penmoss/ui/icons';
import { PRIVACY_DATA_ICON } from '../pages/settings-index';
import { linkHandler, PRIVACY_DATA_PATH } from '../router';
import { copy } from './status';
import './privacy.css';

export function PrivacyNavEntry({ current }: { readonly current: boolean }) {
  const label = copy('viewer.title');
  return (
    <a
      href={PRIVACY_DATA_PATH}
      className="privacy-nav-entry"
      data-ui="item"
      data-event="privacy.view-data"
      data-testid="settings-privacy-data-entry"
      aria-current={current ? 'page' : undefined}
      onClick={linkHandler(PRIVACY_DATA_PATH)}
    >
      <Icon name={PRIVACY_DATA_ICON} />
      {/* As wide as its bold self, as the other entries are (A988). */}
      <span className="bold-steady" data-label={label}>
        {label}
      </span>
    </a>
  );
}
