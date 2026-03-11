import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const API_BASE = "https://api.sparrowdesk.com/v1";
const API_KEY = process.env.SPARROWDESK_API_KEY;
if (!API_KEY) {
    console.error("Error: SPARROWDESK_API_KEY environment variable is required");
    process.exit(1);
}
async function apiRequest(url) {
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            "Content-Type": "application/json",
        },
    });
    const text = await response.text();
    if (!response.ok) {
        return { error: `Error ${response.status}: ${text}` };
    }
    try {
        return { data: JSON.parse(text) };
    }
    catch {
        return { error: `Unexpected response (status ${response.status}): ${text.slice(0, 500)}` };
    }
}
const server = new McpServer({
    name: "sparrowdesk",
    version: "1.0.0",
});
server.tool("get_conversation", "Retrieve a conversation by ID from SparrowDesk", {
    id: z.number().int().describe("The conversation ID"),
}, async ({ id }) => {
    const result = await apiRequest(`${API_BASE}/conversations/${id}`);
    if (result.error)
        return { content: [{ type: "text", text: result.error }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
});
server.tool("list_conversation_replies", "List all replies for a conversation in SparrowDesk", {
    id: z.number().int().describe("The conversation ID"),
    starting_after: z.string().optional().describe("Pagination cursor"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 25)"),
    type: z.enum(["INTERNAL_NOTE", "REPLY"]).optional().describe("Filter by reply type"),
    sort_order: z.enum(["asc", "desc"]).optional().describe("Sort order (default: desc)"),
}, async ({ id, starting_after, per_page, type, sort_order }) => {
    const params = new URLSearchParams();
    if (starting_after)
        params.set("starting_after", starting_after);
    if (per_page)
        params.set("per_page", String(per_page));
    if (type)
        params.set("type", type);
    if (sort_order)
        params.set("sort_order", sort_order);
    const query = params.toString() ? `?${params.toString()}` : "";
    const result = await apiRequest(`${API_BASE}/conversations/${id}/replies${query}`);
    if (result.error)
        return { content: [{ type: "text", text: result.error }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
});
server.tool("get_contact", "Retrieve a contact by ID from SparrowDesk", {
    id: z.number().int().describe("The contact ID"),
}, async ({ id }) => {
    const result = await apiRequest(`${API_BASE}/contacts/${id}`);
    if (result.error)
        return { content: [{ type: "text", text: result.error }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
