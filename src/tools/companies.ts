import { z } from "zod";
import { formatResult, type ToolContext } from "./types.js";

export function registerCompanyTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "list_companies",
    {
      description: "List companies in the SparrowDesk account with optional filters and cursor pagination",
      annotations: { readOnlyHint: true },
      inputSchema: {
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        domain: z.string().optional().describe("Filter by exact company domain"),
        name: z.string().optional().describe("Filter by exact company name"),
      },
    },
    async ({ starting_after, per_page, domain, name }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      if (domain) params.set("domain", domain);
      if (name) params.set("name", name);
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/companies${query}`));
    }
  );

  server.registerTool(
    "get_company",
    {
      description: "Retrieve a company by ID from SparrowDesk",
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.number().int().describe("The company ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/companies/${id}`))
  );

  server.registerTool(
    "create_company",
    {
      description: "Create a new company in SparrowDesk",
      annotations: { destructiveHint: false },
      inputSchema: {
        name: z.string().describe("Company name"),
        domain: z.string().optional().describe("Lowercase domain like example.com or company.co.uk"),
        address: z.string().optional().describe("Company address"),
        notes: z.string().optional().describe("Free-form notes about the company"),
      },
    },
    async ({ name, domain, address, notes }) => {
      const body: Record<string, unknown> = { name };
      if (domain !== undefined) body.domain = domain;
      if (address !== undefined) body.address = address;
      if (notes !== undefined) body.notes = notes;
      return formatResult(await apiRequest(`${apiBase}/companies`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "update_company",
    {
      description: "Update an existing company in SparrowDesk",
      annotations: { destructiveHint: false },
      inputSchema: {
        id: z.number().int().describe("The company ID to update"),
        name: z.string().optional().describe("Company name"),
        domain: z.string().optional().describe("Lowercase domain like example.com or company.co.uk"),
        phone: z.string().optional().describe("Company phone number"),
        address: z.string().optional().describe("Company address"),
        notes: z.string().optional().describe("Free-form notes about the company"),
      },
    },
    async ({ id, name, domain, phone, address, notes }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (domain !== undefined) body.domain = domain;
      if (phone !== undefined) body.phone = phone;
      if (address !== undefined) body.address = address;
      if (notes !== undefined) body.notes = notes;
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text" as const, text: "Error: At least one field to update must be provided" }], isError: true };
      }
      return formatResult(await apiRequest(`${apiBase}/companies/${id}`, { method: "PATCH", body }));
    }
  );
}
