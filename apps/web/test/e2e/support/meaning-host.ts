/**
 * Search by meaning on the stand-in Mac (T77): the Mac app's own `MeaningService` (T76), as its
 * utility process runs it, with a concept embedder in place of EmbeddingGemma, so a spec knows
 * which notes meaning finds. Words of one concept land on one axis; every text also has a little
 * of a last, shared axis, so a note with none of them is far from every query (below the floor).
 * The real model is checked by the Electron suite (apps/desktop/test/e2e/meaning.spec.ts).
 */
import { MemoryVectorCache, normalize, type Embedder } from '@penmoss/core/search';
import {
  MeaningService,
  type MeaningSource,
  type ServiceNote,
  type ServiceStatus,
} from '../../../../../packages/embed/src/meaning-service';
import type { DesktopMeaningStatus } from '../../../src/desktop/bridge';

/** Words by concept: power cuts, baking, travel in Japan. */
export const CONCEPTS: Readonly<Record<string, number>> = Object.fromEntries(
  [
    ['blackout', 'outage', 'power', 'electricity', 'battery', 'ups', 'generator', 'grid'],
    ['bread', 'sourdough', 'bake', 'baking', 'loaf', 'dough', 'starter', 'oven'],
    ['temple', 'temples', 'shrine', 'shrines', 'kyoto', 'japan', 'train', 'trains', 'rail'],
  ].flatMap((words, axis) => words.map((word) => [word, axis] as const)),
);
const AXES = 4;

export const conceptEmbedder: Embedder = {
  model: 'concepts/4',
  dimensions: AXES,
  floor: 0.28,
  embedQuery: (text) => Promise.resolve(embed(text)),
  embedDocuments: (texts) => Promise.resolve(texts.map(embed)),
};

function embed(text: string): Float32Array {
  const vector = new Float32Array(AXES);
  vector[AXES - 1] = 0.1;
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const axis = CONCEPTS[word];
    if (axis !== undefined) vector[axis]! += 1;
  }
  return normalize(vector);
}

/** The model is here and on; Off and On work as in the app, without files. */
function conceptSource(): MeaningSource {
  let enabled = true;
  let ready = true;
  const cache = Object.assign(new MemoryVectorCache(), { compact: () => Promise.resolve(0) });
  const status = () =>
    Promise.resolve({
      enabled,
      state: ready ? ('ready' as const) : ('absent' as const),
      bytes: ready ? 218_725_224 : 0,
      totalBytes: 218_725_224,
      model: conceptEmbedder.model,
      repository: 'stand-in',
      revision: 'stand-in',
      dir: '',
      license: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' },
    });
  return {
    status,
    fetch: async () => {
      ready = true;
      return status();
    },
    remove: () => {
      ready = false;
      return Promise.resolve();
    },
    setEnabled: (value) => {
      enabled = value;
      return Promise.resolve();
    },
    open: () =>
      Promise.resolve(
        enabled && ready
          ? {
              embedder: conceptEmbedder,
              cache,
              lease: () =>
                Promise.resolve({
                  held: () => Promise.resolve(true),
                  release: () => Promise.resolve(),
                }),
              close: () => Promise.resolve(),
            }
          : null,
      ),
  };
}

/** Main's side of it, as `penmossDesktop.meaning` reaches it. */
export class MeaningHost {
  private readonly service: MeaningService;
  private last: DesktopMeaningStatus | null = null;
  private readonly listeners = new Set<(status: DesktopMeaningStatus) => void>();

  constructor() {
    this.service = new MeaningService(conceptSource(), (status) => this.heard(status), {
      download: false,
      sliceMs: 50,
    });
    void this.service.start();
  }

  onChange(listener: (status: DesktopMeaningStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): DesktopMeaningStatus | null {
    return this.last;
  }

  update(notebookId: string, notes: readonly ServiceNote[]): Promise<string[]> {
    return this.service.update(notebookId, notes);
  }

  async search(
    notebookId: string,
    query: string,
    options: { readonly limit?: number; readonly ids?: readonly string[] },
  ) {
    const hits = await this.service.search(notebookId, query, options);
    const floor = this.service.floor();
    return hits && floor !== null ? { floor, hits } : null;
  }

  async setEnabled(enabled: boolean): Promise<DesktopMeaningStatus> {
    return this.withGeneration(await this.service.setEnabled(enabled));
  }

  stop(): Promise<void> {
    return this.service.stop();
  }

  private heard(status: ServiceStatus): void {
    const now = this.withGeneration(status);
    this.last = now;
    for (const listener of this.listeners) listener(now);
  }

  private withGeneration(status: ServiceStatus): DesktopMeaningStatus {
    return { ...status, generation: 1 };
  }
}
