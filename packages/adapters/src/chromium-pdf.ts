import { existsSync } from 'node:fs';
import { type Browser, chromium } from 'playwright-core';
import type { PdfDocument, PdfRenderer } from './pdf.ts';

/**
 * Which Chromium to print with, resolved in one place and in one order: an explicitly named binary, the one a
 * container preinstalled, then the one Playwright installed for itself. Returns null when the machine has none,
 * so a caller can fall back to the unconfigured renderer rather than failing at the first download.
 */
export function defaultChromiumPath(named?: string | undefined): string | null {
  if (named && existsSync(named)) return named;
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  const installed = chromium.executablePath();
  return installed && existsSync(installed) ? installed : null;
}

/**
 * Prints a receipt with headless Chromium (ARCHITECTURE §2).
 *
 * Two things make this a renderer rather than a screenshot tool. The document is loaded as **content**, never as
 * a URL, and it references nothing over the network, so what is printed is exactly the bytes the receipt hashed —
 * there is no request that could return something else today than it did last year. And the print is asked for
 * in `print` media with backgrounds on, so the page prints the way the document was designed to print.
 *
 * The browser is started once and kept, because a receipt download should not pay for a process launch every
 * time, and is closed on shutdown.
 */
export interface ChromiumPdfOptions {
  /** Path to the Chromium binary. Named explicitly: "whatever browser the machine has" is not a fixed renderer. */
  readonly executablePath?: string | undefined;
  readonly format?: 'A4' | 'Letter';
}

export class ChromiumPdfRenderer implements PdfRenderer {
  readonly renderer = 'chromium';
  readonly #options: ChromiumPdfOptions;
  #browser: Promise<Browser> | null = null;

  constructor(options: ChromiumPdfOptions = {}) {
    this.#options = options;
  }

  #launch(): Promise<Browser> {
    this.#browser ??= chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(this.#options.executablePath ? { executablePath: this.#options.executablePath } : {}),
    });
    return this.#browser;
  }

  async render(document: PdfDocument): Promise<Uint8Array> {
    const browser = await this.#launch();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // `setContent` rather than a URL: the document is self-contained, and nothing may be fetched while printing.
      await page.setContent(document.html, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      return await page.pdf({
        format: this.#options.format ?? 'A4',
        printBackground: true,
        margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      });
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    if (browser) await (await browser).close();
  }
}
