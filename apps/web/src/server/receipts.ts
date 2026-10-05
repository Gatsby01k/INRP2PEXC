import 'server-only';
import { type ObjectStore, isObjectStoreConfigured, objectStoreFromEnv } from '@inrp2p/adapters';

let store: ObjectStore | null | undefined;

/**
 * The private receipts bucket (TD-12), when this deployment configures one; `null` otherwise, and receipts are then
 * regenerated from their snapshot and checked against the issued hash, as before. Never a public bucket and never a
 * presigned URL: the route authorizes the reader, reads the object and verifies its bytes before serving them.
 */
export function receiptStoreForWeb(): ObjectStore | null {
  if (store !== undefined) return store;
  const configured = objectStoreFromEnv('RECEIPTS', process.env);
  store = isObjectStoreConfigured(configured) ? configured : null;
  return store;
}
