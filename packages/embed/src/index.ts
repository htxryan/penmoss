export {
  EMBEDDING_GEMMA,
  manifestBytes,
  modelId,
  type ModelFile,
  type ModelManifest,
} from './manifest';
export {
  ModelError,
  fetchModel,
  modelPaths,
  modelStatus,
  openModel,
  otherModels,
  penmossHome,
  removeModel,
  type FetchOptions,
  type FetchProgress,
  type ModelErrorCode,
  type ModelPaths,
  type ModelStatus,
} from './model-store';
export { createOnnxEmbedder, type OnnxEmbedder, type OnnxEmbedderOptions } from './onnx-embedder';
export {
  FileVectorCache,
  removeOtherVectors,
  vectorsDir,
  type FileVectorCacheOptions,
} from './file-cache';
export { Lease, leaseHolder, leasePath, type LeaseHolder, type LeaseOptions } from './lease';
export {
  NodeMeaning,
  meaningEnabled,
  setMeaningEnabled,
  type MeaningLease,
  type MeaningStatus,
  type NodeMeaningOptions,
  type OpenedMeaning,
} from './node-meaning';
export {
  remoteEmbedder,
  serveEmbedder,
  type EmbedPort,
  type EmbedReply,
  type EmbedRequest,
  type EmbedderInfo,
} from './remote-embedder';
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
