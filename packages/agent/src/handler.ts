import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";

// Phase 1 stub: proves the Function URL, CORS and IAM are wired up.
// Replaced by the Bedrock + MCP client agent in Phase 3.
export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      service: "agent",
      mcpUrl: process.env.MCP_URL,
      method: event.requestContext.http.method,
    }),
  };
};
