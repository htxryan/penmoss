/**
 * The embedding service without the Node-only modules (`@penmoss/embed/service`): the Mac app's
 * `MeaningService`, its RPC and the remote embedder, for a host that brings its own model and
 * lease, such as the web suite's stand-in Mac. The package's root also holds the model store, the
 * ONNX embedder and the file cache, which need Node's fs and worker threads.
 */
export {
  MeaningService,
  type MeaningServiceOptions,
  type MeaningSource,
  type ServiceNote,
  type ServiceState,
  type ServiceStatus,
} from './meaning-service';
export {
  serveService,
  serviceCalls,
  serviceClient,
  type ServiceCalls,
  type ServiceClient,
  type ServiceMessage,
  type ServiceMethod,
  type ServiceRequest,
} from './service-rpc';
export {
  remoteEmbedder,
  serveEmbedder,
  type EmbedPort,
  type EmbedReply,
  type EmbedRequest,
  type EmbedderInfo,
} from './remote-embedder';
