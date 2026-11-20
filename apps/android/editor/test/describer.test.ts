/**
 * AI Descriptions in the Android engine page (PEN-161 T6): which notes are described (the note,
 * its folders, the notebook, then Describe Notes), after the pause, only for text not yet
 * described, never over a hand-written one, nothing without a provider, and a failure tried
 * again at the next sync.
 */
import { parseMarkdown } from '@penmoss/core';
import { HAND_WRITTEN } from '@penmoss/core/ai-description';
import {
  readDescription,
  readDescriptionOf,
  setAiSetting,
  setHandDescription,
} from '@penmoss/model/description';
import { setBody } from '@penmoss/model/history';
import { initNote } from '@penmoss/model/note';
import {
  createFolder,
  registerNote,
  setFolderAiDescription,
  writeSetting,
} from '@penmoss/model/workspace';
import { docToDelta } from '@y/prosemirror';
import * as Y from '@y/y';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotebookDescriber,
  parseAiAnswer,
  parseAiConfig,
  type AiAnswer,
  type AiConfig,
} from '../src/git/describer';

const NOTE = '01JBNOTE000000000000000001';
const OTHER = '01JBNOTE000000000000000002';
const FOLDER = '01JBF0000000000000000000B1';

function setup(config: Partial<AiConfig> = {}, answer: AiAnswer = { ok: true, text: 'About it.' }) {
  const workspace = new Y.Doc();
  const docs = new Map<string, Y.Doc>();
  const note = (id: string, markdown: string, folderId: string | null = null) => {
    const doc = new Y.Doc();
    initNote(
      doc,
      { id, created: '2026-11-19T10:00:00-06:00', kind: 'note' },
      `Note ${id.slice(-1)}`,
    );
    setBody(doc, docToDelta(parseMarkdown(markdown).doc));
    docs.set(id, doc);
    registerNote(workspace, { id, folderId });
    return doc;
  };
  const prompts: string[] = [];
  let reply = answer;
  const describer = new NotebookDescriber(
    {
      note: (id) => docs.get(id),
      workspace,
      write: (change) => {
        change();
        return Promise.resolve();
      },
      name: 'Personal',
    },
    {
      config: () =>
        Promise.resolve({
          ready: true,
          global: true,
          when: 'pause',
          pauseS: 120,
          prompt: 'Describe {{title}} in {{folder}}: {{body}}',
          ...config,
        }),
      describe: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(reply);
      },
    },
    () => Date.UTC(2026, 10, 19, 16),
  );
  return {
    workspace,
    note,
    describer,
    prompts,
    answer: (next: AiAnswer) => {
      reply = next;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the Android describer', () => {
  it('describes a changed note after the pause, once for each text', async () => {
    vi.useFakeTimers();
    const { note, describer, prompts } = setup();
    const doc = note(NOTE, 'Milk and eggs.');
    describer.changed([NOTE]);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(prompts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prompts).toEqual(['Describe Note 1 in the top level: Milk and eggs.\n']);
    expect(readDescription(doc)).toBe('About it.');
    // Its own write changes nothing it describes: no second call.
    describer.changed([NOTE]);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(prompts).toHaveLength(1);
    describer.stop();
  });

  it('follows the note, its folders and the notebook before Describe Notes', async () => {
    const { workspace, note, describer, prompts } = setup({ global: false });
    createFolder(workspace, { id: FOLDER, name: 'Work', parentId: null });
    const inFolder = note(NOTE, 'Plans.', FOLDER);
    const top = note(OTHER, 'Loose.');
    expect(await describer.describe(NOTE)).toBe(false);
    setFolderAiDescription(workspace, FOLDER, 'on');
    expect(await describer.describe(NOTE)).toBe(true);
    expect(prompts[0]).toContain('in Work');
    expect(readDescription(inFolder)).toBe('About it.');
    writeSetting(workspace, 'ai.description', 'on');
    setAiSetting(top, 'off');
    expect(await describer.describe(OTHER)).toBe(false);
    setAiSetting(top, 'inherit');
    expect(await describer.describe(OTHER)).toBe(true);
  });

  it('never writes over a hand-written description, and sends nothing without a provider', async () => {
    const { note, describer, prompts } = setup();
    const doc = note(NOTE, 'Text.');
    setHandDescription(doc, 'Mine.');
    expect(await describer.describe(NOTE)).toBe(false);
    expect(readDescriptionOf(doc)).toBe(HAND_WRITTEN);
    const none = setup({ ready: false });
    none.note(OTHER, 'Text.');
    expect(await none.describer.describe(OTHER)).toBe(false);
    expect([...prompts, ...none.prompts]).toEqual([]);
  });

  it('tries a failed note again at the next sync', async () => {
    const { note, describer, prompts, answer } = setup(
      {},
      { ok: false, code: 'offline', message: 'No network.' },
    );
    const doc = note(NOTE, 'Text.');
    expect(await describer.describe(NOTE)).toBe(false);
    answer({ ok: true, text: 'Back online.' });
    describer.synced();
    await vi.waitFor(() => expect(readDescription(doc)).toBe('Back online.'));
    expect(prompts).toHaveLength(2);
  });

  it('describes at sync when set to At Sync', async () => {
    const { note, describer } = setup({ when: 'sync' });
    const doc = note(NOTE, 'Text.');
    describer.changed([NOTE]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readDescription(doc)).toBeNull();
    describer.synced();
    await vi.waitFor(() => expect(readDescription(doc)).toBe('About it.'));
  });

  it('reads what the app answers', () => {
    expect(
      parseAiConfig({ ready: true, global: true, when: 'sync', pauseS: 30, prompt: '' }),
    ).toEqual(expect.objectContaining({ ready: true, global: true, when: 'sync', pauseS: 30 }));
    expect(parseAiConfig({ ready: true, pauseS: 'soon' })?.pauseS).toBe(120);
    expect(parseAiConfig('nope')).toBeNull();
    expect(parseAiAnswer({ ok: true, text: 'Hi.' })).toEqual({ ok: true, text: 'Hi.' });
    expect(parseAiAnswer({ ok: false, code: 'refused', message: 'No.' })).toEqual({
      ok: false,
      code: 'refused',
      message: 'No.',
    });
    expect(parseAiAnswer(null)).toMatchObject({ ok: false, code: 'failed' });
  });
});
