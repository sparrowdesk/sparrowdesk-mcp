import { z } from "zod";
import { formatResult, type ToolContext } from "./types.js";

const customFieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export function registerContactTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "create_contact",
    {
      description: "Create a new contact in SparrowDesk. Either email or phone must be provided.",
      annotations: { destructiveHint: false },
      inputSchema: {
        first_name: z.string().describe("Contact's first name"),
        last_name: z.string().optional().describe("Contact's last name"),
        email: z.string().email().optional().describe("Contact's email address (required if phone not provided)"),
        phone: z.string().optional().describe("Contact's phone number (required if email not provided)"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        custom_fields: z.record(z.string(), customFieldValueSchema).optional().describe("Custom field key-value pairs"),
      },
    },
    async ({ first_name, last_name, email, phone, company_id, custom_fields }) => {
      if (!email && !phone) {
        return { content: [{ type: "text" as const, text: "Error: Either email or phone must be provided" }], isError: true };
      }
      const body: Record<string, unknown> = { first_name };
      if (last_name !== undefined) body.last_name = last_name;
      if (email !== undefined) body.email = email;
      if (phone !== undefined) body.phone = phone;
      if (company_id !== undefined) body.company_id = company_id;
      if (custom_fields !== undefined) body.custom_fields = custom_fields;

      return formatResult(await apiRequest(`${apiBase}/contacts`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "update_contact",
    {
      description: "Update an existing contact in SparrowDesk",
      annotations: { destructiveHint: false },
      inputSchema: {
        id: z.number().int().describe("The contact ID to update"),
        first_name: z.string().optional().describe("Contact's first name"),
        last_name: z.string().optional().describe("Contact's last name"),
        email: z.string().email().optional().describe("Contact's email address"),
        phone: z.string().optional().describe("Contact's phone number"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        blocked: z.boolean().optional().describe("Whether the contact is blocked"),
        custom_fields: z.record(z.string(), customFieldValueSchema).optional().describe("Custom field key-value pairs"),
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
        return { content: [{ type: "text" as const, text: "Error: At least one field to update must be provided" }], isError: true };
      }

      return formatResult(await apiRequest(`${apiBase}/contacts/${id}`, { method: "PATCH", body }));
    }
  );

  server.registerTool(
    "get_contact",
    {
      description: "Retrieve a contact by ID from SparrowDesk",
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.number().int().describe("The contact ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/contacts/${id}`))
  );

  server.registerTool(
    "list_contact_fields",
    {
      description: "Retrieve all contact fields from SparrowDesk",
      annotations: { readOnlyHint: true },
      inputSchema: {
        search: z.string().optional().describe("Search contact fields by name"),
        page: z.number().int().min(1).optional().describe("Page number for pagination"),
        limit: z.number().int().min(1).max(100).optional().describe("Results per page (1-100)"),
      },
    },
    async ({ search, page, limit }) => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (page) params.set("page", String(page));
      if (limit) params.set("limit", String(limit));
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/contact-fields${query}`));
    }
  );

  server.registerTool(
    "list_contacts",
    {
      description: "List contacts for the authenticated account (requires view contacts API scope)",
      annotations: { readOnlyHint: true },
      inputSchema: {
        search: z.string().optional().describe("Case-sensitive partial match on first name"),
        requested_by_email: z.string().email().optional().describe("Exact match on contact email"),
        requested_by_phone: z.string().optional().describe("Exact match on contact phone (E.164)"),
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
      },
    },
    async ({ search, requested_by_email, requested_by_phone, starting_after, per_page }) => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (requested_by_email) params.set("requested_by_email", requested_by_email);
      if (requested_by_phone) params.set("requested_by_phone", requested_by_phone);
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/contacts${query}`));
    }
  );

  server.registerTool(
    "delete_contact",
    {
      description: "Delete a contact by ID from SparrowDesk",
      annotations: { destructiveHint: true },
      inputSchema: { id: z.number().int().describe("The contact ID to delete") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/contacts/${id}`, { method: "DELETE" }))
  );

  const bulkContactItemSchema = z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    company_id: z.number().int().optional(),
    custom_fields: z.record(z.string(), customFieldValueSchema).optional(),
  });

  server.registerTool(
    "bulk_create_contacts",
    {
      description: "Create multiple contacts in one request; returns a job_id - poll get_bulk_job_status until completed",
      annotations: { destructiveHint: false },
      inputSchema: {
        contacts: z.array(bulkContactItemSchema).min(1).describe("Contacts to create (same shape as single create; API validates each row)"),
      },
    },
    async ({ contacts }) => formatResult(await apiRequest(`${apiBase}/bulk/contacts`, { method: "POST", body: contacts }))
  );

  server.registerTool(
    "get_bulk_job_status",
    {
      description: "Get processing status for a bulk contact creation job returned by bulk_create_contacts",
      annotations: { readOnlyHint: true },
      inputSchema: { job_id: z.string().describe("Bulk job id (e.g. from bulk_create_contacts response)") },
    },
    async ({ job_id }) => formatResult(await apiRequest(`${apiBase}/bulk/status/${encodeURIComponent(job_id)}`))
  );
}
