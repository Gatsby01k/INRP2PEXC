/**
 * Which of the device's voices the robot may speak with — and whether any is good enough at all.
 *
 * Browser speech is only as good as the voices the device has, and some are unmistakably mechanical. The robot
 * speaks only with a voice that is natural (neural, premium, enhanced) or one of the known clear, calm system
 * voices; everything else is refused, and a device with nothing better stays silent rather than sounding cheap.
 * Among acceptable voices, Indian English is preferred, then British, then American.
 *
 * Names are not identifiers: some browsers translate them into the system's language ("Саманта"), which would
 * silently refuse every voice on a machine set to another language. Apple's voices are recognised by their
 * voice URI, which is stable (`com.apple.voice.compact.en-US.Samantha`); Google's and Microsoft's keep their
 * English names everywhere. A browser that offers neither — translated names and no URI — gets no voice.
 */

/** The parts of a `SpeechSynthesisVoice` the choice depends on. */
export interface VoiceInfo {
  readonly name: string;
  readonly lang: string;
  readonly voiceURI: string;
}

/** Engines that synthesise by rule and sound it, and Apple's novelty set. Never used, whatever they are called. */
const MECHANICAL = /espeak|mbrola|festival|flite|pico|speech-dispatcher|dectalk|eloquence|com\.apple\.speech\.synthesis\.voice\./i;

/** Apple's studio voices, by URI: premium and enhanced are natural; compact is acceptable only for the known good. */
const APPLE_NATURAL = /com\.apple\.voice\.(premium|enhanced)\./i;
const APPLE_COMPACT = /com\.apple\.voice\.compact\.[a-z]{2}[-_][A-Z]{2}\.(\w+)/;

/** Character and novelty voices. A calm confirmation is not a place for a joke. */
const NOVELTY =
  /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|princess|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley|hysterical)\b/i;

/** Neural and studio-quality voices, however each platform labels them. */
const NATURAL = /\b(natural|neural|premium|enhanced)\b/i;

/** Clear, calm voices that ship with major platforms and are known to sound it. */
const KNOWN_GOOD =
  /^(google (uk|us) english|google english|samantha|daniel|karen|moira|tessa|rishi|veena|isha|serena|ava|zoe|evan|nathan|allison|susan|microsoft (aria|jenny|guy|neerja|prabhat|sonia|ryan|libby|natasha|william|emma|brian|andrew|ava))\b/i;

const LANGUAGE_PREFERENCE: readonly RegExp[] = [/^en[-_]IN$/i, /^en[-_]GB$/i, /^en[-_]US$/i, /^en\b/i];

/**
 * How good a voice sounds, 0 when it must not be used: 3 natural, 2 a known good system voice. On Android the
 * system engine's English voices are neural but carry plain names ("English United Kingdom"); they count as good.
 */
export function voiceQuality(voice: VoiceInfo, platform: { android: boolean }): number {
  const label = `${voice.name} ${voice.voiceURI}`;
  if (MECHANICAL.test(label) || NOVELTY.test(voice.name)) return 0;
  if (NATURAL.test(voice.name) || APPLE_NATURAL.test(voice.voiceURI)) return 3;
  const compact = APPLE_COMPACT.exec(voice.voiceURI);
  if (KNOWN_GOOD.test(compact?.[1] ?? voice.name)) return 2;
  if (platform.android && /^english\b/i.test(voice.name)) return 2;
  return 0;
}

/** The best acceptable English voice, or null when the device has none worth hearing. */
export function selectVoice<V extends VoiceInfo>(voices: readonly V[], platform: { android: boolean }): V | null {
  let best: V | null = null;
  let bestScore = 0;
  for (const voice of voices) {
    const language = LANGUAGE_PREFERENCE.findIndex((pattern) => pattern.test(voice.lang));
    const quality = voiceQuality(voice, platform);
    if (language === -1 || quality === 0) continue;
    // Quality first — a natural voice beats a regional one — then the regional preference breaks the tie.
    const score = quality * 10 + (LANGUAGE_PREFERENCE.length - language);
    if (score > bestScore) {
      best = voice;
      bestScore = score;
    }
  }
  return best;
}
