/**
 * `@penmoss/git-notebook/local` (T50 G2): a git notebook's notes API on this device
 * (`LocalNotebook`), for the CLI, the local MCP server (as tools) and Android's local notes
 * server (as REST routes).
 */
export * from './notebook';
export * from './rest';
export * from './mcp';
export * from './router';
export * from './comment-tools';
export * from './channel';
export { COMMENT_TOOL_NAMES, commentToolDefinitions, toolDefinitions } from './tools';
export type { ToolDefinition, ToolOptions } from './tools';
