/** Words about agents shared by Settings → Git Notebooks and Settings → Agents (A1098). */

/** The notebook's name as a shell word for `penmoss mcp --notebook` (D52). */
export function mcpName(name: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(name) ? name : `"${name.replace(/(["\\$`])/g, '\\$1')}"`;
}
