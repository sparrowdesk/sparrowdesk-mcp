import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_BASE = "https://api.sparrowdesk.com/v1";
const parsedPort = parseInt(process.env.PORT ?? "");
const PORT = Number.isNaN(parsedPort) ? 3000 : parsedPort;

interface ContactResponse {
  id: number;
  full_name: string;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  blocked: boolean;
}

interface ConversationResponse {
  id: number;
  subject: string;
  status: string;
  priority: string;
  source: string;
  requested_by_email: string;
  assigned_to_member_id: number | null;
  assigned_to_team_id: number | null;
  created_at: number;
}

interface ReplyResponse {
  id: string;
  type: string;
  author: { name?: string; email?: string } | null;
  body_text: string;
  sent_at: number;
}

function truncate(s: string | null | undefined, max = 120): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function toContactMinimal(c: ContactResponse) {
  return {
    id: c.id,
    name: c.full_name,
    email: c.email ?? null,
    phone: c.phone ?? null,
    company: c.company_name ?? null,
    blocked: c.blocked,
  };
}

function toConversationMinimal(c: ConversationResponse) {
  return {
    id: c.id,
    subject: truncate(c.subject, 80),
    status: c.status,
    priority: c.priority,
    source: c.source,
    contact_email: c.requested_by_email,
    assigned_to_member_id: c.assigned_to_member_id ?? null,
    assigned_to_team_id: c.assigned_to_team_id ?? null,
    created_at: c.created_at,
  };
}

function toReplyMinimal(r: ReplyResponse) {
  return {
    id: r.id,
    type: r.type,
    author: r.author?.name ?? r.author?.email ?? null,
    body: truncate(r.body_text, 300),
    sent_at: r.sent_at,
  };
}

function conversationsToMarkdown(conversations: ConversationResponse[]): string {
  if (conversations.length === 0) return "No conversations found.";
  const rows = conversations.map((c) => {
    const subject = truncate(c.subject, 60).replace(/\|/g, "\\|");
    return `| ${c.id} | ${subject} | ${c.status} | ${c.priority} | ${c.requested_by_email} |`;
  });
  return [
    "| ID | Subject | Status | Priority | Contact |",
    "|----|---------|--------|----------|---------|",
    ...rows,
  ].join("\n");
}

function repliesToMarkdown(replies: ReplyResponse[]): string {
  if (replies.length === 0) return "No replies found.";
  const rows = replies.map((r) => {
    const author = (r.author?.name ?? r.author?.email ?? "unknown").replace(/\|/g, "\\|");
    const body = truncate(r.body_text, 200).replace(/\|/g, "\\|").replace(/\n/g, " ");
    return `| ${r.id} | ${r.type} | ${author} | ${body} | ${r.sent_at} |`;
  });
  return [
    "| ID | Type | Author | Body | Sent At |",
    "|----|------|--------|------|---------|",
    ...rows,
  ].join("\n");
}

function createServer(authToken: string) {
  const server = new McpServer({
    name: "sparrowdesk",
    version: "1.0.0",
  });

  async function apiRequest(url: string, options?: { method?: string; body?: unknown }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(url, {
        method: options?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        return { error: `Error ${response.status}: ${text}` };
      }

      try {
        return { data: JSON.parse(text) };
      } catch {
        return { error: `Unexpected response (status ${response.status}): ${text.slice(0, 500)}` };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { error: "Request timed out after 10 seconds" };
      }
      console.error("apiRequest failed:", err);
      return { error: "Unexpected error contacting SparrowDesk API" };
    } finally {
      clearTimeout(timeout);
    }
  }

  server.registerTool(
    "get_conversation",
    {
      description: "Retrieve a conversation by ID from SparrowDesk",
      inputSchema: { id: z.number().int().describe("The conversation ID") },
    },
    async ({ id }) => {
      const result = await apiRequest(`${API_BASE}/conversations/${id}`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toConversationMinimal(result.data), null, 2) }] };
    }
  );

  server.registerTool(
    "list_conversations",
    {
      description: "List conversations from SparrowDesk with optional filters",
      inputSchema: {
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        status: z.array(z.enum(["Open", "Pending", "Resolved", "Closed"])).optional().describe("Filter by status (can be multiple)"),
        priority: z.array(z.enum(["Low", "Medium", "High", "Urgent"])).optional().describe("Filter by priority (can be multiple)"),
        assigned_to_member_id: z.array(z.number().int()).optional().describe("Filter by assigned agent IDs"),
        assigned_to_team_id: z.array(z.number().int()).optional().describe("Filter by assigned team IDs"),
        brand_id: z.array(z.number().int()).optional().describe("Filter by brand IDs"),
        requested_by_id: z.number().int().optional().describe("Filter by requestor contact ID"),
        sort_by: z.enum(["created_at", "updated_at"]).optional().describe("Field to sort by (default: created_at)"),
        sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
      },
    },
    async ({ starting_after, per_page, status, priority, assigned_to_member_id, assigned_to_team_id, brand_id, requested_by_id, sort_by, sort_order }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page) params.set("per_page", String(per_page));
      if (status) status.forEach((s) => params.append("status[]", s));
      if (priority) priority.forEach((p) => params.append("priority[]", p));
      if (assigned_to_member_id) assigned_to_member_id.forEach((id) => params.append("assigned_to_member_id[]", String(id)));
      if (assigned_to_team_id) assigned_to_team_id.forEach((id) => params.append("assigned_to_team_id[]", String(id)));
      if (brand_id) brand_id.forEach((id) => params.append("brand_id[]", String(id)));
      if (requested_by_id) params.set("requested_by_id", String(requested_by_id));
      if (sort_by) params.set("sort_by", sort_by);
      if (sort_order) params.set("sort_order", sort_order);

      const query = params.toString() ? `?${params.toString()}` : "";
      const result = await apiRequest(`${API_BASE}/conversations${query}`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      const table = conversationsToMarkdown(result.data.data ?? []);
      const cursor = result.data.pages?.next_cursor ? ` | next_cursor: ${result.data.pages.next_cursor}` : "";
      const meta = `Total: ${result.data.total_count ?? "?"}${cursor}`;
      return { content: [{ type: "text", text: `${meta}\n\n${table}` }] };
    }
  );

  server.registerTool(
    "list_conversation_replies",
    {
      description: "List all replies for a conversation in SparrowDesk",
      inputSchema: {
        id: z.number().int().describe("The conversation ID"),
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        type: z.enum(["INTERNAL_NOTE", "REPLY"]).optional().describe("Filter by reply type"),
        sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
      },
    },
    async ({ id, starting_after, per_page, type, sort_order }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page) params.set("per_page", String(per_page));
      if (type) params.set("type", type);
      if (sort_order) params.set("sort_order", sort_order);

      const query = params.toString() ? `?${params.toString()}` : "";
      const result = await apiRequest(`${API_BASE}/conversations/${id}/replies${query}`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      const table = repliesToMarkdown(result.data.data ?? []);
      const cursor = result.data.pages?.next_cursor ? ` | next_cursor: ${result.data.pages.next_cursor}` : "";
      const meta = `Total: ${result.data.total_count ?? "?"}${cursor}`;
      return { content: [{ type: "text", text: `${meta}\n\n${table}` }] };
    }
  );

  server.registerTool(
    "create_contact",
    {
      description: "Create a new contact in SparrowDesk. Either email or phone must be provided.",
      inputSchema: {
        first_name: z.string().describe("Contact's first name"),
        last_name: z.string().optional().describe("Contact's last name"),
        email: z.email().optional().describe("Contact's email address (required if phone not provided)"),
        phone: z.string().optional().describe("Contact's phone number (required if email not provided)"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        custom_fields: z.record(z.string(), z.unknown()).optional().describe("Custom field key-value pairs"),
      },
    },
    async ({ first_name, last_name, email, phone, company_id, custom_fields }) => {
      if (!email && !phone) {
        return { content: [{ type: "text", text: "Error: Either email or phone must be provided" }], isError: true };
      }
      const body: Record<string, unknown> = { first_name };
      if (last_name !== undefined) body.last_name = last_name;
      if (email !== undefined) body.email = email;
      if (phone !== undefined) body.phone = phone;
      if (company_id !== undefined) body.company_id = company_id;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;

      const result = await apiRequest(`${API_BASE}/contacts`, { method: "POST", body });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toContactMinimal(result.data), null, 2) }] };
    }
  );

  server.registerTool(
    "update_contact",
    {
      description: "Update an existing contact in SparrowDesk",
      inputSchema: {
        id: z.number().int().describe("The contact ID to update"),
        first_name: z.string().optional().describe("Contact's first name"),
        last_name: z.string().optional().describe("Contact's last name"),
        email: z.email().optional().describe("Contact's email address"),
        phone: z.string().optional().describe("Contact's phone number"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        blocked: z.boolean().optional().describe("Whether the contact is blocked"),
        custom_fields: z.record(z.string(), z.unknown()).optional().describe("Custom field key-value pairs"),
      },
    },
    async ({ id, first_name, last_name, email, phone, company_id, blocked, custom_fields }) => {
      const body: Record<string, unknown> = {};
      if (first_name !== undefined) body.first_name = first_name;
      if (last_name !== undefined) body.last_name = last_name;
      if (email !== undefined) body.email = email;
      if (phone !== undefined) body.phone = phone;
      if (company_id !== undefined) body.company_id = company_id;
      if (blocked !== undefined) body.blocked = blocked;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;

      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text", text: "Error: At least one field to update must be provided" }], isError: true };
      }

      const result = await apiRequest(`${API_BASE}/contacts/${id}`, { method: "PATCH", body });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toContactMinimal(result.data), null, 2) }] };
    }
  );

  server.registerTool(
    "get_contact",
    {
      description: "Retrieve a contact by ID from SparrowDesk",
      inputSchema: { id: z.number().int().describe("The contact ID") },
    },
    async ({ id }) => {
      const result = await apiRequest(`${API_BASE}/contacts/${id}`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toContactMinimal(result.data), null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.all("/mcp", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: "Authorization header with Bearer token is required" });
    return;
  }

  const server = createServer(token);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SparrowDesk MCP server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});
