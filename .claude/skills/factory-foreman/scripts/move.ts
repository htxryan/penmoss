import { loadConfig } from '../../../../tools/factory/src/config.ts';
import { appClient } from '../../../../tools/factory/src/tracker/index.ts';
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const c = appClient(loaded.config);
if (!c.ok) throw new Error(c.error);
const [key, state] = process.argv.slice(2);
const t = await c.client.request<any>(
  `query { teams(first: 1, filter: { key: { eq: "PEN" } }) { nodes { states(first: 50) { nodes { id name } } } } }`,
);
const s = t.teams.nodes[0].states.nodes.find((n: any) => n.name === state);
const i = await c.client.request<any>(
  `query($id: String!) { issue(id: $id) { id state { name } } }`,
  { id: key },
);
await c.client.request(
  `mutation($id: String!, $s: String!) { issueUpdate(id: $id, input: { stateId: $s }) { success } }`,
  { id: i.issue.id, s: s.id },
);
console.log(`${key}: ${i.issue.state.name} → ${state} at ${new Date().toISOString()}`);
