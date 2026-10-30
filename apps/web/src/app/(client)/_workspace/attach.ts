/**
 * A file a person attaches to a deal's chat, made ready in the browser: a picture is redrawn as a JPEG no larger than it
 * needs to be — which also drops what a phone writes into a photo (the place it was taken, the device) — and a PDF goes
 * as it is. The server checks the bytes again whatever arrives; this only keeps a phone's 12-megapixel photo of a
 * receipt from failing on size.
 */
export const ATTACH_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
export const ATTACH_MAX_BYTES = 3 * 1024 * 1024;

/** A screenshot this small and sharp stays a PNG: its text is what matters, and JPEG would blur it. */
const KEEP_PNG_UNDER = 1_500_000;

async function redraw(file: File, maxSide: number, quality: number): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function prepareAttachment(file: File): Promise<{ readonly ok: true; readonly file: File } | { readonly ok: false; readonly error: string }> {
  if (file.type === 'application/pdf') {
    return file.size <= ATTACH_MAX_BYTES ? { ok: true, file } : { ok: false, error: 'That PDF is over 3 MB. Attach a screenshot of the receipt instead.' };
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return { ok: false, error: 'Attach a picture (JPEG, PNG, WebP) or a PDF.' };
  if (file.type === 'image/png' && file.size <= KEEP_PNG_UNDER) return { ok: true, file };
  try {
    for (const [side, quality] of [[2200, 0.86], [1600, 0.75]] as const) {
      const blob = await redraw(file, side, quality);
      if (blob && blob.size <= ATTACH_MAX_BYTES) {
        const name = `${(file.name || 'receipt').replace(/\.[A-Za-z0-9]{1,5}$/, '')}.jpg`;
        return { ok: true, file: new File([blob], name, { type: 'image/jpeg' }) };
      }
    }
  } catch {
    // A picture the browser cannot read is not one the server would take either.
  }
  return { ok: false, error: 'That picture could not be prepared. Try a screenshot instead.' };
}

export const fileSize = (bytes: number): string => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);
