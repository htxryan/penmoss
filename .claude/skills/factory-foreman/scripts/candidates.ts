import { loadConfig } from '../../../../tools/factory/src/config.ts';
import { appClient } from '../../../../tools/factory/src/tracker/index.ts';
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const c = appClient(loaded.config);
if (!c.ok) throw new Error(c.error);
const r = await c.client.request<any>(
  `query { issues(first: 100, filter: { team: { key: { eq: "PEN" } }, state: { type: { in: ["triage", "backlog", "unstarted"] } } }) { nodes { identifier title estimate priority state { name } parent { identifier } labels(first: 10) { nodes { name } } creator { displayName } description } } }`,
);
for (const n of r.issues.nodes) {
  const d = (n.description ?? '').replace(/\s+/g, ' ').slice(0, 260);
  console.log(
    `${n.identifier} [${n.state.name}] p${n.priority} parent=${n.parent?.identifier ?? '-'} by=${n.creator?.displayName ?? 'app/intake'} labels=${n.labels.nodes.map((l: any) => l.name).join(',')}\n  ${n.title}\n  ${d}\n`,
  );
}
