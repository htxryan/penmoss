/// <reference types="node" />
/**
 * The bytes of a daily or weekly note built from its template (T40 P5): the
 * Android editor page builds them with `@penmoss/editor`'s `periodicNote`,
 * exactly as the web does, so two devices creating the same period's note
 * offline write byte-identical updates and merge to one note with one copy
 * of the template (A4). `apps/android/contract/periodic-fixture.json` pins
 * those bytes for a daily and a weekly note, a DST day, the ISO year edges
 * and a template with every placeholder; the web's `periodic.test.ts` reads
 * the same file, so the two suites cannot drift. Kotlin never builds these
 * bytes (A11): it stores the page's answer and uploads it.
 *
 * After changing the template defaults, the placeholders or the note codec,
 * write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/android-editor test periodic-fixture`.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as core from '@penmoss/core';
import {
  DEFAULT_DAILY_TEMPLATE,
  DEFAULT_WEEKLY_TEMPLATE,
  type PeriodKind,
} from '@penmoss/core/periodic';
import { toBase64 } from 'lib0/buffer';
import { describe, expect, it } from 'vitest';
import { periodicNote } from '@penmoss/editor/periodic';
import fixture from '../../contract/periodic-fixture.json';

interface FixtureCase {
  readonly kind: PeriodKind;
  readonly period: string;
  readonly template: string;
  readonly id: string;
  readonly body: string;
  readonly update: string;
}

const contract = fixture as unknown as { readonly version: 1; readonly cases: FixtureCase[] };

/** A daily and a weekly note, a DST day, the ISO year edges, every placeholder. */
function fixtureCases(): Array<{ kind: PeriodKind; period: string; template: string }> {
  return [
    { kind: 'daily', period: '2026-10-21', template: DEFAULT_DAILY_TEMPLATE },
    {
      kind: 'daily',
      period: '2026-03-08',
      template: '# {{date}}\n\n{{longDate}}\n\n{{weekday}} of {{week}}, {{month}} {{year}}\n',
    },
    {
      kind: 'daily',
      period: '2021-01-01',
      template: '# {{date}} (week {{week}})\n\n{{longDate}}\n',
    },
    { kind: 'weekly', period: '2026-W43', template: DEFAULT_WEEKLY_TEMPLATE },
    {
      kind: 'weekly',
      period: '2020-W53',
      template: '# Week {{week}}\n\n{{longDate}}\n\n{{month}}/{{year}} {{unknown}} {{ date }}\n',
    },
  ];
}

const WRITE = process.env.PENMOSS_WRITE_CONTRACTS === '1';

describe('periodic note bytes (T40 P5)', () => {
  it('pins the bytes every app builds for the same period and template', () => {
    const cases: FixtureCase[] = fixtureCases().map(({ kind, period, template }) => {
      const note = periodicNote(core, kind, period, template);
      return {
        kind,
        period,
        template,
        id: note.id,
        body: note.body,
        update: toBase64(note.update),
      };
    });
    if (WRITE) {
      writeFileSync(
        resolve(process.cwd(), '../contract/periodic-fixture.json'),
        `${JSON.stringify({ version: 1, cases }, null, 2)}\n`,
      );
    }
    expect(contract.version).toBe(1);
    expect(contract.cases).toEqual(cases);
  });

  it('builds the same bytes twice, and merges two offline builds to one note', () => {
    const first = periodicNote(core, 'daily', '2026-10-21', DEFAULT_DAILY_TEMPLATE);
    const second = periodicNote(core, 'daily', '2026-10-21', DEFAULT_DAILY_TEMPLATE);
    expect(toBase64(second.update)).toBe(toBase64(first.update));
    expect(second.id).toBe(first.id);
  });
});
