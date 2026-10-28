import { z } from "zod";
import { attachmentSchema, formatResult, type ToolContext } from "./types.js";

const importSource = z.string().optional().describe("Label for the system the data came from (sent as x-import-source)");
const sourceHeaders = (source?: string) => (source ? { "x-import-source": source } : undefined);

const conversationImportSchema = z.object({
  external_id: z.string().max(255).optional().describe("Caller-supplied id used for deduplication"),
  subject: z.string().min(1),
  status: z.enum(["Open", "Pending", "Resolved", "Closed"]).optional().describe("Default Open"),
  priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional().describe("Default Medium"),
  requester: z.object({
    external_id: z.string().max(255).optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    name: z.string().optional().describe("Only used when the contact is created"),
  }).describe("At least one of external_id, email or phone is required"),
  assignee_email: z.string().email().optional().describe("Email of the agent the conversation was assigned to"),
  team_id: z.number().int().min(1).optional(),
  brand_id: z.number().int().min(1).optional().describe("Defaults to the account's default brand"),
  tags: z.array(z.string()).optional().describe("Tags to attach; also records channel/origin (e.g. chat, email)"),
  created_at: z.number().int().describe("Unix epoch seconds, not in the future. Backdates the conversation"),
  resolved_at: z.number().int().optional().describe("Unix epoch seconds >= created_at; only when status is Resolved or Closed"),
  description_html: z.string().min(1).describe("Opening message body (HTML)"),
  attachments: z.array(attachmentSchema).optional().describe("Files attached to the opening message"),
  custom_fields: z.array(z.object({
    field_id: z.number().int().min(1).describe("Conversation field id (from list_conversation_fields)"),
    value: z.union([z.string(), z.number(), z.boolean()])
      .describe("text/email/url -> string, number -> number, date -> epoch seconds, dropdown -> option id, boolean -> true/false"),
  })).optional(),
});

const replyImportSchema = z.object({
  external_id: z.string().max(255).optional().describe("Caller-supplied id used for deduplication"),
  author_type: z.enum(["agent", "requester"]),
  author_id: z.number().int().min(1).optional().describe("SparrowDesk author id (this or author_email is required)"),
  author_email: z.string().email().optional().describe("Author email (this or author_id is required)"),
  public: z.boolean().optional().describe("false makes it an internal note (default true)"),
  html_body: z.string().min(1).describe("Reply body (HTML)"),
  created_at: z.string().datetime({ offset: true }).describe("ISO-8601 timestamp with offset, not in the future"),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  attachments: z.array(attachmentSchema).optional(),
});

export function registerImportTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "import_conversation",
    {
      title: "Import conversation",
      description: "Import one historical conversation from another helpdesk, backdated to created_at. Sends no notifications. For new live tickets use create_conversation. Retrying without external_id creates a duplicate",
      annotations: { title: "Import conversation", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: { conversation: conversationImportSchema, import_source: importSource },
    },
    async ({ conversation, import_source }) => formatResult(await apiRequest(`${apiBase}/imports/conversations`, {
      method: "POST", body: { conversation }, headers: sourceHeaders(import_source),
    }))
  );

  server.registerTool(
    "bulk_import_conversations",
    {
      title: "Bulk import conversations",
      description: "Import many historical conversations in one request as a background job; returns a job_id to check with get_conversation_import_status. Sends no notifications. Retrying without external_id on each item creates duplicates",
      annotations: { title: "Bulk import conversations", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: { conversations: z.array(conversationImportSchema).min(1), import_source: importSource },
    },
    async ({ conversations, import_source }) => formatResult(await apiRequest(`${apiBase}/imports/conversations/create_many`, {
      method: "POST", body: { conversations }, headers: sourceHeaders(import_source),
    }))
  );

  server.registerTool(
    "get_conversation_import_status",
    {
      title: "Get conversation import status",
      description: "Get progress of a bulk conversation import job returned by bulk_import_conversations",
      annotations: { title: "Get conversation import status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { job_id: z.string().describe("Job id from bulk_import_conversations") },
    },
    async ({ job_id }) => formatResult(await apiRequest(`${apiBase}/imports/conversations/status/${encodeURIComponent(job_id)}`))
  );

  server.registerTool(
    "import_conversation_reply",
    {
      title: "Import conversation reply",
      description: "Import one historical reply into an existing conversation, backdated to created_at. Sends no email to the customer. For live replies use add_conversation_reply. Retrying without external_id creates a duplicate",
      annotations: { title: "Import conversation reply", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        conversation_id: z.number().int().describe("The SparrowDesk conversation ID"),
        reply: replyImportSchema,
        import_source: importSource,
      },
    },
    async ({ conversation_id, reply, import_source }) => formatResult(await apiRequest(`${apiBase}/imports/conversations/${conversation_id}/replies`, {
      method: "POST", body: { reply }, headers: sourceHeaders(import_source),
    }))
  );

  server.registerTool(
    "bulk_import_conversation_replies",
    {
      title: "Bulk import conversation replies",
      description: "Import many historical replies into one conversation as a background job; returns a jobId to check with get_reply_import_status. Sends no emails. Retrying without external_id on each item creates duplicates",
      annotations: { title: "Bulk import conversation replies", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: {
        conversation_id: z.number().int().describe("The SparrowDesk conversation ID"),
        replies: z.array(replyImportSchema).min(1).describe("Replies to import, oldest first"),
        import_source: importSource,
      },
    },
    async ({ conversation_id, replies, import_source }) => formatResult(await apiRequest(`${apiBase}/imports/conversations/${conversation_id}/replies/create_many`, {
      method: "POST", body: { replies }, headers: sourceHeaders(import_source),
    }))
  );

  server.registerTool(
    "get_reply_import_status",
    {
      title: "Get reply import status",
      description: "Get progress of a bulk reply import job returned by bulk_import_conversation_replies",
      annotations: { title: "Get reply import status", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: { job_id: z.string().describe("Job id from bulk_import_conversation_replies") },
    },
    async ({ job_id }) => formatResult(await apiRequest(`${apiBase}/imports/status/${encodeURIComponent(job_id)}`))
  );
}
