import { loadConfig } from '../../../../tools/factory/src/config.ts';
import { appClient } from '../../../../tools/factory/src/tracker/index.ts';
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const c = appClient(loaded.config);
if (!c.ok) throw new Error(c.error);
const r = await c.client.request<any>(
  `query($id: String!) { issue(id: $id) { identifier title description priority state { name } creator { id displayName } labels(first: 20) { nodes { name parent { name } } } comments(first: 20) { nodes { body user { displayName } } } } }`,
  { id: process.argv[2] },
);
console.log(JSON.stringify(r.issue, null, 1));
