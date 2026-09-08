import { MockChannelAdapter } from './mock.js';

/**
 * The only place a channel implementation is named.
 *
 * When the real API docs arrive, the work is:
 *   1. write src/channels/<provider>.js extending ChannelAdapter
 *   2. add one line here
 * Nothing else in the platform needs to know the provider exists.
 */
const ADAPTERS = {
  mock: MockChannelAdapter,
};

export function getAdapterClass(key) {
  const Adapter = ADAPTERS[key];
  if (!Adapter) {
    throw new Error(`No channel adapter registered for "${key}"`);
  }
  return Adapter;
}

export function listAdapters() {
  return Object.entries(ADAPTERS).map(([key, Adapter]) => ({
    key,
    displayName: Adapter.displayName,
    capabilities: Adapter.capabilities,
    credentialFields: Adapter.credentialFields,
  }));
}

export function createAdapter(channel, log) {
  const Adapter = getAdapterClass(channel.adapter);
  let credentials = {};
  if (channel.credentials) {
    try {
      credentials = JSON.parse(channel.credentials);
    } catch {
      credentials = {};
    }
  }
  return new Adapter({ channel, credentials, log });
}
