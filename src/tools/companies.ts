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
}
