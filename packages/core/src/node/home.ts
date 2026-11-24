/// <reference types="node" />
/**
 * Where Penmoss keeps its own files on a computer (A992): git notebooks' clones and credentials,
 * search by meaning's model and vectors, and usage analytics' answer and record. Node only (the
 * Mac app's main process, the CLI and the local MCP server); never bundled into the page.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `PENMOSS_HOME` when it is set to something other than blanks (tests, and a second install),
 * trimmed; otherwise `~/.penmoss`.
 */
export function penmossHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env['PENMOSS_HOME']?.trim() || join(homedir(), '.penmoss');
}
