import type { QueueGroupKey } from '@inrp2p/desk';

/** The queue's group names, shared by the queue (client) and the desk page's tabs (server). */
export const GROUP_TITLE: Record<QueueGroupKey, string> = {
  needs_action: 'Needs action',
  exception: 'Exceptions',
  settlement: 'Settlement',
  waiting_client: 'Waiting on client',
  processing: 'Processing',
};
