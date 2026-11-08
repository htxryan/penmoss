/**
 * Who writes comments from this device (T48, A781). A git notebook's comments are this Mac's
 * (D49): its commits carry the author, so a comment written here says "You" and edits as a
 * person's does. The server's actors, learned from each note's socket, went with the server
 * (T59).
 */
import type { CommentAuthor } from '@penmoss/sync-client/comments';

/** The author this device writes comments as. */
export function deviceAuthor(): CommentAuthor {
  return { id: 'device:this-device', kind: 'device', label: 'You' };
}
