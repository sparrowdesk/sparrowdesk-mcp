import { z } from "zod";
import { formatResult, type ToolContext } from "./types.js";

export function registerConversationTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "get_conversation",
    {
      description: "Retrieve a conversation (also called a ticket) by ID from SparrowDesk",
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.number().int().describe("The conversation ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/conversations/${id}`))
  );

  server.registerTool(
    "list_conversations",
    {
      description: "List conversations (also called tickets) from SparrowDesk with optional filters",
      annotations: { readOnlyHint: true },
      inputSchema: {
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        status: z.array(z.enum(["Open", "Pending", "Resolved", "Closed"])).optional().describe("Filter by status (can be multiple)"),
        priority: z.array(z.enum(["Low", "Medium", "High", "Urgent"])).optional().describe("Filter by priority (can be multiple)"),
        assigned_to_member_id: z.array(z.number().int()).optional().describe("Filter by assigned agent IDs"),
        assigned_to_team_id: z.array(z.number().int()).optional().describe("Filter by assigned team IDs"),
        brand_id: z.array(z.number().int()).optional().describe("Filter by brand IDs"),
        requested_by_id: z.number().int().optional().describe("Filter by requestor contact ID"),
        requested_by_company: z.number().int().optional().describe("Filter by requester contact company ID (intersects with requested_by_id when both are set)"),
        sort_by: z.enum(["created_at", "updated_at"]).optional().describe("Field to sort by (default: created_at)"),
        sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
      },
    },
    async ({ starting_after, per_page, status, priority, assigned_to_member_id, assigned_to_team_id, brand_id, requested_by_id, requested_by_company, sort_by, sort_order }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page) params.set("per_page", String(per_page));
      if (status) status.forEach((s) => params.append("status[]", s));
      if (priority) priority.forEach((p) => params.append("priority[]", p));
      if (assigned_to_member_id) assigned_to_member_id.forEach((id) => params.append("assigned_to_member_id[]", String(id)));
      if (assigned_to_team_id) assigned_to_team_id.forEach((id) => params.append("assigned_to_team_id[]", String(id)));
      if (brand_id) brand_id.forEach((id) => params.append("brand_id[]", String(id)));
      if (requested_by_id) params.set("requested_by_id", String(requested_by_id));
      if (requested_by_company !== undefined) params.set("requested_by_company", String(requested_by_company));
      if (sort_by) params.set("sort_by", sort_by);
      if (sort_order) params.set("sort_order", sort_order);

      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/conversations${query}`));
    }
  );

  server.registerTool(
    "list_conversations_with_replies",
    {
      description: "List conversations (tickets) with their replies inlined in one call. Uses the same filters as list_conversations. Root pages/total_count apply to conversations only; each row includes a replies object with the same shape as list_conversation_replies.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        starting_after: z.string().optional().describe("Cursor for conversation list pagination"),
        per_page: z.number().int().min(1).max(20).optional().describe("Conversations per page (1-20, default 20)"),
        replies_per_page: z.number().int().min(1).max(50).optional().describe("Replies per conversation (1-50, default 50)"),
        replies_sort_order: z.enum(["asc", "desc"]).optional().describe("Reply list sort by sent_at (default desc)"),
        type: z.enum(["INTERNAL_NOTE", "REPLY"]).optional().describe("Filter replies by type"),
        status: z.array(z.enum(["Open", "Pending", "Resolved", "Closed"])).optional().describe("Filter by status (can be multiple)"),
        priority: z.array(z.enum(["Low", "Medium", "High", "Urgent"])).optional().describe("Filter by priority (can be multiple)"),
        assigned_to_member_id: z.array(z.number().int()).optional().describe("Filter by assigned agent IDs"),
        assigned_to_team_id: z.array(z.number().int()).optional().describe("Filter by assigned team IDs"),
        brand_id: z.array(z.number().int()).optional().describe("Filter by brand IDs"),
        requested_by_id: z.number().int().optional().describe("Filter by requestor contact ID"),
        handled_by_ai_agent: z.boolean().optional().describe("Filter by whether the conversation was handled by the AI agent (omit for no filter)"),
        sort_by: z.enum(["created_at", "updated_at"]).optional().describe("Field to sort the conversation list by (default: created_at)"),
        sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order for the conversation list (default: desc)"),
      },
    },
    async ({ starting_after, per_page, replies_per_page, replies_sort_order, type, status, priority, assigned_to_member_id, assigned_to_team_id, brand_id, requested_by_id, handled_by_ai_agent, sort_by, sort_order }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page) params.set("per_page", String(per_page));
      if (replies_per_page) params.set("replies_per_page", String(replies_per_page));
      if (replies_sort_order) params.set("replies_sort_order", replies_sort_order);
      if (type) params.set("type", type);
      if (status) status.forEach((s) => params.append("status[]", s));
      if (priority) priority.forEach((p) => params.append("priority[]", p));
      if (assigned_to_member_id) assigned_to_member_id.forEach((id) => params.append("assigned_to_member_id[]", String(id)));
      if (assigned_to_team_id) assigned_to_team_id.forEach((id) => params.append("assigned_to_team_id[]", String(id)));
      if (brand_id) brand_id.forEach((id) => params.append("brand_id[]", String(id)));
      if (requested_by_id) params.set("requested_by_id", String(requested_by_id));
      if (handled_by_ai_agent !== undefined) params.set("handled_by_ai_agent", String(handled_by_ai_agent));
      if (sort_by) params.set("sort_by", sort_by);
      if (sort_order) params.set("sort_order", sort_order);

      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/conversations/with-replies${query}`));
    }
  );

  server.registerTool(
    "list_conversation_replies",
    {
      description: "List all replies for a conversation (also called a ticket) in SparrowDesk",
      annotations: { readOnlyHint: true },
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
      return formatResult(await apiRequest(`${apiBase}/conversations/${id}/replies${query}`));
    }
  );

  server.registerTool(
    "add_conversation_reply",
    {
      description: "Add a reply or internal note to a conversation (also called a ticket) in SparrowDesk",
      annotations: { destructiveHint: false },
      inputSchema: {
        id: z.number().int().describe("The conversation ID"),
        reply_text: z.string().describe("The content of the reply message"),
        type: z.enum(["REPLY", "INTERNAL_NOTE"]).describe("REPLY sends a response to the customer; INTERNAL_NOTE is an internal-only comment not visible to the requestor"),
      },
    },
    async ({ id, reply_text, type }) => formatResult(await apiRequest(`${apiBase}/conversations/${id}/reply`, {
      method: "POST",
      body: { reply_text, type },
    }))
  );

  server.registerTool(
    "create_conversation",
    {
      description: "Create a new conversation (also called a ticket) in SparrowDesk",
      annotations: { destructiveHint: false },
      inputSchema: {
        subject: z.string().describe("Conversation subject"),
        description: z.string().describe("Conversation description"),
        requested_by: z.union([
          z.string().email(),
          z.string().regex(/^\+?[\d\s\-().]{7,20}$/),
        ]).describe("Email or phone number of the requester"),
        priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional().describe("Priority level (default: Medium)"),
        source: z.enum(["Mail", "Call"]).optional().describe("Source channel (default: Call)"),
        status: z.enum(["Open", "Pending", "Resolved", "Closed"]).optional().describe("Initial status (default: Open)"),
        brand_id: z.number().int().optional().describe("Brand ID (uses account default if omitted)"),
        assignee: z.string().email().optional().describe("Agent email address to assign the conversation to"),
        team_id: z.number().int().optional().describe("Team ID to assign the conversation to"),
        custom_fields: z.array(z.object({
          internal_name: z.string().describe("Custom field internal name"),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]).describe("Custom field value"),
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

      return formatResult(await apiRequest(`${apiBase}/conversations`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "update_conversation",
    {
      description: "Update an existing conversation (subject, status, priority, assignment, custom fields)",
      annotations: { destructiveHint: false },
      inputSchema: {
        id: z.number().int().describe("The conversation ID"),
        subject: z.string().optional().describe("New subject"),
        priority: z.string().optional().describe("Priority (e.g. Low, Medium, High, Urgent)"),
        status: z.string().optional().describe("Status (e.g. Open, Pending, Resolved, Closed)"),
        assignee: z.string().email().optional().describe("Assignee agent email"),
        team: z.string().optional().describe("Team name or identifier per API"),
        custom_fields: z.array(z.object({
          internal_name: z.string(),
          value: z.string(),
        })).optional().describe("Custom field updates"),
      },
    },
    async ({ id, subject, priority, status, assignee, team, custom_fields }) => {
      const body: Record<string, unknown> = {};
      if (subject !== undefined) body.subject = subject;
      if (priority !== undefined) body.priority = priority;
      if (status !== undefined) body.status = status;
      if (assignee !== undefined) body.assignee = assignee;
      if (team !== undefined) body.team = team;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text" as const, text: "Error: At least one field to update must be provided" }], isError: true };
      }
      return formatResult(await apiRequest(`${apiBase}/conversations/${id}`, { method: "PATCH", body }));
    }
  );

  server.registerTool(
    "delete_conversation",
    {
      description: "Delete a conversation by ID from SparrowDesk",
      annotations: { destructiveHint: true },
      inputSchema: { id: z.number().int().describe("The conversation ID to delete") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/conversations/${id}`, { method: "DELETE" }))
  );

  server.registerTool(
    "list_conversation_fields",
    {
      description: "List conversation (ticket) custom fields",
      annotations: { readOnlyHint: true },
      inputSchema: {
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        is_active: z.boolean().optional().describe("Filter by active status"),
        is_default: z.boolean().optional().describe("Filter default fields only"),
      },
    },
    async ({ starting_after, per_page, is_active, is_default }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      if (is_active !== undefined) params.set("is_active", String(is_active));
      if (is_default !== undefined) params.set("is_default", String(is_default));
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/conversations/fields${query}`));
    }
  );

  server.registerTool(
    "get_conversation_field",
    {
      description: "Retrieve a single conversation field definition by ID",
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.number().int().describe("Conversation field ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/conversations/fields/${id}`))
  );

  server.registerTool(
    "create_conversation_field",
    {
      description: "Create a custom conversation field (dropdown types require field_options)",
      annotations: { destructiveHint: false },
      inputSchema: {
        name: z.string().describe("Display name"),
        type: z.enum(["single_line_text", "multi_line_text", "dropdown", "number", "date", "email"]).describe("Field type"),
        internal_name: z.string().optional().describe("Stable internal key (generated if omitted)"),
        description: z.string().optional().describe("Help text"),
        is_mandatory_on_close: z.boolean().optional().describe("Require before closing conversations"),
        field_options: z.array(z.string()).optional().describe("Allowed values for dropdown fields"),
      },
    },
    async ({ name, type, internal_name, description, is_mandatory_on_close, field_options }) => {
      const body: Record<string, unknown> = { name, type };
      if (internal_name !== undefined) body.internal_name = internal_name;
      if (description !== undefined) body.description = description;
      if (is_mandatory_on_close !== undefined) body.is_mandatory_on_close = is_mandatory_on_close;
      if (field_options !== undefined) body.field_options = field_options;
      return formatResult(await apiRequest(`${apiBase}/conversations/fields`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "update_conversation_field",
    {
      description: "Update a conversation field (name, description, active flag, dropdown options, etc.)",
      annotations: { destructiveHint: false },
      inputSchema: {
        id: z.number().int().describe("Conversation field ID"),
        name: z.string().optional(),
        description: z.string().optional(),
        is_active: z.boolean().optional(),
        is_mandatory_on_close: z.boolean().optional(),
        field_options: z.array(z.string()).optional().describe("Replace dropdown options (dropdown fields only)"),
      },
    },
    async ({ id, name, description, is_active, is_mandatory_on_close, field_options }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (is_active !== undefined) body.is_active = is_active;
      if (is_mandatory_on_close !== undefined) body.is_mandatory_on_close = is_mandatory_on_close;
      if (field_options !== undefined) body.field_options = field_options;
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text" as const, text: "Error: At least one field to update must be provided" }], isError: true };
      }
      return formatResult(await apiRequest(`${apiBase}/conversations/fields/${id}`, { method: "PATCH", body }));
    }
  );
}
