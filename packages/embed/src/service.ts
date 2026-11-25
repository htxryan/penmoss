/**
 * The embedding service without the Node-only modules (`@penmoss/embed/service`): the Mac app's
 * `MeaningService`, its RPC and the remote embedder, for a host that brings its own model and
 * lease, such as the web suite's stand-in Mac. The package's root also holds the model store, the
 * ONNX embedder and the file cache, which need Node's fs and worker threads.
 */
export {
  MeaningService,
  type MeaningSource,
  type ServiceNote,
  type ServiceStatus,
} from './meaning-service';
