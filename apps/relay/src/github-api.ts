/**
 * What the Notebooks page asks GitHub before it adds a notebook (PEN-194): the repository and its
 * branches (the default first), and the notebook's own `.penmoss/notebook.json` there. Each answer
 * is a value or a sentence the page shows.
 */
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

async function get(call: GitHubCall, path: string): Promise<Response | { problem: string }> {
  let token: string;
  try {
    token = await call.token();
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
  try {
    return await call.fetch(`${call.api}${path}`, { headers: headers(token) });
  } catch {
    return { problem: 'GitHub could not be reached. Try again in a moment.' };
  }
}

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
): Promise<Answer<{ readonly name: string; readonly id: string }>> {
  const path = `${place.root}.penmoss/notebook.json`;
  const where = `${place.repository} on ${place.branch}${place.root ? `, in ${place.root}` : ''}`;
  const file = await get(
    call,
    `/repos/${place.repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(place.branch)}`,
  );
  if ('problem' in file) return file;
  if (file.status === 404) {
    await file.body?.cancel();
    return {
      problem: `There’s no Penmoss notebook in ${where}: it has no .penmoss/notebook.json.`,
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
