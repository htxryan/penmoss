/**
 * EmbeddingGemma for `eval:search` (A1159): fetched into PENMOSS_HOME once, then opened (hashes
 * checked) on onnxruntime-web with four threads, as the app's embedding service runs it.
 */
import { EMBEDDING_GEMMA } from './manifest';
import { fetchModel, openModel } from './model-store';
import { createOnnxEmbedder, type OnnxEmbedder } from './onnx-embedder';

export async function evalEmbedder(): Promise<OnnxEmbedder> {
  let shown = -1;
  await fetchModel(EMBEDDING_GEMMA, {
    onProgress: ({ received, total }) => {
      const percent = Math.floor((received / total) * 100);
      if (percent !== shown && percent % 10 === 0) process.stderr.write(`model: ${percent}%\n`);
      shown = percent;
    },
  });
  return createOnnxEmbedder({
    dir: await openModel(EMBEDDING_GEMMA),
    manifest: EMBEDDING_GEMMA,
    threads: 4,
  });
}
