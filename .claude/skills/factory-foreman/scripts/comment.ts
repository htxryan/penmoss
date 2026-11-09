import { readFileSync } from 'node:fs';
import { loadConfig } from '../../../../tools/factory/src/config.ts';
import { appClient } from '../../../../tools/factory/src/tracker/index.ts';
const notes = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Record<string, string>;
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const c = appClient(loaded.config);
if (!c.ok) throw new Error(c.error);
for (const [key, body] of Object.entries(notes)) {
  const i = await c.client.request<any>(`query($id: String!) { issue(id: $id) { id } }`, {
    id: key,
  });
  await c.client.request(
    `mutation($id: String!, $b: String!) { commentCreate(input: { issueId: $id, body: $b }) { success } }`,
    { id: i.issue.id, b: body },
  );
  console.log(`${key}: commented`);
}
