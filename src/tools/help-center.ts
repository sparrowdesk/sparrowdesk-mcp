import { z } from "zod";
import { formatResult, type ToolContext } from "./types.js";

export function registerHelpCenterTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "list_helpcenters",
    {
      title: "List help centers",
      description: "List Knowledge Base help centers for the account (needed for help_center_id on articles/collections)",
      annotations: { title: "List help centers", readOnlyHint: true },
      inputSchema: {
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 30)"),
      },
    },
    async ({ starting_after, per_page }) => {
      const params = new URLSearchParams();
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/helpcenters${query}`));
    }
  );

  server.registerTool(
    "list_articles",
    {
      title: "List Knowledge Base articles",
      description: "List KB articles for a help center; use published/draft/archived flags to filter lifecycle (requires VIEW_ARTICLES scope)",
      annotations: { title: "List Knowledge Base articles", readOnlyHint: true },
      inputSchema: {
        help_center_id: z.number().int().describe("Help center id from list_helpcenters"),
        published: z.boolean().optional().describe("Include published articles (omit all three flags to include every lifecycle bucket)"),
        draft: z.boolean().optional().describe("Include draft and under-review articles"),
        archived: z.boolean().optional().describe("Include archived articles"),
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Items per page (1-100, default 30)"),
        search: z.string().optional().describe("Search title and body"),
        collection_id: z.number().int().optional().describe("Restrict to a collection"),
      },
    },
    async ({ help_center_id, published, draft, archived, starting_after, per_page, search, collection_id }) => {
      const params = new URLSearchParams();
      params.set("help_center_id", String(help_center_id));
      if (published !== undefined) params.set("published", String(published));
      if (draft !== undefined) params.set("draft", String(draft));
      if (archived !== undefined) params.set("archived", String(archived));
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      if (search) params.set("search", search);
      if (collection_id !== undefined) params.set("collection_id", String(collection_id));
      return formatResult(await apiRequest(`${apiBase}/articles?${params.toString()}`));
    }
  );

  server.registerTool(
    "get_article",
    {
      title: "Get Knowledge Base article",
      description: "Get a single Knowledge Base article by ID (requires VIEW_ARTICLES scope)",
      annotations: { title: "Get Knowledge Base article", readOnlyHint: true },
      inputSchema: { id: z.number().int().describe("Article ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/articles/${id}`))
  );

  server.registerTool(
    "create_article",
    {
      title: "Create Knowledge Base article",
      description: "Create a KB article (draft). Set publish true with collection_id and is_public to publish in one step (requires MANAGE_ARTICLES scope)",
      annotations: { title: "Create Knowledge Base article", readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        help_center_id: z.number().int().describe("Help center id from list_helpcenters"),
        brand_id: z.number().int().describe("Brand id the article belongs to"),
        title: z.string().optional().describe("Article title"),
        content: z.string().optional().describe("HTML content (p, h1-h6, ul/ol/li, a, strong, em, img, video, YouTube iframe, table, code, blockquote); scripts and event attributes are stripped"),
        publish: z.boolean().optional().describe("When true, requires collection_id and is_public"),
        collection_id: z.number().int().optional().describe("Required when publish is true"),
        is_public: z.boolean().optional().describe("Required when publish is true"),
      },
    },
    async ({ help_center_id, brand_id, title, content, publish, collection_id, is_public }) => {
      const body: Record<string, unknown> = { help_center_id, brand_id };
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (publish !== undefined) body.publish = publish;
      if (collection_id !== undefined) body.collection_id = collection_id;
      if (is_public !== undefined) body.is_public = is_public;
      return formatResult(await apiRequest(`${apiBase}/articles`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "update_article",
    {
      title: "Update Knowledge Base article",
      description: "Update a KB article draft; set publish true with is_public to publish after save (requires MANAGE_ARTICLES scope)",
      annotations: { title: "Update Knowledge Base article", readOnlyHint: false, destructiveHint: true },
      inputSchema: {
        id: z.number().int().describe("Article ID"),
        title: z.string().optional().describe("Article title"),
        content: z.string().optional().describe("HTML content"),
        collection_id: z.number().int().nullable().optional().describe("Move to another collection; null removes from collection"),
        brand_id: z.number().int().optional().describe("Brand id the article belongs to"),
        publish: z.boolean().optional().describe("When true, publishes the article after saving"),
        is_public: z.boolean().optional().describe("Required when publish is true"),
        ai_agent_enabled: z.boolean().optional().describe("Allow the AI agent to use this article (ignored without AI privilege)"),
        ai_copilot_enabled: z.boolean().optional().describe("Allow AI copilot to use this article (ignored without AI privilege)"),
      },
    },
    async ({ id, title, content, collection_id, brand_id, publish, is_public, ai_agent_enabled, ai_copilot_enabled }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (collection_id !== undefined) body.collection_id = collection_id;
      if (brand_id !== undefined) body.brand_id = brand_id;
      if (publish !== undefined) body.publish = publish;
      if (is_public !== undefined) body.is_public = is_public;
      if (ai_agent_enabled !== undefined) body.ai_agent_enabled = ai_agent_enabled;
      if (ai_copilot_enabled !== undefined) body.ai_copilot_enabled = ai_copilot_enabled;
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text" as const, text: "Error: At least one field to update must be provided" }], isError: true };
      }
      return formatResult(await apiRequest(`${apiBase}/articles/${id}`, { method: "PUT", body }));
    }
  );

  server.registerTool(
    "archive_article",
    {
      title: "Archive Knowledge Base article",
      description: "Archive a Knowledge Base article (hidden from the help center, not deleted; requires MANAGE_ARTICLES scope)",
      annotations: { title: "Archive Knowledge Base article", readOnlyHint: false, destructiveHint: true },
      inputSchema: { id: z.number().int().describe("Article ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/articles/${id}/archive`, { method: "PATCH", body: {} }))
  );

  server.registerTool(
    "list_collections",
    {
      title: "List Knowledge Base collections",
      description: "List KB collections for a help center (root collections with nested sub_collections by default; use is_root or collection_id for other views; requires VIEW_COLLECTIONS scope)",
      annotations: { title: "List Knowledge Base collections", readOnlyHint: true },
      inputSchema: {
        help_center_id: z.number().int().describe("Help center id from list_helpcenters"),
        starting_after: z.string().optional().describe("Pagination cursor"),
        per_page: z.number().int().min(1).max(100).optional().describe("Top-level collections per page (1-100, default 30)"),
        collection_id: z.number().int().optional().describe("Parent collection ID - returns its direct children only"),
        is_root: z.boolean().optional().describe("When true without collection_id, only root collections (flat)"),
      },
    },
    async ({ help_center_id, starting_after, per_page, collection_id, is_root }) => {
      const params = new URLSearchParams();
      params.set("help_center_id", String(help_center_id));
      if (starting_after) params.set("starting_after", starting_after);
      if (per_page !== undefined) params.set("per_page", String(per_page));
      if (collection_id !== undefined) params.set("collection_id", String(collection_id));
      if (is_root !== undefined) params.set("is_root", String(is_root));
      return formatResult(await apiRequest(`${apiBase}/collections?${params.toString()}`));
    }
  );

  server.registerTool(
    "get_collection",
    {
      title: "Get Knowledge Base collection",
      description: "Get a KB collection by ID (requires VIEW_COLLECTIONS scope)",
      annotations: { title: "Get Knowledge Base collection", readOnlyHint: true },
      inputSchema: { id: z.number().int().describe("Collection ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/collections/${id}`))
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create Knowledge Base collection",
      description: "Create a KB collection under a help center (optionally nested under parent_collection_id; requires MANAGE_COLLECTIONS scope)",
      annotations: { title: "Create Knowledge Base collection", readOnlyHint: false, destructiveHint: false },
      inputSchema: {
        name: z.string().describe("Collection name"),
        help_center_id: z.number().int().describe("Help center id from list_helpcenters"),
        brand_id: z.number().int().describe("Brand id the collection belongs to"),
        description: z.string().optional().describe("Collection description"),
        parent_collection_id: z.number().int().optional().describe("Create as child of this collection"),
      },
    },
    async ({ name, help_center_id, brand_id, description, parent_collection_id }) => {
      const body: Record<string, unknown> = { name, help_center_id, brand_id };
      if (description !== undefined) body.description = description;
      if (parent_collection_id !== undefined) body.parent_collection_id = parent_collection_id;
      return formatResult(await apiRequest(`${apiBase}/collections`, { method: "POST", body }));
    }
  );
}
