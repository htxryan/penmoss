/**
 * The MCP tool definitions shared by the remote server and the local one (T50, A830): what
 * `tools/list` advertises must not change by moving them. The fixture is the remote server's
 * list for a write token as it was before the move (comment tools aside, which stay there), with the
 * note id's description naming short ids since PEN-69.
 */
import { describe, expect, it } from 'vitest';
import {
  adviceFor,
  checkArguments,
  COMMENT_TOOL_NAMES,
  commentToolDefinitions,
  describeRefusal,
  toolDefinitions,
} from '../src/mcp';
import fixture from './fixtures/mcp-tool-list.json';

const SERVER = { attachmentMaxBytes: 700 * 1024 };

describe('shared MCP tool definitions', () => {
  it("list exactly as the remote server's tools/list did", () => {
    const listed = toolDefinitions(SERVER).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
    expect(JSON.stringify(listed)).toBe(JSON.stringify(fixture));
  });

  it('say what each server takes, and give the same advice', () => {
    const local = toolDefinitions({ attachmentMaxBytes: 10 * 1024 * 1024 });
    expect(local.find((tool) => tool.name === 'attach_file')!.description).toContain(
      'at most 10240 KB',
    );
    expect(adviceFor('file_too_large', SERVER)).toContain('at most 700 KB');
    expect(
      describeRefusal({ code: 'text_ambiguous', message: 'More than one match' }, SERVER),
    ).toBe(
      'More than one match (text_ambiguous).\nMake find longer so it occurs once, or set all: true to replace every occurrence.',
    );
    const create = local.find((tool) => tool.name === 'create_note')!;
    expect(checkArguments(create.inputSchema, { title: 'x', nope: 1 })).toEqual({
      problem: expect.stringContaining('unknown argument nope') as string,
    });
  });

  it("keep the remote server's comment tools apart, with its names and arguments (A1064)", () => {
    const comments = commentToolDefinitions();
    expect(comments.map((tool) => tool.name)).toEqual([...COMMENT_TOOL_NAMES]);
    expect(toolDefinitions(SERVER).some((tool) => tool.name.includes('comment'))).toBe(false);
    const args = Object.fromEntries(
      comments.map((tool) => [
        tool.name,
        [Object.keys(tool.inputSchema.properties), tool.inputSchema.required ?? []],
      ]),
    );
    expect(args).toEqual({
      list_comment_threads: [['id', 'status', 'sentToMe'], []],
      read_comment_thread: [
        ['id', 'threadId'],
        ['id', 'threadId'],
      ],
      create_comment_thread: [
        ['id', 'body', 'quote', 'occurrence'],
        ['id', 'body'],
      ],
      reply_to_comment_thread: [
        ['id', 'threadId', 'body'],
        ['id', 'threadId', 'body'],
      ],
      resolve_comment_thread: [
        ['id', 'threadId'],
        ['id', 'threadId'],
      ],
    });
    expect(comments.filter((tool) => tool.write).map((tool) => tool.name)).toEqual([
      'create_comment_thread',
      'reply_to_comment_thread',
      'resolve_comment_thread',
    ]);
    expect(adviceFor('quote_not_found', SERVER)).toContain('read_note');
  });
});
