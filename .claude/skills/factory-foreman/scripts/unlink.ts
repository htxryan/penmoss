import { loadConfig } from '../../../../tools/factory/src/config.ts';
import { appClient } from '../../../../tools/factory/src/tracker/index.ts';
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const c = appClient(loaded.config);
if (!c.ok) throw new Error(c.error);
const r = await c.client.request<any>(
  `query($id: String!) { issue(id: $id) { attachments(first: 10) { nodes { id url } } } }`,
  { id: process.argv[2] },
);
for (const a of r.issue.attachments.nodes)
  if (a.url === process.argv[3]) {
    const d = await c.client.request<any>(
      `mutation($id: String!) { attachmentDelete(id: $id) { success } }`,
      { id: a.id },
    );
    console.log('deleted', a.url, JSON.stringify(d));
  }
