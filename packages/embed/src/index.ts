export { EMBEDDING_GEMMA, modelId } from './manifest';
export { fetchModel, modelPaths } from './model-store';
export { vectorsDir } from './file-cache';
export { NodeMeaning } from './node-meaning';
export { type EmbedPort } from './remote-embedder';
export { MeaningService, type ServiceNote, type ServiceStatus } from './meaning-service';
export {
  serveService,
  serviceCalls,
  serviceClient,
  type ServiceCalls,
  type ServiceClient,
} from './service-rpc';
