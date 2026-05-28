import { z } from "zod";
import { formatResult, type ToolContext } from "./types.js";

export function registerHelpCenterTools({ server, apiRequest, apiBase }: ToolContext) {
  server.registerTool(
    "list_helpcenters",
    {
      description: "List Knowledge Base help centers for the account (needed for helpCenterId on articles/collections)",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => formatResult(await apiRequest(`${apiBase}/helpcenters`))
  );

  server.registerTool(
    "list_articles",
    {
      description: "List KB articles for a help center; use published/draft/archived flags to filter lifecycle",
      annotations: { readOnlyHint: true },
      inputSchema: {
        helpCenterId: z.number().int().describe("Help center id from list_helpcenters"),
        published: z.boolean().optional().describe("Include published articles"),
        draft: z.boolean().optional().describe("Include draft and under-review articles"),
        archived: z.boolean().optional().describe("Include archived articles"),
        page: z.number().int().min(1).optional().describe("Page number (default 1)"),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 30, max 100)"),
        search: z.string().optional().describe("Search title and body"),
        collectionId: z.number().int().optional().describe("Restrict to a collection"),
      },
    },
    async ({ helpCenterId, published, draft, archived, page, limit, search, collectionId }) => {
      const params = new URLSearchParams();
      params.set("helpCenterId", String(helpCenterId));
      if (published !== undefined) params.set("published", String(published));
      if (draft !== undefined) params.set("draft", String(draft));
      if (archived !== undefined) params.set("archived", String(archived));
      if (page !== undefined) params.set("page", String(page));
      if (limit !== undefined) params.set("limit", String(limit));
      if (search) params.set("search", search);
      if (collectionId !== undefined) params.set("collectionId", String(collectionId));
      return formatResult(await apiRequest(`${apiBase}/articles?${params.toString()}`));
    }
  );

  server.registerTool(
    "get_article",
    {
      description: "Get a single Knowledge Base article by ID",
      annotations: { readOnlyHint: true },
      inputSchema: { id: z.number().int().describe("Article ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/articles/${id}`))
  );

  server.registerTool(
    "create_article",
    {
      description: "Create a KB article (draft). Set publish true with collectionId and isPublic to publish in one step",
      annotations: { destructiveHint: false },
      inputSchema: {
        helpCenterId: z.number().int(),
        brandId: z.number().int(),
        title: z.string().optional(),
        content: z.string().optional().describe("HTML content; server converts to internal format"),
        publish: z.boolean().optional().describe("When true, requires collectionId and isPublic"),
        collectionId: z.number().int().optional().describe("Required when publish is true"),
        isPublic: z.boolean().optional().describe("Required when publish is true"),
      },
    },
    async ({ helpCenterId, brandId, title, content, publish, collectionId, isPublic }) => {
      const body: Record<string, unknown> = { helpCenterId, brandId };
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (publish !== undefined) body.publish = publish;
      if (collectionId !== undefined) body.collectionId = collectionId;
      if (isPublic !== undefined) body.isPublic = isPublic;
      return formatResult(await apiRequest(`${apiBase}/articles`, { method: "POST", body }));
    }
  );

  server.registerTool(
    "update_article",
    {
      description: "Update a KB article draft; set publish true with isPublic to publish after save",
      annotations: { destructiveHint: false },
      inputSchema: {
        id: z.number().int().describe("Article ID"),
        title: z.string().optional(),
        content: z.string().optional().describe("HTML content"),
        collectionId: z.number().int().nullable().optional().describe("Move to another collection; null removes from collection"),
        brandId: z.number().int().optional(),
        publish: z.boolean().optional(),
        isPublic: z.boolean().optional().describe("Required when publish is true"),
        aiAgentEnabled: z.boolean().optional(),
        aiCopilotEnabled: z.boolean().optional(),
      },
    },
    async ({ id, title, content, collectionId, brandId, publish, isPublic, aiAgentEnabled, aiCopilotEnabled }) => {
      const body: Record<string, unknown> = {};
      if (title !== undefined) body.title = title;
      if (content !== undefined) body.content = content;
      if (collectionId !== undefined) body.collectionId = collectionId;
      if (brandId !== undefined) body.brandId = brandId;
      if (publish !== undefined) body.publish = publish;
      if (isPublic !== undefined) body.isPublic = isPublic;
      if (aiAgentEnabled !== undefined) body.aiAgentEnabled = aiAgentEnabled;
      if (aiCopilotEnabled !== undefined) body.aiCopilotEnabled = aiCopilotEnabled;
      if (Object.keys(body).length === 0) {
        return { content: [{ type: "text" as const, text: "Error: At least one field to update must be provided" }], isError: true };
      }
      return formatResult(await apiRequest(`${apiBase}/articles/${id}`, { method: "PUT", body }));
    }
  );

  server.registerTool(
    "archive_article",
    {
      description: "Archive a Knowledge Base article (hidden from the help center, not deleted)",
      annotations: { destructiveHint: false },
      inputSchema: { id: z.number().int().describe("Article ID") },
    },
    async ({ id }) => formatResult(await apiRequest(`${apiBase}/articles/${id}/archive`, { method: "PATCH", body: {} }))
  );

  server.registerTool(
    "list_collections",
    {
      description: "List KB collections for a help center (nested tree by default; use isRoot or collectionId for other views)",
      annotations: { readOnlyHint: true },
      inputSchema: {
        helpCenterId: z.number().int(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        collectionId: z.number().int().optional().describe("Parent collection ID - returns its direct children only"),
        isRoot: z.boolean().optional().describe("When true without collectionId, only root collections (flat)"),
      },
    },
    async ({ helpCenterId, page, limit, collectionId, isRoot }) => {
      const params = new URLSearchParams();
      params.set("helpCenterId", String(helpCenterId));
      if (page !== undefined) params.set("page", String(page));
      if (limit !== undefined) params.set("limit", String(limit));
      if (collectionId !== undefined) params.set("collectionId", String(collectionId));
      if (isRoot !== undefined) params.set("isRoot", String(isRoot));
      return formatResult(await apiRequest(`${apiBase}/collections?${params.toString()}`));
    }
  );

  server.registerTool(
    "get_collection",
    {
      description: "Get a KB collection by ID with direct subcollections and paginated articles",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: z.number().int().describe("Collection ID"),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ id, page, limit }) => {
      const params = new URLSearchParams();
      if (page !== undefined) params.set("page", String(page));
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString() ? `?${params.toString()}` : "";
      return formatResult(await apiRequest(`${apiBase}/collections/${id}${query}`));
    }
  );

  server.registerTool(
    "create_collection",
    {
      description: "Create a KB collection under a help center (optionally nested under parentCollectionId)",
      annotations: { destructiveHint: false },
      inputSchema: {
        name: z.string(),
        helpCenterId: z.number().int(),
        brandId: z.number().int(),
        description: z.string().optional(),
        parentCollectionId: z.number().int().optional().describe("Create as child of this collection"),
      },
    },
    async ({ name, helpCenterId, brandId, description, parentCollectionId }) => {
      const body: Record<string, unknown> = { name, helpCenterId, brandId };
      if (description !== undefined) body.description = description;
      if (parentCollectionId !== undefined) body.parentCollectionId = parentCollectionId;
      return formatResult(await apiRequest(`${apiBase}/collections`, { method: "POST", body }));
    }
  );
}
