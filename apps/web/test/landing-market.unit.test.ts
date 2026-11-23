import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { midText } = await import('../src/app/(public)/_landing/market.ts');

/**
 * The public site prints the market's mid one way everywhere — the masthead, the trader page's board, the earnings card —
 * to the paisa. The reference can carry four places; printed as it came, the masthead grew with the market until its
 * last button hung off a phone's screen.
 */
describe('the mid as the public site prints it', () => {
  it('is rupees to the paisa, however many places the reference carries', () => {
    expect(midText(104.5125)).toBe('104.51');
    expect(midText(104.5)).toBe('104.50');
    expect(midText(104.519)).toBe('104.52');
    expect(midText(99.999)).toBe('100.00');
  });

  it('groups a large figure the way the rest of the site does', () => {
    expect(midText(1234.5)).toBe('1,234.50');
  });
});
