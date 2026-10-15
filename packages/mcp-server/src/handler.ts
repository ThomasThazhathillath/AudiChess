import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";

// Phase 1 stub: proves the Function URL, IAM and logging are wired up.
// Replaced by the Streamable HTTP MCP server in Phase 2.
export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      service: "mcp",
      method: event.requestContext.http.method,
      path: event.rawPath,
    }),
  };
};
