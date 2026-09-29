/** 16-bit PCM WAV of a stereo buffer, base64. */
export function wavBase64(buffer: AudioBuffer): string {
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  const frames = buffer.length;
  const bytes = new DataView(new ArrayBuffer(44 + frames * 4));
  const text = (at: number, s: string) => [...s].forEach((c, i) => bytes.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  bytes.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  bytes.setUint32(16, 16, true);
  bytes.setUint16(20, 1, true);
  bytes.setUint16(22, 2, true);
  bytes.setUint32(24, buffer.sampleRate, true);
  bytes.setUint32(28, buffer.sampleRate * 4, true);
  bytes.setUint16(32, 4, true);
  bytes.setUint16(34, 16, true);
  text(36, 'data');
  bytes.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < 2; c++) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      bytes.setInt16(44 + i * 4 + c * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  const u8 = new Uint8Array(bytes.buffer);
  let binary = '';
  for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(binary);
}
