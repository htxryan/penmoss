/**
 * Ryan's own tracker access, for the Factory UI's writes alone (F21, LD4): his `gh` login on
 * GitHub, his personal key on Linear. Clearing Blocked lives here, and only the UI imports it:
 * the daemon and the runs can set Blocked but never clear it (R23), and a test holds that line.
 */
import type { FactoryConfig } from '../config.ts';
import { nodeExec, type Exec } from '../exec.ts';
import type { Gh } from '../github.ts';
import { createGithubTracker } from '../tracker/github.ts';
import { createLinearTracker } from '../tracker/linear.ts';
import type { LinearClient } from '../tracker/linear-client.ts';
import type { OwnerTracker } from '../tracker/port.ts';

const CLEAR_FIELD = `
mutation($project: ID!, $item: ID!, $field: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) {
    projectV2Item { id }
  }
}`;

const REMOVE_LABEL = `
mutation($id: String!, $label: String!) { issueRemoveLabel(id: $id, labelId: $label) { success } }`;

/** GitHub as Ryan: `gh` must be his own login, which `runUi` checks before serving. */
export function githubOwner(config: FactoryConfig, gh: Gh): OwnerTracker {
  const tracker = createGithubTracker(config, gh);
  return {
    ...tracker,
    clearBlocked: async (item) => {
      const board = await tracker.project();
      await gh.graphql(CLEAR_FIELD, {
        project: board.projectId,
        item: item.itemId,
        field: board.blocked.id,
      });
    },
  };
}

/** Linear as Ryan: the client must use his own key, which `runUi` checks before serving. */
export function linearOwner(config: FactoryConfig, client: LinearClient): OwnerTracker {
  const tracker = createLinearTracker(config, client);
  return {
    ...tracker,
    clearBlocked: async (item) => {
      const label = (await tracker.team()).blockedLabel;
      if (!label) throw new Error(`Linear has no "${config.linear.blockedLabel}" label`);
      const r = await client.request<{ issueRemoveLabel: { success: boolean } }>(REMOVE_LABEL, {
        id: item.itemId,
        label,
      });
      if (!r.issueRemoveLabel.success)
        throw new Error(`Linear didn't clear Blocked on ${item.key}`);
    },
  };
}

/** Ryan's own Linear key, from the keychain item only he creates (LD4); empty when there's none. */
export async function ownerKey(config: FactoryConfig, exec: Exec = nodeExec): Promise<string> {
  const r = await exec('security', [
    'find-generic-password',
    '-s',
    config.linear.keychainItem,
    '-w',
  ]);
  return r.code === 0 ? r.stdout.trim() : '';
}
