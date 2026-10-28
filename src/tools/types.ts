import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ApiRequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
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

export const attachmentSchema = z.object({
  url: z.string().url().describe("Public URL the file is fetched from and re-hosted"),
  file_name: z.string().optional(),
  content_type: z.string().optional(),
  size: z.number().int().min(0).optional(),
});

export const noteSchema = z.object({
  title: z.string().optional().describe("Note title"),
  description: z.string().describe("Note body in Markdown (max 10000 characters of prose)"),
  attachments: z.array(attachmentSchema).max(20).optional().describe("Up to 20 files fetched from these URLs"),
});
