import { Color } from 'three';

/**
 * Brand colours through the film's tone mapping.
 *
 * The frame is tone mapped as a whole (Khronos PBR Neutral, the site robot's own), so a surface drawn in the
 * brand's ivory would come out a shade darker than the page it cuts to. `beforeNeutral` finds the linear colour
 * that the tone mapping turns into the one asked for, so the set's ivory is the site's ivory, exactly.
 */

/** Khronos PBR Neutral, as three.js implements it, on a linear colour. */
export function neutral(c: readonly [number, number, number]): [number, number, number] {
  const start = 0.8 - 0.04;
  const desaturation = 0.15;
  let [r, g, b] = c;
  const x = Math.min(r, g, b);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, g, b);
  if (peak < start) return [r, g, b];
  const d = 1 - start;
  const newPeak = 1 - (d * d) / (peak + d - start);
  const k = newPeak / peak;
  r *= k;
  g *= k;
  b *= k;
  const mix = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return [r + (newPeak - r) * mix, g + (newPeak - g) * mix, b + (newPeak - b) * mix];
}

/** The linear colour that PBR Neutral maps onto `hex` (an sRGB colour), found by fixed-point iteration. */
export function beforeNeutral(hex: string): Color {
  const target = new Color(hex); // three.js stores it linear
  const want: [number, number, number] = [target.r, target.g, target.b];
  const guess: [number, number, number] = [...want];
  for (let i = 0; i < 200; i++) {
    const got = neutral(guess);
    for (let c = 0; c < 3; c++) guess[c] = Math.max(0, guess[c]! + (want[c]! - got[c]!) * 0.9);
  }
  return new Color(guess[0], guess[1], guess[2]);
}
