import { loadConfig } from '../../../../tools/factory/src/config.ts';
import { appClient } from '../../../../tools/factory/src/tracker/index.ts';
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const c = appClient(loaded.config);
if (!c.ok) throw new Error(c.error);
const r = await c.client.request<any>(
  `query($id: String!) { issue(id: $id) { history(first: 30) { nodes { createdAt fromState { name } toState { name } actor { displayName } botActor { name type } addedLabels { name } removedLabels { name } } } attachments(first: 10) { nodes { title url sourceType } } } }`,
  { id: process.argv[2] },
);
for (const h of r.issue.history.nodes)
  if (h.toState || h.addedLabels?.length || h.removedLabels?.length)
    console.log(
      h.createdAt,
      h.fromState?.name ?? '',
      '→',
      h.toState?.name ?? '',
      '| by',
      h.actor?.displayName ?? '',
      JSON.stringify(h.botActor ?? null),
      '| +',
      (h.addedLabels ?? []).map((l: any) => l.name).join(','),
      '-',
      (h.removedLabels ?? []).map((l: any) => l.name).join(','),
    );
console.log(JSON.stringify(r.issue.attachments.nodes));
