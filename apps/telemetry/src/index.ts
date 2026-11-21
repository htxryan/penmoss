/**
 * Usage analytics' ingest Worker (PEN-137) on t.penmoss.app: shared batches in, forgets, and the
 * nightly rollup and prune. Reading the data is the dashboard's (apps/telemetry-dashboard), behind
 * Cloudflare Access; this Worker has no route that returns an event.
 */
import { handle, type TelemetryEnv } from './ingest';
import { nightly } from './nightly';

export default {
  fetch(request: Request, env: TelemetryEnv): Promise<Response> {
    return handle(request, env, Date.now());
  },
  async scheduled(controller: ScheduledController, env: TelemetryEnv): Promise<void> {
    const report = await nightly(env.DB, controller.scheduledTime);
    console.log(
      `nightly: rolled ${report.rolled.length} days, pruned ${report.prunedDetail} session ` +
        `detail events (${report.prunedForSize} for size), ${report.prunedEvents} events and ` +
        `${report.prunedRollups} rollup rows, catalogue ${report.catalogue} names`,
    );
  },
} satisfies ExportedHandler<TelemetryEnv>;
