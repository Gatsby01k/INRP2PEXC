import 'server-only';
import { DomainError } from '@inrp2p/kernel';
import { type DealAttachment, type DealAttachmentRef, DEAL_FILE_MAX_BYTES, attachmentRef } from '@inrp2p/settlement';

/**
 * A file attached to a deal's chat, as a server action receives it (ADR 0023): its bytes for the command, and the
 * reference its payload carries — name, type, size and hash — so the same press is the same request and a different
 * file is a different one. What the bytes are is decided by the command, from the bytes; never by the browser's word.
 */
export async function attachmentOf(form: FormData): Promise<{ readonly file: DealAttachment | undefined; readonly ref: DealAttachmentRef | null }> {
  const entry = form.get('file');
  if (!(entry instanceof File) || entry.size === 0) return { file: undefined, ref: null };
  if (entry.size > DEAL_FILE_MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 'a file can be up to 3 MB — a screenshot or a PDF of the receipt', { field: 'file' });
  const file: DealAttachment = { name: entry.name || 'attachment', type: entry.type, bytes: new Uint8Array(await entry.arrayBuffer()) };
  return { file, ref: attachmentRef(file) };
}

export const formText = (form: FormData, name: string): string | null => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v : null;
};
