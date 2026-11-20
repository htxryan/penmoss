/**
 * Screens by kind (PEN-137): each time the route on show becomes another kind of screen, one
 * `screen` event names the kind (`note`, `settings.privacy`), never the route or an id, with
 * the kind before it.
 */
import { useEffect } from 'react';
import type { Route } from '../router';
import { recordScreen, screenKindOf } from './track';

export function useScreenTracking(route: Route): void {
  const kind = screenKindOf(route);
  useEffect(() => recordScreen(kind), [kind]);
}
