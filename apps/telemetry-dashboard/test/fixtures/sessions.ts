/**
 * Recorded sessions for Playback (PEN-178), one JSON file each, in the shape the apps send them
 * (core's events.ts and detail.ts): a Mac session after PEN-177, one from before PEN-174, an
 * Android session and a CLI run. Each file holds the fields every event shares once, and each
 * event's `at` as ms since the session's start. The player's unit tests and the dashboard's e2e
 * seed (test/e2e/server.ts) share them; replay-state.test.ts checks every event passes
 * eventProblem.
 */
import type { AnalyticsEvent } from '@penmoss/core/analytics';
import type { TimelineEvent } from '../../src/client/timeline';
import android from './android-session.json' with { type: 'json' };
import cli from './cli-session.json' with { type: 'json' };
import mac from './mac-session.json' with { type: 'json' };
import older from './older-mac-session.json' with { type: 'json' };

export interface FixtureSession {
  readonly about: string;
  readonly install: string;
  readonly session: string;
  /** How long before now it started: "-45d". */
  readonly start: string;
  /** What every event of it shares. */
  readonly client: {
    readonly client: string;
    readonly actor: string;
    readonly version: string;
    readonly channel: string;
    readonly os: string;
    readonly osVersion: string;
    readonly sizeClass?: string;
  };
  readonly events: readonly {
    readonly seq: number;
    readonly at: number;
    readonly kind: string;
    readonly name: string;
    readonly props: Readonly<Record<string, unknown>>;
  }[];
}

export const FIXTURE_SESSIONS = {
  mac: mac as FixtureSession,
  older: older as FixtureSession,
  android: android as FixtureSession,
  cli: cli as FixtureSession,
} as const;

/** When `fixture` started, for a database seeded at `now`. */
export function startOf(fixture: FixtureSession, now: number): number {
  const days = Number(/^-(\d+)d$/.exec(fixture.start)?.[1] ?? 0);
  return now - days * 86_400_000;
}

/** Its events as the app sent them, starting at `start`. */
export function analyticsEvents(fixture: FixtureSession, start = 0): AnalyticsEvent[] {
  return fixture.events.map(
    (event) =>
      ({
        session: fixture.session,
        ...fixture.client,
        seq: event.seq,
        at: start + event.at,
        kind: event.kind,
        name: event.name,
        props: event.props,
      }) as AnalyticsEvent,
  );
}

/** Its events as /api/session gives them, starting at `start`. */
export function timelineEvents(fixture: FixtureSession, start = 0): TimelineEvent[] {
  const { client, actor, version, channel, os, osVersion, sizeClass } = fixture.client;
  return fixture.events.map((event) => ({
    seq: event.seq,
    at: start + event.at,
    client,
    actor,
    version,
    channel,
    os,
    os_version: osVersion,
    size_class: sizeClass ?? null,
    kind: event.kind,
    name: event.name,
    props: event.props as TimelineEvent['props'],
  }));
}
