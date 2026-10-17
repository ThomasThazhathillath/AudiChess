import type { ConverseCommandInput, ConverseCommandOutput, TokenUsage } from "@aws-sdk/client-bedrock-runtime";

/**
 * Accent-proof decoding of a spoken move the matcher couldn't place: the model sees only the legal moves (or the
 * matcher's candidates) and what speech recognition heard, and names the legal move that sounds closest, or none.
 * Kept free of the agent's other imports, so scripts can load it on its own.
 */
export async function decodeMove(
  converse: (input: ConverseCommandInput) => Promise<ConverseCommandOutput>,
  modelId: string,
  heard: string[],
  legal: string[],
  reason?: string,
): Promise<{ san?: string; usage?: TokenUsage }> {
  if (legal.length === 0) return {};
  const prompt = [
    "A chess player said a move out loud and speech recognition wrote it down, possibly badly: the speaker may have any accent.",
    `What recognition heard: ${heard.map((h) => `"${h}"`).join(", ")}`,
    reason ? `Taken literally it is not playable: ${reason}.` : "",
    `The player's legal moves (SAN): ${legal.join(", ")}`,
    "Typical confusions: letters a/e/i, b/d/e/p/v, c/s/z, f/s/x, g/j, m/n; numbers six/sex/sick/sikh, four/for/far, two/to/too, eight/ate/it, three/tree/free; 'elephant' or 'ee' for e; 'after' or 'ef' for f; 'night' for knight; 'porn'/'pond'/'tawny' for pawn; 'rock' for rook.",
    "If one legal move clearly sounds like what was said, answer with its SAN. If the player named a move that is simply illegal (a square no piece of that kind can reach), or nothing fits, answer none.",
    'Reply with JSON only: {"san": "<one of the legal moves>"} or {"san": null}.',
  ].filter(Boolean).join("\n");
  try {
    const res = await converse({ modelId, messages: [{ role: "user", content: [{ text: prompt }] }], inferenceConfig: { temperature: 0, maxTokens: 40 } });
    const text = res.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
    const json = /\{[\s\S]*?\}/.exec(text)?.[0];
    const value = json ? JSON.parse(json).san : undefined;
    return { san: typeof value === "string" && legal.includes(value) ? value : undefined, usage: res.usage };
  } catch {
    return {};
  }
}
