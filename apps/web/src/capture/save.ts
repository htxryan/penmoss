/**
 * Quick capture (T30): where a capture goes and saving it, the same in the
 * web app's capture dialog and the Mac app's capture window.
 *
 * Today's note (in the synced time zone, A77) gets it under `## Captures`
 * with the time; or it becomes a new note in the Inbox folder. Where the form
 * starts is a synced setting, `capture.destination`, chosen in Settings →
 * Daily Notes (T51 item 19, A947); the form's own choice is for one capture
 * and is not remembered.
 * Everything goes through the local replica first: a capture saves offline
 * and syncs when the network is back. A save resolves once the note and the
 * workspace (Inbox) are stored on this device.
 */
import { templateOf, timeZoneOf, type CaptureDestination } from '@penmoss/core/settings';
import { today } from '../journal/journal';
import type { Notes } from '../notes/service';
import type { Workspace } from '../workspace/service';

export interface SavedCapture {
  readonly noteId: string;
  readonly destination: CaptureDestination;
}

/** Saves a capture on this device; resolves once it is stored locally. */
export async function saveCapture(
  notes: Notes,
  workspace: Workspace,
  text: string,
  destination: CaptureDestination,
  now: Date = new Date(),
): Promise<SavedCapture> {
  const capture = await import('@penmoss/model/capture');
  const settings = workspace.settings();
  // The destination is this capture's only: the default is Settings' to change (A947).
  if (destination === 'daily') {
    const period = today(settings, now).toString();
    // Filed first, as opening today's note does (journal.ts).
    workspace.fileJournalNote(notes.periodicId('daily', period), 'daily', period);
    const noteId = await notes.ensurePeriodic('daily', period, templateOf(settings, 'daily'));
    const time = capture.captureTime(now, timeZoneOf(settings));
    await Promise.all([
      notes.editNote(noteId, (doc) => capture.appendCapture(doc, text, time)),
      workspace.flush(),
    ]);
    return { noteId, destination };
  }
  // A capture of pictures only is titled by the day it was made (A343).
  const { title, body } = capture.splitCapture(text, today(settings, now).toString());
  const noteId = notes.create(now, { title, focus: false });
  workspace.fileInInbox(noteId);
  await Promise.all([
    body
      ? notes.editNote(noteId, (doc) => capture.appendMarkdown(doc, body))
      : notes.settled(noteId),
    workspace.flush(),
  ]);
  return { noteId, destination };
}
