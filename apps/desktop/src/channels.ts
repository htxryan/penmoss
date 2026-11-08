/** IPC channel names shared by the main process and the preload (T29, T30). */
export const CHANNELS = {
  menuSet: 'penmoss:menu:set',
  themeSet: 'penmoss:theme:set',
  menuCommand: 'penmoss:menu:command',
  // A command for a main window still loading (T51, A945): its page takes it once it listens.
  menuCommandPending: 'penmoss:menu:command-pending',
  clipboardWrite: 'penmoss:clipboard:write',
  openPath: 'penmoss:open-path',
  captureDone: 'penmoss:capture:done',
  captureShow: 'penmoss:capture:show',
  captureHotkey: 'penmoss:capture:hotkey',
  captureSetHotkey: 'penmoss:capture:set-hotkey',
  storeChanged: 'penmoss:store-changed',
  // A page stored records (T45, A711): the main process tells every other window.
  stored: 'penmoss:stored',
  save: 'penmoss:save',
  saved: 'penmoss:saved',
  // The Mac's window behaviours (T46, T47; A720–A724), for main and note windows only.
  windowState: 'penmoss:window:state',
  windowStateChanged: 'penmoss:window:state-changed',
  keepOnTop: 'penmoss:window:keep-on-top',
  compactTitleBar: 'penmoss:window:compact-title-bar',
  // The menu bar icon (T51 item 17, A945): this Mac's preference, set from Settings → Display,
  // and the Quick Access notes its menu lists, sent by the main window's page (A946).
  menuBarIconGet: 'penmoss:menu-bar-icon:get',
  menuBarIconSet: 'penmoss:menu-bar-icon:set',
  quickAccessSet: 'penmoss:quick-access:set',
  // Send feedback (T49, A798): a PNG of the asking window, for main and note windows only.
  feedbackCapture: 'penmoss:feedback:capture',
  // Send feedback filed by main with the person's GitHub token (T57, A1010, A1012): the token is
  // saved and removed from Settings and never sent back to a page. Main and note windows.
  feedbackFile: 'penmoss:feedback:file',
  githubTokenStatus: 'penmoss:github-token:status',
  githubTokenSave: 'penmoss:github-token:save',
  githubTokenRemove: 'penmoss:github-token:remove',
  githubTokenChanged: 'penmoss:github-token:changed',
  // Sign in with GitHub (T82, A1170): the device flow, from the main window.
  githubSignInStatus: 'penmoss:github:sign-in-status',
  githubSignInStart: 'penmoss:github:sign-in-start',
  githubSignInCancel: 'penmoss:github:sign-in-cancel',
  githubSignInChanged: 'penmoss:github:sign-in-changed',
  // Auto-Update (T64 item 2, A1112, A1196): its state, the switch, the channel, Check Now and
  // Install and Restart.
  updatesState: 'penmoss:updates:state',
  updatesSetAuto: 'penmoss:updates:set-auto',
  updatesSetChannel: 'penmoss:updates:set-channel',
  updatesCheck: 'penmoss:updates:check',
  updatesInstall: 'penmoss:updates:install',
  updatesChanged: 'penmoss:updates:changed',
  // Search by meaning (T76, A1152, A1158): main relays to the embedding service. Main and note
  // windows; the switch is the main window's, after a gesture.
  meaningStatus: 'penmoss:meaning:status',
  meaningUpdate: 'penmoss:meaning:update',
  meaningClose: 'penmoss:meaning:close',
  meaningSearch: 'penmoss:meaning:search',
  meaningSetEnabled: 'penmoss:meaning:set-enabled',
  meaningChanged: 'penmoss:meaning:changed',
  // Git notebooks (T50 G3, G5; A853–A857): main runs git, the page runs the engine. Main and
  // note windows only; the token never reaches the page.
  gitList: 'penmoss:git:list',
  gitAdd: 'penmoss:git:add',
  gitRemove: 'penmoss:git:remove',
  gitUpdate: 'penmoss:git:update',
  gitToken: 'penmoss:git:token',
  gitPurgeCheck: 'penmoss:git:purge-check',
  gitRestoreCheck: 'penmoss:git:restore-check',
  gitPurgesToConfirm: 'penmoss:git:purges-to-confirm',
  gitSecret: 'penmoss:git:secret',
  gitOp: 'penmoss:git:op',
  gitCancel: 'penmoss:git:cancel',
  gitIdentity: 'penmoss:git:identity',
  gitChanged: 'penmoss:git:changed',
  // Browsing GitHub in Add a Git Notebook (T81, A1165): the main window only.
  gitGithubRepos: 'penmoss:git:github-repos',
  gitGithubFolders: 'penmoss:git:github-folders',
  gitGithubOwners: 'penmoss:git:github-owners',
  gitGithubCreate: 'penmoss:git:github-create',
  // Agents on this Mac with no account (T54, A992, A993): the `penmoss` command and agents'
  // clones of a git notebook for the local MCP server. Main window only.
  agentsList: 'penmoss:agents:list',
  agentsConnect: 'penmoss:agents:connect',
  agentsDisconnect: 'penmoss:agents:disconnect',
  cliStatus: 'penmoss:cli:status',
  cliInstall: 'penmoss:cli:install',
  cliRemove: 'penmoss:cli:remove',
} as const;

/** The argument that tells the preload which window it is in. */
export const WINDOW_ARG = '--penmoss-window=';
export const VERSION_ARG = '--penmoss-version=';
/**
 * The window's title-bar style (`compact` or `native`, T47), passed to main and note windows
 * that have the Mac's window behaviours (A725); absent, the page shows none of them.
 */
export const TITLE_BAR_ARG = '--penmoss-title-bar=';
