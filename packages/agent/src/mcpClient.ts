import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  isError: boolean;
  data: Record<string, unknown>;
}

export interface ChessTools {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

/**
 * MCP client for the alexa_chess server over Streamable HTTP. The connection (initialize handshake)
 * and the tool list are cached for the life of the Lambda container; the server is stateless, so a
 * dropped connection is simply re-established.
 */
export class McpChessTools implements ChessTools {
  private client?: Promise<Client>;
  private tools?: McpTool[];

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string>,
  ) {}

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const token = await this.getToken();
      const client = new Client({ name: "alexa_chess_agent", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(this.url), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    })().catch((err) => {
      this.client = undefined;
      throw err;
    });
    return this.client;
  }

  private async withRetry<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.connect());
    } catch (err) {
      // One reconnect: covers containers whose cached connection went stale.
      this.client = undefined;
      return fn(await this.connect());
    }
  }

  async listTools(): Promise<McpTool[]> {
    this.tools ??= await this.withRetry(async (c) => (await c.listTools()).tools as McpTool[]);
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const res = await this.withRetry((c) => c.callTool({ name, arguments: args }));
    let data = res.structuredContent as Record<string, unknown> | undefined;
    if (!data) {
      const text = (res.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "{}";
      try {
        data = JSON.parse(text);
      } catch {
        data = { speech: text };
      }
    }
    return { isError: res.isError === true, data: data ?? {} };
  }
}
