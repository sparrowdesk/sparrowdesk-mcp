import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_BASE = "https://api.sparrowdesk.com/v1";
const parsedPort = parseInt(process.env.PORT ?? "");
const PORT = Number.isNaN(parsedPort) ? 3000 : parsedPort;


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
      description: "Retrieve a conversation (also called a ticket) by ID from SparrowDesk",
      inputSchema: { id: z.number().int().describe("The conversation ID") },
    },
    async ({ id }) => {
      const result = await apiRequest(`${API_BASE}/conversations/${id}`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_conversations",
    {
      description: "List conversations (also called tickets) from SparrowDesk with optional filters",
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
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_conversation_replies",
    {
      description: "List all replies for a conversation (also called a ticket) in SparrowDesk",
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
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "add_conversation_reply",
    {
      description: "Add a reply or internal note to a conversation (also called a ticket) in SparrowDesk",
      inputSchema: {
        id: z.number().int().describe("The conversation ID"),
        reply_text: z.string().describe("The content of the reply message"),
        type: z.enum(["REPLY", "INTERNAL_NOTE"]).describe("REPLY sends a response to the customer; INTERNAL_NOTE is an internal-only comment not visible to the requestor"),
      },
    },
    async ({ id, reply_text, type }) => {
      const result = await apiRequest(`${API_BASE}/conversations/${id}/reply`, {
        method: "POST",
        body: { reply_text, type },
      });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "create_conversation",
    {
      description: "Create a new conversation (also called a ticket) in SparrowDesk",
      inputSchema: {
        subject: z.string().describe("Conversation subject"),
        description: z.string().describe("Conversation description"),
        requested_by: z.string().describe("Email or phone number of the requester"),
        priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional().describe("Priority level (default: Medium)"),
        source: z.enum(["Mail", "Call"]).optional().describe("Source channel (default: Call)"),
        status: z.enum(["Open", "Pending", "Resolved", "Closed"]).optional().describe("Initial status (default: Open)"),
        brand_id: z.number().int().optional().describe("Brand ID (uses account default if omitted)"),
        assignee: z.email().optional().describe("Agent email address to assign the conversation to"),
        team_id: z.number().int().optional().describe("Team ID to assign the conversation to"),
        custom_fields: z.array(z.object({
          internal_name: z.string().describe("Custom field internal name"),
          value: z.unknown().describe("Custom field value"),
        })).optional().describe("Custom field values"),
      },
    },
    async ({ subject, description, requested_by, priority, source, status, brand_id, assignee, team_id, custom_fields }) => {
      const body: Record<string, unknown> = { subject, description, requested_by };
      if (priority !== undefined) body.priority = priority;
      if (source !== undefined) body.source = source;
      if (status !== undefined) body.status = status;
      if (brand_id !== undefined) body.brand_id = brand_id;
      if (assignee !== undefined) body.assignee = assignee;
      if (team_id !== undefined) body.team_id = team_id;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;

      const result = await apiRequest(`${API_BASE}/conversations`, { method: "POST", body });
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
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
