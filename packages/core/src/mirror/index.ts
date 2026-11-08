/**
 * The git mirror's pure code (T27, T43), shared since T50 G1 (A832): the server's mirror and the
 * git notebooks (`@penmoss/git-notebook`) name files, read the folder tree and diff trees with
 * the same functions, so both write the same paths for the same notes.
 */
export * from './paths';
export * from './tree';
export * from './workspace-tree';
