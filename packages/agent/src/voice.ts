/**
 * Nova 2 Sonic voices for the speaker. The page speaks with Sonic (speech to speech, in the browser), so the agent only
 * picks the voice id. English only: Kiara and Arjun (Indian English) are also Hindi voices, and with them Sonic wrote
 * the user's English as Hindi ("knight f3" -> "maine tab key", 2026-10-23), so they are left out. Amy is the default.
 * Polly was removed on 2026-10-23.
 */
export const VOICES: Record<string, { id: string; lang: string; description: string }> = {
  american: { id: "tiffany", lang: "en-US", description: "American English, female" },
  "american male": { id: "matthew", lang: "en-US", description: "American English, male" },
  british: { id: "amy", lang: "en-GB", description: "British English, female" },
  australian: { id: "olivia", lang: "en-AU", description: "Australian English, female" },
};
export const DEFAULT_VOICE = "amy";

const SONIC_IDS = new Set(Object.values(VOICES).map((v) => v.id));
/** Anything else (a Polly id like "Kajal" or a dropped Sonic voice like "kiara") falls back to the default. */
export const sonicVoice = (id: string | undefined) => (id && SONIC_IDS.has(id) ? id : DEFAULT_VOICE);
