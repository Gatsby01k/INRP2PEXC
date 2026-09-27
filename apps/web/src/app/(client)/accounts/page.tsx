import { permanentRedirect } from 'next/navigation';

/**
 * Accounts is now Destinations. The old address stays answerable because it was written into notifications that
 * are already in clients' inboxes and emails (`DESTINATION_ADDED`, `DESTINATION_ARCHIVED` before the rename).
 */
export default function AccountsPage(): never {
  permanentRedirect('/destinations');
}
