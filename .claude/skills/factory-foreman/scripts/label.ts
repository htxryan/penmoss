import { loadConfig } from '../../../../tools/factory/src/config.ts';
import { appClient } from '../../../../tools/factory/src/tracker/index.ts';
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const c = appClient(loaded.config);
if (!c.ok) throw new Error(c.error);
const [key, ...wanted] = process.argv.slice(2);
const labels = await c.client.request<any>(
  `query { issueLabels(first: 250) { nodes { id name parent { name } team { key } } } }`,
);
const issue = await c.client.request<any>(`query($id: String!) { issue(id: $id) { id } }`, {
  id: key,
});
for (const w of wanted) {
  const [group, name] = w.includes('/') ? w.split('/') : [null, w];
  const l = labels.issueLabels.nodes.find(
    (n: any) =>
      n.name === name && (n.parent?.name ?? null) === group && (!n.team || n.team.key === 'PEN'),
  );
  if (!l) throw new Error(`no label ${w}`);
  await c.client.request(
    `mutation($id: String!, $l: String!) { issueAddLabel(id: $id, labelId: $l) { success } }`,
    { id: issue.issue.id, l: l.id },
  );
  console.log(`${key}: + ${w}`);
}
