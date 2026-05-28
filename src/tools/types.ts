import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
};

export type ApiResult =
  | { data: unknown; error?: never }
  | { error: string; data?: never };

export type ApiRequest = (url: string, options?: ApiRequestOptions) => Promise<ApiResult>;

export interface ToolContext {
  server: McpServer;
  apiRequest: ApiRequest;
  apiBase: string;
}

export function formatResult(result: ApiResult) {
  if (result.error) {
    return { content: [{ type: "text" as const, text: result.error }], isError: true };
  }

  return { content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }] };
}
