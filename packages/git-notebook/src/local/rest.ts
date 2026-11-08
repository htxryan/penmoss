/**
 * The REST API's routes, answered on this device (T50 G2): a `fetch` the CLI's `Api` client
 * calls instead of the network when a command runs with `--notebook`. The CLI's commands are
 * unchanged: they ask `/api/...` and read the server's shapes and error codes, and this answers
 * them from a `LocalNotebook`. Nothing leaves the process.
 */
import type { EditOp, SectionMode } from '@penmoss/editor/edit-engine';
import type { SortMode } from '@penmoss/core/workspace';
import { LocalError, propertiesOp, type LocalNotebook } from './notebook';

/** What the CLI's `FetchLike` gives (Node's and workerd's fetch both fit). */
export interface LocalRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface LocalResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The origin `--notebook` commands use: never a host, so nothing can reach the network. */
export const LOCAL_ORIGIN = 'http://notebook.invalid';

type Body = Record<string, unknown>;

const NOTE_ACTION = /^\/api\/notes\/([^/]+)(?:\/([a-z]+))?$/;
const FOLDER = /^\/api\/folders\/([^/]+)$/;
const ACTIVITY_UNDO = /^\/api\/agent-activity\/([0-9]+)\/undo$/;
const VERSIONS = /^\/api\/notes\/([^/]+)\/versions(?:\/([^/]+)(?:\/(restore|revert))?)?$/;
const MODES: readonly SectionMode[] = ['replace', 'prepend', 'append'];
const SORTS: readonly SortMode[] = ['manual', 'alpha', 'modified'];

const json = (status: number, body: unknown): LocalResponse => {
  const text = JSON.stringify(body);
  return { status, headers: { get: () => null }, text: () => Promise.resolve(text) };
};

const bad = (message: string) => new LocalError(400, 'invalid_request', message);

function str(body: Body, key: string, required = true): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw bad(`${key} must be text`);
  return value;
}

function base(body: Body, required: boolean): number | null {
  const value = body['baseVersion'];
  if (value === undefined || value === null) {
    if (required) {
      throw new LocalError(
        428,
        'base_required',
        'baseVersion is required: read the note first and pass the baseVersion it returns',
      );
    }
    return null;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw bad('baseVersion must be a version');
  return value as number;
}

function tags(body: Body, key: string): string[] {
  const value = body[key] ?? [];
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) {
    throw bad(`${key} must be a list of tags`);
  }
  return value;
}

/**
 * A `fetch` over `notebook`. `changed` is told after every request that may have changed the
 * notebook (any method but GET), so the caller saves and syncs.
 */
export function localFetch(
  notebook: LocalNotebook,
  /** After every request that may write, awaited before its reply: the CLI saves there. */
  changed: () => void | Promise<void> = () => undefined,
): (url: string, init: LocalRequestInit) => Promise<LocalResponse> {
  return async (url, init) => {
    const method = init.method.toUpperCase();
    try {
      let body: Body = {};
      if (init.body !== undefined && init.body !== '') {
        const parsed: unknown = JSON.parse(init.body);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw bad('The request body must be a JSON object');
        }
        body = parsed as Body;
      }
      const target = new URL(url, LOCAL_ORIGIN);
      const reply = await route(notebook, method, target, body, init.headers);
      if (method !== 'GET') await changed();
      return json(reply.status, reply.body);
    } catch (error) {
      if (error instanceof LocalError) {
        if (method !== 'GET') await changed();
        return json(error.status, {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
      }
      if (error instanceof SyntaxError) {
        return json(400, { error: { code: 'invalid_request', message: 'The body is not JSON' } });
      }
      throw error;
    }
  };
}

async function route(
  notebook: LocalNotebook,
  method: string,
  url: URL,
  body: Body,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const path = url.pathname;
  const query = url.searchParams;
  const ok = (data: unknown, status = 200) => ({ status, body: data });

  if (path === '/api/notes' && method === 'GET') {
    const limit = query.has('limit') ? Number(query.get('limit')) : 20;
    return ok(
      notebook.listNotes({
        ...(query.has('title') ? { title: query.get('title')! } : {}),
        limit: Number.isFinite(limit) ? limit : 20,
      }),
    );
  }
  if (path === '/api/notes' && method === 'POST') {
    const key =
      Object.entries(headers).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1] ??
      null;
    const folderId = body['folderId'];
    if (folderId !== undefined && folderId !== null && typeof folderId !== 'string') {
      throw bad('folderId must be a folder id or null');
    }
    const made = notebook.create(
      {
        title: str(body, 'title', false),
        markdown: str(body, 'markdown', false) ?? '',
        tags: tags(body, 'tags'),
        folderId: folderId ?? null,
      },
      key,
      key ? 24 * 60 * 60_000 : null,
    );
    return ok(made.reply, made.status);
  }
  const versions = VERSIONS.exec(path);
  if (versions) {
    // History (G6, A831): the commits that touched the note's logs.
    const id = decodeURIComponent(versions[1]!);
    const version = versions[2] === undefined ? null : Number(versions[2]);
    if (version !== null && !(Number.isSafeInteger(version) && version > 0)) {
      throw bad('Invalid version id');
    }
    const action = versions[3];
    if (version === null && method === 'GET') return ok(await notebook.versions(id));
    if (version === null && method === 'POST') {
      // The server answers with the version itself (MCP's save_version wraps it).
      const done = await notebook.saveVersion(id);
      if (!done.version) throw new LocalError(404, 'not_found', 'Nothing committed yet');
      return ok(done.version, done.saved ? 201 : 200);
    }
    if (version !== null && action === undefined && method === 'GET') {
      return ok(await notebook.versionDetail(id, version));
    }
    if (version !== null && action === 'restore' && method === 'POST') {
      const { changed } = await notebook.restoreVersion(id, version);
      return ok({ version: null, changed });
    }
    if (version !== null && action === 'revert' && method === 'POST') {
      const { changed, conflicts } = await notebook.revertVersion(id, version);
      return ok({ version: null, changed, conflicts });
    }
    throw new LocalError(405, 'method_not_allowed', `${method} ${path}`);
  }
  const note = NOTE_ACTION.exec(path);
  if (note) {
    const id = decodeURIComponent(note[1]!);
    const action = note[2];
    if (action === 'content' && method === 'GET') return ok(notebook.content(id));
    // set_properties and `penmoss set-title` (#170 F10), as the server's PATCH.
    if (action === 'properties' && method === 'PATCH') {
      return ok(
        notebook.edit(
          id,
          propertiesOp({ title: body['title'], tags: body['tags'] }),
          base(body, false),
        ),
      );
    }
    if (method !== 'POST') throw new LocalError(405, 'method_not_allowed', `${method} ${path}`);
    switch (action) {
      case 'append': {
        const heading = str(body, 'heading', false);
        const op: EditOp = {
          op: 'append',
          markdown: str(body, 'markdown')!,
          ...(heading !== undefined ? { heading } : {}),
        };
        return ok(notebook.edit(id, op, base(body, false)));
      }
      case 'section': {
        const mode = (body['mode'] ?? 'replace') as SectionMode;
        if (!MODES.includes(mode)) throw bad('mode must be replace, prepend or append');
        const op: EditOp = {
          op: 'section',
          heading: str(body, 'heading')!,
          markdown: str(body, 'markdown')!,
          mode,
        };
        return ok(notebook.edit(id, op, base(body, true)));
      }
      case 'replace': {
        const scope = (body['scope'] ?? 'text') as 'text' | 'markdown';
        if (scope !== 'text' && scope !== 'markdown') throw bad('scope must be text or markdown');
        const op: EditOp = {
          op: 'replace',
          find: str(body, 'find')!,
          replace: str(body, 'replace')!,
          all: body['all'] === true,
          scope,
        };
        if (!op.find) throw bad('find must not be empty');
        return ok(notebook.edit(id, op, base(body, true)));
      }
      case 'tags':
        return ok(
          notebook.edit(
            id,
            { op: 'tag', add: tags(body, 'add'), remove: tags(body, 'remove') },
            base(body, false),
          ),
        );
      case 'move': {
        const folderId = body['folderId'];
        if (folderId !== null && typeof folderId !== 'string')
          throw bad('folderId must be a folder id or null');
        return ok(notebook.move(id, folderId));
      }
      case 'trash':
        return ok(notebook.trash(id));
      case 'restore':
        return ok(notebook.restore(id));
      case 'attachments':
        return ok(
          await notebook.attach({
            id,
            name: str(body, 'name')!,
            data: str(body, 'data')!,
            ...(typeof body['alt'] === 'string' ? { alt: body['alt'] } : {}),
            ...(typeof body['heading'] === 'string' ? { heading: body['heading'] } : {}),
          }),
        );
      default:
        break;
    }
  }
  if (path === '/api/daily' && method === 'POST') {
    const period = body['period'] ?? 'daily';
    if (period !== 'daily' && period !== 'weekly') throw bad('period must be daily or weekly');
    return ok(
      notebook.daily({
        period,
        ...(typeof body['date'] === 'string' ? { date: body['date'] } : {}),
      }),
    );
  }
  if (path === '/api/search' && method === 'GET') {
    const number = (name: string) => (query.has(name) ? Number(query.get(name)) : null);
    return ok(
      await notebook.search({
        q: query.get('q') ?? '',
        mode: query.get('mode') ?? 'hybrid',
        limit: number('limit') ?? 10,
        tag: query.get('tag'),
        folderId: query.get('folder'),
        after: number('after'),
        before: number('before'),
      }),
    );
  }
  if (path === '/api/tags' && method === 'GET') {
    return ok(query.has('tag') ? notebook.tagged(query.get('tag')!) : notebook.tags());
  }
  if (path === '/api/tags/rename' && method === 'POST') {
    return ok(
      notebook.renameTag({
        from: str(body, 'from')!,
        to: str(body, 'to')!,
        merge: body['merge'] === true,
      }),
      202,
    );
  }
  if (path === '/api/folders' && method === 'GET') {
    return ok(
      notebook.listFolder({
        ...(query.has('folderId') ? { folderId: query.get('folderId')! } : {}),
        ...(query.has('path') ? { path: query.get('path')! } : {}),
      }),
    );
  }
  if (path === '/api/folders' && method === 'POST') {
    const parentId = body['parentId'] ?? null;
    if (parentId !== null && typeof parentId !== 'string')
      throw bad('parentId must be a folder id or null');
    const made = notebook.createFolder({
      id: str(body, 'id')!,
      name: str(body, 'name')!,
      parentId,
      reuseName: body['reuseName'] === true,
    });
    return ok(made.folder, made.status);
  }
  if (path === '/api/folders/root' && method === 'PATCH') {
    const sortMode = body['sortMode'] as SortMode;
    if (!SORTS.includes(sortMode)) throw bad('sortMode must be manual, alpha or modified');
    return ok(notebook.patchRoot(sortMode));
  }
  const folder = FOLDER.exec(path);
  if (folder && method === 'PATCH') {
    const id = decodeURIComponent(folder[1]!);
    const from = (
      typeof body['from'] === 'object' && body['from'] !== null ? body['from'] : {}
    ) as Body;
    const sortMode = body['sortMode'] as SortMode | undefined;
    if (sortMode !== undefined && !SORTS.includes(sortMode))
      throw bad('sortMode must be manual, alpha or modified');
    return ok(
      notebook.patchFolder(id, {
        ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
        ...(typeof from['name'] === 'string' ? { expectedName: from['name'] } : {}),
        ...('parentId' in body
          ? { changeParent: true, parentId: (body['parentId'] as string | null) ?? null }
          : {}),
        ...('parentId' in from
          ? { expectParent: true, expectedParentId: (from['parentId'] as string | null) ?? null }
          : {}),
        ...(sortMode !== undefined ? { sortMode } : {}),
      }),
    );
  }
  if (folder && method === 'DELETE')
    return ok(notebook.deleteFolder(decodeURIComponent(folder[1]!)));
  // Agent activity (#172, A920): the server's routes, from the branch.
  if (path === '/api/agent-activity' && method === 'GET') return ok(await notebook.agentActivity());
  const undo = ACTIVITY_UNDO.exec(path);
  if (undo && method === 'POST') {
    const id = Number(undo[1]);
    if (!Number.isSafeInteger(id) || id < 1) throw bad('Invalid activity id');
    return ok(await notebook.undoAgentActivity(id));
  }
  if (path === '/api/settings' && method === 'GET') return ok(notebook.settings());
  if (path === '/api/settings' && method === 'PUT') return ok(notebook.changeSettings(body));
  throw new LocalError(
    404,
    'not_available',
    `${method} ${path} is not available for a git notebook`,
  );
}
