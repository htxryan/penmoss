/**
 * Node's side of usage analytics (PEN-137): the shared SQLite store and the consent file. Used
 * by the Mac app's main process, the CLI and the local MCP server; never bundled into the page
 * or a Worker.
 */
export * from './store';
export * from './consent-file';
export * from './sender';
export * from './ref-key';
