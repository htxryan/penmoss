/**
 * The bridge contract (T32, A282): every example message in
 * apps/android/contract/bridge-v1.json is one the page reads (to the editor)
 * or writes (from the editor), and the malformed ones are refused. The Kotlin
 * BridgeProtocolTest reads the same file, so the two sides cannot drift.
 */
import { normaliseTag } from '@penmoss/core/tags';
import { afterEach, describe, expect, it } from 'vitest';
import bridge from '../../contract/bridge-v1.json';
import tagFixture from '../../contract/tags-v1.json';
import { EditorHost } from '../src/host';
import {
  encodeFromEditor,
  FORMAT_COMMANDS,
  MAX_TAG_CHARS,
  parseToEditor,
  type FromEditor,
} from '../src/protocol';

const contract = bridge as unknown as {
  formatCommands: string[];
  toEditor: unknown[];
  fromEditor: FromEditor[];
  invalidToEditor: string[];
  invalidFromEditor: string[];
};

const tags = tagFixture as unknown as {
  maxChars: number;
  normalise: { raw: string; tag: string | null }[];
};

const hosts: EditorHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

describe('bridge contract v1', () => {
  it('names the formatting bar’s commands as the app does (A301)', () => {
    expect([...FORMAT_COMMANDS]).toEqual(contract.formatCommands);
  });

  it('reads every message the app may send', () => {
    for (const message of contract.toEditor) {
      expect(parseToEditor(JSON.stringify(message))).toEqual(message);
    }
  });

  it('refuses malformed messages and other versions', () => {
    for (const raw of contract.invalidToEditor) expect(parseToEditor(raw)).toBeNull();
  });

  it('writes messages in the shapes the app reads', () => {
    for (const message of contract.fromEditor) {
      expect(JSON.parse(encodeFromEditor(message))).toEqual(message);
    }
  });

  it('answers the example open with messages of the contract types only', () => {
    const root = document.createElement('main');
    const title = document.createElement('input');
    const body = document.createElement('div');
    const unsupported = document.createElement('pre');
    root.append(title, body, unsupported);
    document.body.append(root);
    const sent: FromEditor[] = [];
    const host = new EditorHost({ root, title, body, unsupported }, (message) =>
      sent.push(message),
    );
    hosts.push(host);
    host.start();
    for (const message of contract.toEditor) host.receive(JSON.stringify(message));
    const types = new Set(contract.fromEditor.map((message) => message.type));
    expect(sent.length).toBeGreaterThan(1);
    for (const message of sent) {
      expect(types).toContain(message.type);
      expect(message.v).toBe(1);
    }
    expect(sent.find((message) => message.type === 'opened')).toMatchObject({
      compacted: { replaces: ['11', '12'] },
      compactedPending: { replaces: ['13', '14'] },
    });
    // Nothing it sent is one of the messages the app refuses (T38 review).
    const refused = new Set(
      contract.invalidFromEditor.map((raw) => JSON.stringify(JSON.parse(raw))),
    );
    for (const message of sent) expect(refused.has(encodeFromEditor(message))).toBe(false);
  });

  it('names a message type the page sends, or another version, in each refused example', () => {
    const types = new Set(contract.fromEditor.map((message) => message.type));
    for (const raw of contract.invalidFromEditor) {
      const message = JSON.parse(raw) as { v: number; type: string };
      expect(message.v !== 1 || types.has(message.type as FromEditor['type'])).toBe(true);
    }
  });
});

describe('tag names (T38, A361)', () => {
  it('normalises every case as the app checks them, with the shared rules', () => {
    for (const { raw, tag } of tags.normalise) expect(normaliseTag(raw), raw).toBe(tag);
  });

  it('sends tags of the same greatest length as the app', () => {
    expect(MAX_TAG_CHARS).toBe(tags.maxChars);
    const longest = 'x'.repeat(MAX_TAG_CHARS);
    const message = { v: 1, type: 'setTag', noteId: 'n1', tag: longest, on: false };
    expect(parseToEditor(JSON.stringify(message))).toEqual(message);
  });
});
