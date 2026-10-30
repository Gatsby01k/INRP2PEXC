import { describe, expect, it } from 'vitest';
import { attachmentRef, checkAttachment, cleanFileName, sniffDealFile } from '../src/chat.ts';

const bytes = (...head: number[]) => new Uint8Array([...head, ...new Array(32).fill(0)]);

describe('what a deal chat takes as a file (ADR 0023)', () => {
  it('knows a file by its first bytes', () => {
    expect(sniffDealFile(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffDealFile(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffDealFile(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp');
    expect(sniffDealFile(new TextEncoder().encode('%PDF-1.7\n'))).toBe('application/pdf');
  });

  it('takes nothing a browser would run or render as a page', () => {
    for (const text of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<!doctype html><script>', 'GIF89a', 'PK\u0003\u0004']) {
      expect(sniffDealFile(new TextEncoder().encode(text))).toBeNull();
    }
  });

  it('names a file by its own base name and its real type, never a path', () => {
    expect(cleanFileName('C:\\Users\\me\\Receipt (1).PNG', 'image/png')).toBe('Receipt (1).png');
    expect(cleanFileName('../../etc/passwd', 'application/pdf')).toBe('passwd.pdf');
    expect(cleanFileName('<script>.jpg', 'image/jpeg')).toBe('script.jpg');
    expect(cleanFileName('', 'image/webp')).toBe('attachment.webp');
  });

  it('holds the bytes to what the command said of them', () => {
    const png = { name: 'r.png', type: 'image/png', bytes: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) };
    expect(checkAttachment(png, attachmentRef(png))).toMatchObject({ type: 'image/png', name: 'r.png' });
    const other = { ...png, bytes: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1) };
    expect(() => checkAttachment(other, attachmentRef(png))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    // A type claimed by the browser counts for nothing: the bytes decide.
    const lying = { name: 'x.png', type: 'image/png', bytes: new TextEncoder().encode('<html>') };
    expect(() => checkAttachment(lying, attachmentRef(lying))).toThrow(expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED' }));
  });
});
