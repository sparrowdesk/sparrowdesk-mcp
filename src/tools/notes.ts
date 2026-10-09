import { z } from "zod";
import { formatResult, noteSchema, type ToolContext } from "./types.js";

const parentType = z.enum(["contact", "company"]).describe("Whether the note belongs to a contact or a company");
const listPath = { contact: "contacts", company: "companies" } as const;
const notePath = { contact: "contact-notes", company: "company-notes" } as const;

export function registerNoteTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List notes on a contact or company",
      annotations: { title: "List notes", readOnlyHint: true },
      inputSchema: {
        parent_type: parentType,
        parent_id: z.number().int().describe("Contact or company ID"),
        starting_after: z.string().optional().describe("Pagination cursor (pages.next_cursor from a previous response)"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
      },
    },
    async ({ parent_type, parent_id, starting_after, per_page }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/${listPath[parent_type]}/${parent_id}/notes${query}`));
    }
  );

  server.registerTool(
    "get_note",
    {
      title: "Get note",
      description: "Retrieve a contact or company note by ID",
      annotations: { title: "Get note", readOnlyHint: true },
      inputSchema: { parent_type: parentType, id: z.number().int().describe("Note ID") },
    },
    async ({ parent_type, id }) => formatResult(await apiRequest(`${apiBase}/${notePath[parent_type]}/${id}`))
  );

  server.registerTool(
    "create_note",
    {
      title: "Create note",
      description: "Create a note on a contact or company (requires an API key bound to a member)",
      annotations: { title: "Create note", readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        parent_type: parentType,
        parent_id: z.number().int().describe("Contact or company ID"),
        ...noteSchema.shape,
      },
    },
    async ({ parent_type, parent_id, title, description, attachments }) => {
      const body: Record<string, unknown> = { description };
      if (title !== undefined) body.title = title;
      if (attachments !== undefined) body.attachments = attachments;
      return formatResult(await apiRequest(`${apiBase}/${listPath[parent_type]}/${parent_id}/notes`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "update_note",
    {
      title: "Update note",
      description: "Update a contact or company note; only fields sent are changed. Sending attachments replaces the whole set - include the SparrowDesk URLs of attachments to keep",
      annotations: { title: "Update note", readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        parent_type: parentType,
        id: z.number().int().describe("Note ID"),
        ...noteSchema.partial().shape,
      },
    },
    async ({ parent_type, id, title, description, attachments }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (attachments !== undefined) body.attachments = attachments;
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text" as const, text: "Error: At least one field to update must be provided" }], isError: true };
      }
      return formatResult(await apiRequest(`${apiBase}/${notePath[parent_type]}/${id}`, { method: "PATCH", body }));
    }
  );

  server.registerTool(
    "delete_note",
    {
      title: "Delete note",
      description: "Delete a contact or company note by ID",
      annotations: { title: "Delete note", readOnlyHint: false, destructiveHint: true },
      inputSchema: { parent_type: parentType, id: z.number().int().describe("Note ID") },
    },
    async ({ parent_type, id }) => formatResult(await apiRequest(`${apiBase}/${notePath[parent_type]}/${id}`, { method: "DELETE" }))
  );
}
