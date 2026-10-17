import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { applyOverrides, defaultSettings } from "./config.js";
import { presignTranscribeUrl, type Credentials } from "./presign.js";

const REGION = process.env.AWS_REGION ?? "ap-south-1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

/** Every issue is logged as one JSON line, so abuse shows up in CloudWatch Logs Insights. */
const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

export const credentialsFromEnv = (env = process.env): Credentials => ({
  accessKeyId: env.AWS_ACCESS_KEY_ID ?? "",
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "",
  sessionToken: env.AWS_SESSION_TOKEN,
});

/**
 * POST { sessionId } -> { url, expiresIn, mode, ... }: a presigned wss URL for Transcribe streaming.
 * The browser never sees AWS credentials, only this short-lived URL.
 *
 * Guards are deliberately cheap: a sessionId is required and the Origin must match when locked down.
 * TODO real rate limiting before this is public beyond the demo: per-sessionId and per-IP counters in DynamoDB
 * (TTL items), or CloudFront + WAF rate rules in front of the Function URL.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
  deps: { credentials?: () => Credentials | Promise<Credentials>; now?: () => Date } = {},
): Promise<APIGatewayProxyStructuredResultV2> {
  const origin = event.headers?.origin ?? event.headers?.Origin;
  const ip = event.requestContext?.http?.sourceIp;
  if (event.requestContext?.http?.method === "OPTIONS") return { statusCode: 204 };
  if (ALLOWED_ORIGIN !== "*" && origin !== ALLOWED_ORIGIN) {
    log("transcribe_url_denied", { reason: "origin", origin, ip });
    return json(403, { error: "origin not allowed" });
  }
  let body: Record<string, unknown> = {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    body = raw ? JSON.parse(raw) : {};
  } catch {
    log("transcribe_url_denied", { reason: "bad_json", origin, ip });
    return json(400, { error: "invalid JSON" });
  }
  const sessionId = body.sessionId;
  if (typeof sessionId !== "string" || sessionId.length < 8 || sessionId.length > 100) {
    log("transcribe_url_denied", { reason: "no_session", origin, ip });
    return json(400, { error: "sessionId is required" });
  }
  const settings = applyOverrides(defaultSettings(), body);
  const credentials = await (deps.credentials ?? credentialsFromEnv)();
  const url = await presignTranscribeUrl({ credentials, region: REGION, settings, now: deps.now?.() });
  log("transcribe_url_issued", { sessionId, origin, ip, mode: settings.mode, stability: settings.stability, vocab: settings.vocabularies.length });
  return json(200, { url, expiresIn: 300, mode: settings.mode, stability: settings.stability, sampleRate: settings.sampleRate });
}
