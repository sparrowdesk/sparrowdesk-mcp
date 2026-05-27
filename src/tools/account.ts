import { z } from "zod";
import { formatResult, type ToolContext } from "./types.js";

export function registerAccountTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "list_members",
    {
      description: "Retrieve a paginated list of all team members in the SparrowDesk account",
      annotations: { readOnlyHint: true },
      inputSchema: {
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
      },
    },
    async ({ starting_after, per_page }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page) params.set("per_page", String(per_page));
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/members${query}`));
    }
  );

  server.registerTool(
    "get_me",
    {
      description: "Retrieve current SparrowDesk account information (account id, subdomain, domain, company name, timezone, language)",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => formatResult(await apiRequest(`${apiBase}/me`))
  );

  server.registerTool(
    "list_tags",
    {
      description: "List conversation tags with optional search and pagination",
      annotations: { readOnlyHint: true },
      inputSchema: {
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
        search: z.string().optional().describe("Search tags by name"),
      },
    },
    async ({ starting_after, per_page, search }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      if (search) params.set("search", search);
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/tags${query}`));
    }
  );
}
