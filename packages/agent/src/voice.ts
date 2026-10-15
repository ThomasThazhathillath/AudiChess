import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

/** Polly neural voices available in ap-south-1 that suit the speaker. Kajal (Indian English) is the default. */
export const VOICES: Record<string, { id: string; lang: string; description: string }> = {
  indian: { id: "Kajal", lang: "en-IN", description: "Indian English, female" },
  american: { id: "Joanna", lang: "en-US", description: "American English, female" },
  "american male": { id: "Matthew", lang: "en-US", description: "American English, male" },
  british: { id: "Amy", lang: "en-GB", description: "British English, female" },
  "british male": { id: "Brian", lang: "en-GB", description: "British English, male" },
  australian: { id: "Olivia", lang: "en-AU", description: "Australian English, female" },
};
export const DEFAULT_VOICE = "Kajal";

export type Speak = (text: string, voiceId: string, ratePercent: number) => Promise<string | undefined>;

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Polly neural text-to-speech -> base64 MP3. Returns undefined on failure so the browser can fall back to its own voice. */
export function pollySpeaker(client = new PollyClient({})): Speak {
  return async (text, voiceId, ratePercent) => {
    try {
      const rate = Math.min(130, Math.max(70, Math.round(ratePercent)));
      const res = await client.send(
        new SynthesizeSpeechCommand({
          Engine: "neural",
          OutputFormat: "mp3",
          SampleRate: "24000",
          VoiceId: voiceId as never,
          TextType: "ssml",
          Text: `<speak><prosody rate="${rate}%">${escapeXml(text)}</prosody></speak>`,
        }),
      );
      const bytes = await res.AudioStream?.transformToByteArray();
      return bytes ? Buffer.from(bytes).toString("base64") : undefined;
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "polly failed", voiceId, error: String(err) }));
      return undefined;
    }
  };
}
