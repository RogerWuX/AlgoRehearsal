import { resolveSupportedModel, type ModelFactoryId } from '../../../shared/apiConfig';
import type { TransportFactory } from '../model/transport';
import { createGeminiTransport } from './live/gemini/transport.web';

const factories: Partial<Record<ModelFactoryId, TransportFactory>> = { google: createGeminiTransport };

export const createLiveTransport: TransportFactory = (config, request, events, logger) => {
  const entry = resolveSupportedModel(config.model, 'live');
  const factory = factories[entry.modelFactory];
  if (!factory) throw new Error(`Unsupported Live adapter: ${entry.modelFactory}`);
  return factory(config, request, events, logger);
};
