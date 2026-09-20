import 'server-only';
import { ChromiumPdfRenderer, type PdfRenderer, UnconfiguredPdfRenderer, defaultChromiumPath } from '@inrp2p/adapters';
import { optionalEnv } from './env.ts';

let renderer: PdfRenderer | undefined;

/**
 * The renderer that prints receipts (ARCHITECTURE §2).
 *
 * Printing needs a browser, and a browser is a deployment decision — a binary that has to be installed and
 * supervised. So it is opt-in: `INRP2P_PDF_RENDERER=chromium` says a deployment has one, and without it the
 * unconfigured renderer refuses. Refusing is the honest answer, because the receipt itself is not missing — it
 * is available as JSON, CSV and a print-ready HTML document that any browser will turn into a PDF.
 *
 * Asking for Chromium and not having one is a configuration mistake rather than a fallback, so it fails at
 * startup of the first render instead of quietly serving something else.
 */
export function pdfForWeb(): PdfRenderer {
  if (renderer) return renderer;
  if ((optionalEnv('INRP2P_PDF_RENDERER') ?? '').toLowerCase() !== 'chromium') {
    renderer = new UnconfiguredPdfRenderer();
    return renderer;
  }
  const executablePath = defaultChromiumPath(optionalEnv('INRP2P_CHROMIUM_PATH'));
  if (!executablePath) throw new Error('INRP2P_PDF_RENDERER=chromium but no Chromium binary was found; set INRP2P_CHROMIUM_PATH');
  renderer = new ChromiumPdfRenderer({ executablePath });
  return renderer;
}
