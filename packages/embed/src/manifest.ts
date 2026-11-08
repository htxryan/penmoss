/**
 * The model search by meaning uses (D59, A1150, A1151): EmbeddingGemma-300m, 4-bit, from
 * onnx-community's ONNX export, pinned to one commit with each file's size and SHA-256 (T70).
 * Penmoss does not redistribute the weights; each Mac downloads them from Hugging Face.
 */
export interface ModelFile {
  /** Path in the repository and in the model's folder. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ModelManifest {
  /** The folder's name and the start of the embedder's model id. */
  readonly name: string;
  /** Hugging Face repository, e.g. `onnx-community/embeddinggemma-300m-ONNX`. */
  readonly repo: string;
  /** The commit every file is fetched at. */
  readonly revision: string;
  readonly files: readonly ModelFile[];
  /** The ONNX graph, its external data, the tokenizer and its config (paths in `files`). */
  readonly graph: string;
  readonly externalData: readonly string[];
  readonly tokenizer: string;
  readonly tokenizerConfig: string;
  /** The graph's output holding one pooled vector per input. */
  readonly output: string;
  readonly dimensions: number;
  /** Hybrid's floor for this model (A1155, tuned by eval:search). */
  readonly floor: number;
  /** What leads a query and a document; part of the model id, so a change embeds everything again. */
  readonly prompts: { readonly version: string; readonly query: string; readonly document: string };
  /** Tokens past this are cut (EmbeddingGemma reads 2,048). */
  readonly maxTokens: number;
  readonly license: { readonly name: string; readonly url: string };
}

export const EMBEDDING_GEMMA: ModelManifest = {
  name: 'embeddinggemma-300m-q4',
  repo: 'onnx-community/embeddinggemma-300m-ONNX',
  revision: '5090578d9565bb06545b4552f76e6bc2c93e4a66',
  files: [
    {
      path: 'onnx/model_q4.onnx',
      bytes: 519_322,
      sha256: 'ad1dfee81a70f7944b9b9d1cc6e48075b832881cf33fab2f2b248be78f3f0043',
    },
    {
      path: 'onnx/model_q4.onnx_data',
      bytes: 196_725_760,
      sha256: '599962c3143b040de2dd05e5975be3e9091dd067cacc6a8f7186e3203bab9e02',
    },
    {
      path: 'tokenizer.json',
      bytes: 20_323_312,
      sha256: '4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47',
    },
    {
      path: 'tokenizer_config.json',
      bytes: 1_156_830,
      sha256: '3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a',
    },
  ],
  graph: 'onnx/model_q4.onnx',
  externalData: ['onnx/model_q4.onnx_data'],
  tokenizer: 'tokenizer.json',
  tokenizerConfig: 'tokenizer_config.json',
  output: 'sentence_embedding',
  dimensions: 768,
  floor: 0.28,
  prompts: {
    version: 'p1',
    query: 'task: search result | query: ',
    document: 'title: none | text: ',
  },
  maxTokens: 2048,
  license: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' },
};

/** The embedder's model id (A1153): name, short revision, dimensions and prompts. */
export function modelId(manifest: ModelManifest): string {
  return `${manifest.name}@${manifest.revision.slice(0, 8)}/${manifest.dimensions}/${manifest.prompts.version}`;
}

/** Every file's bytes together. */
export function manifestBytes(manifest: ModelManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}
