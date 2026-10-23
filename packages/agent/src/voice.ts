/**
 * Nova 2 Sonic voices for the speaker. The page speaks with Sonic (speech to speech, in the browser), so the agent only
 * picks the voice id; Kiara (Indian English) is the default. Polly was removed on 2026-10-23.
 */
export const VOICES: Record<string, { id: string; lang: string; description: string }> = {
  indian: { id: "kiara", lang: "en-IN", description: "Indian English, female" },
  "indian male": { id: "arjun", lang: "en-IN", description: "Indian English, male" },
  american: { id: "tiffany", lang: "en-US", description: "American English, female" },
  "american male": { id: "matthew", lang: "en-US", description: "American English, male" },
  british: { id: "amy", lang: "en-GB", description: "British English, female" },
  australian: { id: "olivia", lang: "en-AU", description: "Australian English, female" },
};
export const DEFAULT_VOICE = "kiara";

const SONIC_IDS = new Set(Object.values(VOICES).map((v) => v.id));
/** A session saved before Sonic holds a Polly id ("Kajal"): that falls back to the default. */
export const sonicVoice = (id: string | undefined) => (id && SONIC_IDS.has(id) ? id : DEFAULT_VOICE);
