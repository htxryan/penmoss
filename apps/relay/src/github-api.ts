/**
 * What the Notebooks page asks GitHub before it adds a notebook (PEN-194): the repository and its
 * branches (the default first), and the notebook's own `.penmoss/notebook.json` there. Each answer
 * is a value or a sentence the page shows.
 */
import { encodeNotebookInfo, RENDER_VERSION } from '@penmoss/git-notebook';
import { Layout } from '@penmoss/git-notebook/layout';
import type { Place } from './config';

export interface GitHubCall {
  readonly api: string;
  readonly token: () => Promise<string>;
  readonly fetch: typeof fetch;
}

type Answer<T> = T | { readonly problem: string };

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'penmoss-relay',
});

async function send(
  call: GitHubCall,
  path: string,
  init: { readonly method: 'GET' } | { readonly method: 'PUT'; readonly body: unknown } = {
    method: 'GET',
  },
): Promise<Response | { problem: string }> {
  let token: string;
  try {
    token = await call.token();
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await call.fetch(
      `${call.api}${path}`,
      init.method === 'GET'
        ? { headers: headers(token) }
        : {
            method: init.method,
            headers: { ...headers(token), 'content-type': 'application/json' },
            body: JSON.stringify(init.body),
          },
    );
  } catch {
    return { problem: 'GitHub could not be reached. Try again in a moment.' };
  }
}

const get = (call: GitHubCall, path: string) => send(call, path);

/** The contents API's address of `.penmoss/notebook.json` at a place. */
const notebookPath = (place: Place) =>
  `/repos/${place.repository}/contents/${new Layout(place.root).notebook
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

/** The repository's branches, its default first. */
export async function branchesOf(
  call: GitHubCall,
  repository: string,
): Promise<Answer<readonly string[]>> {
  const repo = await get(call, `/repos/${repository}`);
  if ('problem' in repo) return repo;
  if (repo.status === 404 || repo.status === 403 || repo.status === 401) {
    await repo.body?.cancel();
    return {
      problem: `${repository} can’t be read with this access. Check its name, and that the App is installed on it or the token covers it.`,
    };
  }
  if (!repo.ok) {
    await repo.body?.cancel();
    return { problem: `GitHub answered ${repo.status} for ${repository}. Try again in a moment.` };
  }
  const { default_branch: main } = await repo.json<{ default_branch: string }>();
  const listed = await get(call, `/repos/${repository}/branches?per_page=100`);
  if ('problem' in listed) return listed;
  const names = listed.ok ? (await listed.json<{ name: string }[]>()).map((each) => each.name) : [];
  return [main, ...names.filter((name) => name !== main)];
}

/** The notebook's name and id in its `notebook.json`, or why there is none to read. */
export async function notebookFileOf(
  call: GitHubCall,
  place: Place,
): Promise<
  Answer<{ readonly name: string; readonly id: string }> | { problem: string; missing: true }
> {
  const where = `${place.repository} on ${place.branch}${place.root ? `, in ${place.root}` : ''}`;
  const file = await get(call, `${notebookPath(place)}?ref=${encodeURIComponent(place.branch)}`);
  if ('problem' in file) return file;
  if (file.status === 404) {
    await file.body?.cancel();
    return {
      problem: `There’s no Penmoss notebook in ${where}: it has no .penmoss/notebook.json.`,
      missing: true,
    };
  }
  if (!file.ok) {
    await file.body?.cancel();
    return { problem: `GitHub answered ${file.status} for ${where}. Try again in a moment.` };
  }
  const { content } = await file.json<{ content?: string }>();
  try {
    const text = new TextDecoder().decode(
      Uint8Array.from(atob((content ?? '').replace(/\s/g, '')), (c) => c.charCodeAt(0)),
    );
    const info = JSON.parse(text) as { name?: unknown; id?: unknown };
    if (typeof info.name !== 'string' || typeof info.id !== 'string') throw new Error('fields');
    return { name: info.name, id: info.id };
  } catch {
    return {
      problem: `The .penmoss/notebook.json in ${where} can’t be read as a Penmoss notebook.`,
    };
  }
}

/**
 * Starts a notebook at a place: its `notebook.json`, committed through the contents API, which
 * writes to an empty repository too. Null when it is made, else what went wrong.
 */
export async function makeNotebookFile(
  call: GitHubCall,
  place: Place,
  notebook: { readonly id: string; readonly name: string },
): Promise<string | null> {
  const bytes = encodeNotebookInfo({ ...notebook, format: 1, renderVersion: RENDER_VERSION });
  const made = await send(call, notebookPath(place), {
    method: 'PUT',
    body: {
      message: `Make the notebook “${notebook.name}”`,
      content: btoa(String.fromCharCode(...bytes)),
      branch: place.branch,
    },
  });
  if ('problem' in made) return made.problem;
  if (made.ok) {
    await made.body?.cancel();
    return null;
  }
  const said = ((await made.json().catch(() => ({}))) as { message?: string }).message;
  return `GitHub wouldn’t make the notebook (${made.status}${said ? `: ${said}` : ''}).`;
}
