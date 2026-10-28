import { z } from "zod";
import { formatResult, type ToolContext } from "./types.js";

// Mirrors the per-request cap of the import endpoints (conversations and replies).
const MAX_IMPORT_ITEMS = 100;
// Each item becomes one API call, so keep a tool call well inside client timeouts.
const MAX_REPLY_TARGETS = 20;

const attachmentSchema = z.object({
  url: z.string().url().describe("Public URL the file is fetched from and re-hosted"),
  file_name: z.string().optional(),
  content_type: z.string().optional(),
  size: z.number().int().nonnegative().optional().describe("Size in bytes"),
  headers: z.record(z.string(), z.string()).optional().describe("Headers sent when fetching the URL (e.g. auth)"),
});

// The conversation import API takes epoch seconds; ISO strings are accepted here and converted.
const timestampSchema = z.union([
  z.number().int().describe("Unix epoch seconds"),
  z.iso.datetime({ offset: true }).describe("ISO-8601 timestamp with offset, e.g. 2026-10-01T09:30:00Z"),
]);

function toEpochSeconds(value: number | string) {
  return typeof value === "number" ? value : Math.floor(Date.parse(value) / 1000);
}

const conversationImportSchema = z.object({
  external_id: z.string().max(255).optional().describe("Your id for this conversation; a re-import with the same external_id is skipped"),
  subject: z.string().min(1),
  description_html: z.string().min(1).describe("Opening message body (HTML), sent by the requester"),
  requester: z.object({
    external_id: z.string().max(255).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    name: z.string().optional().describe("Applied only when the contact is created"),
  }).describe("At least one of external_id, email or phone; an existing contact is reused"),
  created_at: timestampSchema.describe("When the conversation was opened; must not be in the future"),
  status: z.enum(["Open", "Pending", "Resolved", "Closed"]).optional().describe("Default Open"),
  priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional().describe("Default Medium"),
  resolved_at: timestampSchema.optional().describe("Only with status Resolved/Closed; must be >= created_at"),
  assignee_email: z.string().email().optional().describe("Email of an existing agent"),
  team_id: z.number().int().positive().optional(),
  brand_id: z.number().int().positive().optional().describe("Account default brand if omitted"),
  tags: z.array(z.string()).optional().describe("Tag labels; missing tags are created. Also records channel/origin (e.g. chat, email)"),
  attachments: z.array(attachmentSchema).max(20).optional().describe("Files attached to the opening message"),
  custom_fields: z.array(z.object({
    field_id: z.number().int().positive().describe("Conversation field id (see list_conversation_fields)"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("Dropdown fields take the option id"),
  })).optional(),
});

const replyImportSchema = z.object({
  external_id: z.string().max(255).optional().describe("Your id for this reply; a re-import with the same external_id is skipped"),
  author_type: z.enum(["agent", "requester"]),
  author_email: z.string().email().optional().describe("Agent or requester email (give this or author_id)"),
  author_id: z.number().int().positive().optional().describe("SparrowDesk member or contact id (give this or author_email)"),
  public: z.boolean().optional().describe("false makes it an internal note (default true)"),
  html_body: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }).describe("ISO-8601 timestamp with offset; must not be in the future"),
  to: z.array(z.string().email()).optional(),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  attachments: z.array(attachmentSchema).max(20).optional(),
});

export function registerImportTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "import_conversations",
    {
      title: "Import conversations",
      description: "Import historical conversations (tickets) with backdated timestamps. No notifications, workflows or SLAs run. Returns a job_id - poll get_conversation_import_status for the created conversation ids, then add the thread with import_conversation_replies. Requires the edit all tickets scope.",
      annotations: { title: "Import conversations", readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        conversations: z.array(conversationImportSchema).min(1).max(MAX_IMPORT_ITEMS).describe(`Conversations to import (1-${MAX_IMPORT_ITEMS})`),
      },
    },
    async ({ conversations }) => {
      const body = {
        conversations: conversations.map((c) => ({
          ...c,
          created_at: toEpochSeconds(c.created_at),
          ...(c.resolved_at !== undefined && { resolved_at: toEpochSeconds(c.resolved_at) }),
        })),
      };
      return formatResult(await apiRequest(`${apiBase}/imports/conversations/create_many`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "get_conversation_import_status",
    {
      title: "Get conversation import status",
      description: "Get the status of a conversation import job: summary counts and, per conversation, its external_id, conversation_id and outcome",
      annotations: { title: "Get conversation import status", readOnlyHint: true },
      inputSchema: { job_id: z.string().describe("Job id returned by import_conversations") },
    },
    async ({ job_id }) => formatResult(await apiRequest(`${apiBase}/imports/conversations/status/${encodeURIComponent(job_id)}`))
  );

  server.registerTool(
    "import_conversation_replies",
    {
      title: "Import conversation replies",
      description: `Import historical replies and internal notes into existing conversations, backdated and authored by an agent or the requester. No notifications, workflows or SLAs run. Takes up to ${MAX_REPLY_TARGETS} conversations per call and returns one job_id per conversation (poll get_reply_import_status). Conversations are sent in order; if the rate limit is hit, the rest are returned as not_attempted to retry later. Requires the edit all tickets scope.`,
      annotations: { title: "Import conversation replies", readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        items: z.array(z.object({
          conversation_id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).describe("Conversation id, as returned by get_conversation_import_status or list_conversations"),
          replies: z.array(replyImportSchema).min(1).max(MAX_IMPORT_ITEMS).describe(`Replies for this conversation, oldest first (1-${MAX_IMPORT_ITEMS})`),
        })).min(1).max(MAX_REPLY_TARGETS).describe(`Conversations and their replies (1-${MAX_REPLY_TARGETS})`),
      },
    },
    async ({ items }) => {
      const results: Array<Record<string, unknown>> = [];
      let rateLimited = false;

      for (const { conversation_id, replies } of items) {
        if (rateLimited) {
          results.push({ conversation_id, status: "not_attempted" });
          continue;
        }
        const result = await apiRequest(`${apiBase}/imports/conversations/${encodeURIComponent(conversation_id)}/replies/create_many`, {
          method: "POST",
          body: { replies },
        });
        if (result.error) {
          rateLimited = result.error.startsWith("Error 429");
          results.push({ conversation_id, status: "error", error: result.error });
        } else {
          results.push({ conversation_id, status: "queued", job: (result.data as { data?: unknown })?.data ?? result.data });
        }
      }

      const failed = results.filter((r) => r.status !== "queued").length;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ rate_limited: rateLimited, results }, null, 2) }],
        isError: failed === results.length,
      };
    }
  );

  server.registerTool(
    "get_reply_import_status",
    {
      title: "Get reply import status",
      description: "Get the status of a reply import job returned by import_conversation_replies",
      annotations: { title: "Get reply import status", readOnlyHint: true },
      inputSchema: { job_id: z.string().describe("Job id returned by import_conversation_replies") },
    },
    async ({ job_id }) => formatResult(await apiRequest(`${apiBase}/imports/status/${encodeURIComponent(job_id)}`))
  );
}
