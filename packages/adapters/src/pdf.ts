/**
 * PDF rendering port (ARCHITECTURE §2): an immutable receipt's HTML, printed.
 *
 * It is a port rather than a function because printing needs a browser, and a browser is a deployment decision —
 * a binary to install, a process to supervise, a sandbox to get right. The domain produces the document; how it
 * becomes a PDF is somebody else's problem, and a deployment that has not solved it says so instead of serving
 * a broken file.
 */
export interface PdfDocument {
  /** A complete, standalone HTML document. It must not reference anything over the network. */
  readonly html: string;
  readonly title: string;
}

export interface PdfRenderer {
  readonly renderer: string;
  render(document: PdfDocument): Promise<Uint8Array>;
  /** Releases whatever the renderer is holding (a browser process, usually). Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Used when no PDF renderer is configured. Every render fails loudly, which is the honest answer: the receipt
 * itself still exists as JSON, CSV and a print-ready HTML document, and a person can print that from their own
 * browser. Quietly returning an empty or half-rendered PDF would be worse than refusing.
 */
export class UnconfiguredPdfRenderer implements PdfRenderer {
  readonly renderer = 'unconfigured';
  async render(_document: PdfDocument): Promise<Uint8Array> {
    throw new Error('PDF_RENDERER_NOT_CONFIGURED: no PDF renderer is configured; the receipt is available as JSON, CSV and a printable HTML document');
  }
  async close(): Promise<void> {}
}

export const isPdfRendererConfigured = (renderer: PdfRenderer): boolean => !(renderer instanceof UnconfiguredPdfRenderer);
