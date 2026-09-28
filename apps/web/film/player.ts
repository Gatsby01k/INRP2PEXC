/**
 * The preview: the stage in a frame scaled to the window, a scrubber, and play — the soundtrack in time with it.
 * Playing asks the stage for the frame at the audio clock's time, as fast as the stage can draw; a slow machine
 * drops frames rather than drifting from the sound. The render (`scripts/film.ts`) is what makes the film itself.
 */
export {};

const frame = document.querySelector<HTMLDivElement>('.frame')!;
const iframe = document.querySelector('iframe')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const scrub = document.querySelector<HTMLInputElement>('#scrub')!;
const time = document.querySelector('output')!;

const fit = () => {
  const s = Math.min(frame.clientWidth / 1600, frame.clientHeight / 900);
  iframe.style.transform = `scale(${s}) translate(-50%, -50%)`;
};
new ResizeObserver(fit).observe(frame);

await new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
const film = iframe.contentWindow!.film;
await film.ready;
scrub.max = String(film.duration);

let t = 0;
let busy = false;
const show = async (to: number) => {
  t = to;
  scrub.value = String(to);
  time.value = `${to.toFixed(2)} s`;
  if (busy) return;
  busy = true;
  await film.seek(t);
  busy = false;
};
scrub.addEventListener('input', () => void show(Number(scrub.value)));

const audio = new AudioContext();
const bytes = Uint8Array.from(atob(await film.soundtrack()), (c) => c.charCodeAt(0));
const track = await audio.decodeAudioData(bytes.buffer);
let source: AudioBufferSourceNode | null = null;
let startedAt = 0;

const stop = () => {
  source?.stop();
  source = null;
  play.textContent = 'Play';
};
const tick = () => {
  if (!source) return;
  const now = audio.currentTime - startedAt;
  if (now >= film.duration) {
    stop();
    return;
  }
  void show(now);
  requestAnimationFrame(tick);
};
play.addEventListener('click', async () => {
  if (source) return stop();
  await audio.resume();
  const from = t >= film.duration - 0.05 ? 0 : t;
  source = audio.createBufferSource();
  source.buffer = track;
  source.connect(audio.destination);
  source.start(0, from);
  startedAt = audio.currentTime - from;
  play.textContent = 'Pause';
  requestAnimationFrame(tick);
});
