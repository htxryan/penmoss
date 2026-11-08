/**
 * `penmoss models fetch|status|remove` (T75, A1151, A1158): the model search by meaning uses, on
 * this Mac. The same folder and setting as the app's Settings → Search by Meaning.
 */
import { UsageError } from '../args';
import type { Command, Context } from '../command';
import { CliError, EXIT } from '../errors';
import type { MeaningIo, MeaningStatus } from '../io';

const ACTIONS = ['fetch', 'status', 'remove'] as const;

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(0)} MB`;

function meaningOf(context: Context): MeaningIo {
  const meaning = context.io.meaning;
  if (!meaning) {
    throw new CliError(
      EXIT.ERROR,
      'This penmoss has no search by meaning: it comes with the Penmoss app (run the app’s penmoss).',
      'unsupported',
    );
  }
  return meaning;
}

function describe(status: MeaningStatus): string[] {
  const state =
    status.state === 'ready'
      ? `downloaded (${megabytes(status.totalBytes)})`
      : status.state === 'partial'
        ? `partly downloaded (${megabytes(status.bytes)} of ${megabytes(status.totalBytes)}): run penmoss models fetch`
        : `not downloaded (${megabytes(status.totalBytes)}): run penmoss models fetch`;
  return [
    `Search by meaning: ${status.enabled ? 'on' : 'off (Settings → Search by Meaning in the app)'}`,
    `Model: ${status.model}, ${state}`,
    `From: huggingface.co/${status.repository} at ${status.revision.slice(0, 8)}`,
    `Folder: ${status.dir}`,
    `Licence: ${status.license.name} (${status.license.url})`,
  ];
}

export const models: Command = {
  name: 'models',
  summary: 'Download, check or remove the model for search by meaning',
  usage: ['models status', 'models fetch', 'models remove'],
  description: [
    'Search by meaning runs on this Mac with EmbeddingGemma, a model of about 219 MB downloaded once from Hugging Face (the Gemma Terms of Use apply) into ~/.penmoss/models. Your notes never leave the Mac: their vectors are kept in ~/.penmoss/vectors.',
    'status says whether the model is here and search by meaning is on. fetch downloads it (resuming a download that stopped, checking every file’s checksum); the app’s Settings → Search by Meaning does the same. remove deletes the model and its vectors; search goes back to words only.',
    'With the model, penmoss search --mode hybrid (the default) finds notes by their words and their meaning, --mode semantic by meaning alone, and penmoss mcp gives agents the same.',
  ],
  flags: [],
  examples: ['penmoss models status', 'penmoss models fetch'],
  async run(context) {
    const [action, ...rest] = context.positionals;
    if (!action || !(ACTIONS as readonly string[]).includes(action)) {
      throw new UsageError('say what to do: penmoss models status, fetch or remove');
    }
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
    const meaning = meaningOf(context);
    if (action === 'status') {
      const status = await meaning.status();
      context.emit(status, () => describe(status));
      return;
    }
    if (action === 'remove') {
      const before = await meaning.status();
      await meaning.remove();
      const after = await meaning.status();
      context.emit({ ...after, removed: before.state !== 'absent' }, () =>
        before.state === 'absent'
          ? 'The model was not here; nothing to remove.'
          : `Removed the model and its vectors (${megabytes(before.bytes)}). Search is by words only until you fetch it again.`,
      );
      return;
    }
    const before = await meaning.status();
    let shown = -1;
    const status = await meaning.fetch((received, total) => {
      if (context.json) return;
      const percent = Math.floor((received / total) * 100);
      if (percent >= shown + 10 || percent === 100) {
        shown = percent - (percent % 10);
        context.note(`Downloading the model: ${percent}% of ${megabytes(total)}`);
      }
    });
    context.emit({ ...status, fetched: before.state !== 'ready' }, () => [
      before.state === 'ready' ? 'The model was already here.' : 'Downloaded the model.',
      ...describe(status),
    ]);
  },
};
