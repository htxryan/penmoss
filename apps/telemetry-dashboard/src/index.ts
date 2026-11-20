/**
 * Usage analytics' dashboard Worker (PEN-137) on stats.penmoss.app: Access checked on every
 * request, then the read-only API or the page (handler.ts).
 */
import { AccessVerifier } from './access';
import { handle, type DashboardEnv } from './handler';

const verifier = new AccessVerifier();

export default {
  fetch(request: Request, env: DashboardEnv, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx, { verifier, now: Date.now, cache: caches.default });
  },
} satisfies ExportedHandler<DashboardEnv>;
