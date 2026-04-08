import crypto from "crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Startup validation — fail fast if required config is missing
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  "SPARROWDESK_CLIENT_ID",
  "SPARROWDESK_CLIENT_SECRET",
  "SPARROWDESK_OAUTH_ISSUER",
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[startup] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Log resolved config at startup so prod/staging differences are immediately visible in logs
console.log("[startup] Config:", JSON.stringify({
  API_BASE: process.env.SPARROWDESK_API_BASE ?? "(default)",
  MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL ?? "(default)",
  SD_OAUTH_ISSUER: process.env.SPARROWDESK_OAUTH_ISSUER,
  SD_AUTHORIZE_URL: process.env.SPARROWDESK_OAUTH_AUTHORIZE_URL ?? "(derived)",
  SD_TOKEN_URL: process.env.SPARROWDESK_OAUTH_TOKEN_URL ?? "(derived)",
  SD_CLIENT_ID: process.env.SPARROWDESK_CLIENT_ID,
  PORT: process.env.PORT ?? "(default 3000)",
}));

const API_BASE = (process.env.SPARROWDESK_API_BASE ?? "https://api.sparrowdesk.com/v1").replace(/\/$/, "");
const parsedPort = parseInt(process.env.PORT ?? "");
const PORT = Number.isNaN(parsedPort) ? 3000 : parsedPort;

const MCP_PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? "https://mcp.campaignsparrow.com").replace(/\/$/, "");
const SD_OAUTH_ISSUER = (process.env.SPARROWDESK_OAUTH_ISSUER ?? "").replace(/\/$/, "");
const SD_AUTHORIZE_URL = process.env.SPARROWDESK_OAUTH_AUTHORIZE_URL ?? `${SD_OAUTH_ISSUER}/oauth/authorize`;
const SD_TOKEN_URL = process.env.SPARROWDESK_OAUTH_TOKEN_URL ?? `${SD_OAUTH_ISSUER}/oauth/token`;
const SD_CLIENT_ID = process.env.SPARROWDESK_CLIENT_ID!;
const SD_CLIENT_SECRET = process.env.SPARROWDESK_CLIENT_SECRET!;

// Origins allowed to call the /mcp endpoint from a browser context.
// Non-browser MCP clients (Claude Desktop, Cursor, etc.) send no Origin header
// and are allowed through. Browser-originated requests must match this list.
const ALLOWED_ORIGINS = new Set([
  MCP_PUBLIC_URL,
  "http://localhost:3000",
]);


// Known OAuth error codes — only forward these to avoid reflecting attacker input
const KNOWN_OAUTH_ERRORS = new Set([
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "invalid_request",
  "invalid_scope",
  "unauthorized_client",
  "unsupported_response_type",
]);

// ---------------------------------------------------------------------------
// In-memory OAuth state — single-process only. With multiple replicas, dynamic
// client registration (/oauth/register) and the rest of the OAuth flow can land
// on different instances → "unknown client_id" and empty pendingAuth. Fix:
// run one replica, enable sticky sessions for this service, or add shared storage.
// ---------------------------------------------------------------------------
interface PendingAuth {
  clientRedirectUri: string;
  clientState: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  scope?: string;
}
interface PendingCode {
  token: string;
  refreshToken: string;
  expiresIn: number;
  clientRedirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}
interface TokenSession {
  sdToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}

const pendingAuth = new Map<string, PendingAuth>();
const pendingCodes = new Map<string, PendingCode>();
const sessions = new Map<string, TokenSession>();
const registeredClients = new Map<string, { redirectUris: string[] }>();

// Max sizes to prevent memory-exhaustion DoS
const MAX_REGISTERED_CLIENTS = 1000;
const MAX_PENDING_AUTH = 1000;
const MAX_PENDING_CODES = 1000;
const MAX_SESSIONS = 10000;

function expireAfter(map: Map<string, unknown>, key: string, ms = 10 * 60 * 1000) {
  setTimeout(() => map.delete(key), ms);
}

async function refreshSession(mcpToken: string): Promise<TokenSession | null> {
  const hint = mcpToken.slice(0, 8);
  const session = sessions.get(mcpToken);
  if (!session) {
    console.warn(`[session] token=${hint} not found in sessions map (size=${sessions.size})`);
    return null;
  }
  if (Date.now() < session.expiresAt) {
    return session;
  }

  const ttlLeft = session.expiresAt - Date.now();
  console.log(`[session] token=${hint} expired (ttl=${ttlLeft}ms), attempting refresh`);

  const tokenRes = await fetch(SD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: SD_CLIENT_ID,
      client_secret: SD_CLIENT_SECRET,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error(`[session] token=${hint} refresh failed status=${tokenRes.status} body=${body}`);
    sessions.delete(mcpToken);
    return null;
  }

  const data = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  const updated: TokenSession = {
    sdToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  sessions.set(mcpToken, updated);
  console.log(`[session] token=${hint} refreshed ok expires_in=${data.expires_in ?? 3600}s`);
  return updated;
}

const DEFAULT_SCOPE = [
  "MANAGE_CONTACTS",
  "VIEW_ALL_TICKETS",
  "VIEW_CONTACTS",
  "VIEW_OWN_TICKETS",
  "EDIT_OWN_TICKETS",
  "DELETE_OWN_TICKETS",
  "VIEW_ALL_TAGS",
  "EDIT_ALL_TICKETS",
  "DELETE_ALL_TICKETS",
  "VIEW_MEMBERS",
].join(" ");

const ALLOWED_SCOPES = new Set(DEFAULT_SCOPE.split(" "));

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------
function createServer(authToken: string, sessionHint: string) {
  const server = new McpServer({
    name: "sparrowdesk",
    version: "1.0.0",
  });

  async function apiRequest(url: string, options?: { method?: string; body?: unknown }) {
    const method = options?.method ?? "GET";
    console.log(JSON.stringify({ event: "api_call", session: sessionHint, method, url }));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(url, {
        method,
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
        email: z.string().email().optional().describe("Contact's email address (required if phone not provided)"),
        phone: z.string().optional().describe("Contact's phone number (required if email not provided)"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Custom field key-value pairs"),
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
        email: z.string().email().optional().describe("Contact's email address"),
        phone: z.string().optional().describe("Contact's phone number"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        blocked: z.boolean().optional().describe("Whether the contact is blocked"),
        custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().describe("Custom field key-value pairs"),
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

  server.registerTool(
    "list_contact_fields",
    {
      description: "Retrieve all contact fields from SparrowDesk",
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
      const result = await apiRequest(`${API_BASE}/contact-fields${query}`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_members",
    {
      description: "Retrieve a paginated list of all team members in the SparrowDesk account",
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
      const result = await apiRequest(`${API_BASE}/members${query}`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_me",
    {
      description: "Retrieve the currently authenticated member's profile from SparrowDesk",
      inputSchema: {},
    },
    async () => {
      const result = await apiRequest(`${API_BASE}/me`);
      if (result.error) return { content: [{ type: "text", text: result.error }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Always behind a reverse proxy (ALB, nginx, Kubernetes Ingress, etc.)
app.set("trust proxy", 1);
console.log("[startup] Express trust proxy:", app.get("trust proxy"));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
});
const mcpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// OAuth discovery endpoints
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: MCP_PUBLIC_URL,
    authorization_endpoint: `${MCP_PUBLIC_URL}/oauth/authorize`,
    token_endpoint: `${MCP_PUBLIC_URL}/oauth/token`,
    registration_endpoint: `${MCP_PUBLIC_URL}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// Dynamic client registration (RFC 7591)
app.post(["/oauth/register", "/mcp/oauth/register"], authLimiter, (req, res) => {
  const { redirect_uris, client_name } = req.body as { redirect_uris?: string[]; client_name?: string };

  console.log(`[register] client_name=${client_name ?? "(none)"} redirect_uris=${JSON.stringify(redirect_uris)}`);

  if (!redirect_uris?.length) {
    console.warn("[register] rejected: missing redirect_uris");
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
    return;
  }

  const ALLOWED_REDIRECT_SCHEMES = ["https:", "http:", "cursor:", "claude:"];
  const invalidUri = redirect_uris.find(uri => {
    try { return !ALLOWED_REDIRECT_SCHEMES.includes(new URL(uri).protocol); }
    catch { return true; }
  });
  if (invalidUri) {
    console.warn(`[register] rejected: invalid redirect_uri scheme uri=${invalidUri}`);
    res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uri scheme not allowed" });
    return;
  }

  if (registeredClients.size >= MAX_REGISTERED_CLIENTS) {
    console.warn(`[register] rejected: client cap reached (${registeredClients.size})`);
    res.status(429).json({ error: "too_many_requests", error_description: "Client registration limit reached" });
    return;
  }

  const clientId = crypto.randomBytes(16).toString("hex");
  registeredClients.set(clientId, { redirectUris: redirect_uris });
  expireAfter(registeredClients as Map<string, unknown>, clientId, 24 * 60 * 60 * 1000);
  console.log(`[register] ok client_id=${clientId} client_name=${client_name ?? "unknown"} redirect_uris=${JSON.stringify(redirect_uris)}`);

  res.status(201).json({
    client_id: clientId,
    client_secret_expires_at: 0,
    redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: MCP_PUBLIC_URL,
    authorization_servers: [MCP_PUBLIC_URL],
    bearer_methods_supported: ["header"],
  });
});

app.get(["/oauth/authorize", "/mcp/oauth/authorize"], authLimiter, (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.query as Record<string, string>;

  console.log(`[authorize] client_id=${client_id} redirect_uri=${redirect_uri} scope=${scope} pkce=${code_challenge_method ?? "none"} state=${state?.slice(0, 8)}`);

  if (!client_id) {
    console.warn("[authorize] rejected: missing client_id");
    res.status(400).json({ error: "invalid_request", error_description: "client_id required" });
    return;
  }

  const client = registeredClients.get(client_id);
  if (!client) {
    console.warn(`[authorize] rejected: unknown client_id=${client_id} (registered=${registeredClients.size})`);
    res.status(400).json({ error: "invalid_client", error_description: "Unknown client_id" });
    return;
  }

  if (!redirect_uri || !state) {
    console.warn(`[authorize] rejected: missing redirect_uri=${redirect_uri} or state=${state}`);
    res.status(400).json({ error: "invalid_request", error_description: "Missing redirect_uri or state" });
    return;
  }

  if (!client.redirectUris.includes(redirect_uri)) {
    console.warn(`[authorize] rejected: redirect_uri mismatch. got=${redirect_uri} allowed=${JSON.stringify(client.redirectUris)}`);
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered for this client" });
    return;
  }

  if (pendingAuth.size >= MAX_PENDING_AUTH) {
    console.warn(`[authorize] rejected: pendingAuth cap reached (${pendingAuth.size})`);
    res.status(429).json({ error: "too_many_requests" });
    return;
  }

  // Allowlist scope values — strip any unknown scopes, fall back to DEFAULT_SCOPE
  const requestedScopes = scope?.split(" ").filter((s) => ALLOWED_SCOPES.has(s)) ?? [];
  const finalScope = requestedScopes.length ? requestedScopes.join(" ") : DEFAULT_SCOPE;
  if (scope && requestedScopes.length !== scope.split(" ").length) {
    console.warn(`[authorize] scope filtered. requested=${scope} final=${finalScope}`);
  }

  const internalState = crypto.randomBytes(16).toString("hex");
  pendingAuth.set(internalState, {
    clientRedirectUri: redirect_uri,
    clientState: state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    scope: finalScope,
  });
  expireAfter(pendingAuth, internalState);

  const params = new URLSearchParams({
    client_id: SD_CLIENT_ID,
    redirect_uri: `${MCP_PUBLIC_URL}/oauth/callback`,
    response_type: "code",
    state: internalState,
    scope: finalScope,
  });

  const upstreamUrl = `${SD_AUTHORIZE_URL}?${params.toString()}`;
  console.log(`[authorize] ok redirecting to upstream state=${internalState.slice(0, 8)} url=${upstreamUrl}`);
  res.redirect(upstreamUrl);
});

app.get(["/oauth/callback", "/mcp/oauth/callback"], async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  console.log(`[callback] state=${state?.slice(0, 8)} code=${code ? "present" : "missing"} error=${error ?? "none"}`);

  if (error) {
    const safeError = KNOWN_OAUTH_ERRORS.has(error) ? error : "server_error";
    console.warn(`[callback] upstream returned error=${error} (sanitized to ${safeError})`);
    res.status(400).json({ error: safeError });
    return;
  }

  const pending = pendingAuth.get(state);
  if (!pending) {
    console.warn(`[callback] state=${state?.slice(0, 8)} not found in pendingAuth (size=${pendingAuth.size}) — likely expired or replayed`);
    res.status(400).json({ error: "invalid_request", error_description: "Invalid or expired state" });
    return;
  }
  pendingAuth.delete(state);

  console.log(`[callback] state ok, exchanging code with upstream url=${SD_TOKEN_URL} redirect_uri=${MCP_PUBLIC_URL}/oauth/callback`);

  const tokenRes = await fetch(SD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${MCP_PUBLIC_URL}/oauth/callback`,
      client_id: SD_CLIENT_ID,
      client_secret: SD_CLIENT_SECRET,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    console.error(`[callback] upstream token exchange failed status=${tokenRes.status} body=${text}`);
    res.status(502).json({ error: "server_error", error_description: "Token exchange failed" });
    return;
  }

  const tokenData = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in?: number };
  console.log(`[callback] upstream token exchange ok expires_in=${tokenData.expires_in ?? 3600}s has_refresh=${!!tokenData.refresh_token}`);

  if (pendingCodes.size >= MAX_PENDING_CODES) {
    console.warn(`[callback] pendingCodes cap reached (${pendingCodes.size})`);
    res.status(429).json({ error: "too_many_requests" });
    return;
  }

  const ourCode = crypto.randomBytes(16).toString("hex");
  pendingCodes.set(ourCode, {
    token: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in ?? 3600,
    clientRedirectUri: pending.clientRedirectUri,
    codeChallenge: pending.codeChallenge,
    codeChallengeMethod: pending.codeChallengeMethod,
  });
  expireAfter(pendingCodes, ourCode);

  const redirectUrl = new URL(pending.clientRedirectUri);
  redirectUrl.searchParams.set("code", ourCode);
  redirectUrl.searchParams.set("state", pending.clientState);
  const appUrl = redirectUrl.toString();
  console.log(`[callback] ok redirecting to client redirect_uri=${pending.clientRedirectUri}`);
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Connected to SparrowDesk</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; border-radius: 12px; padding: 48px 40px; text-align: center; max-width: 400px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; margin: 0 0 8px; color: #111; }
    p { color: #555; margin: 0 0 24px; line-height: 1.5; }
    a { display: inline-block; padding: 10px 20px; background: #0e7a6e; color: white; border-radius: 8px; text-decoration: none; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>Authorization successful</h1>
    <p>SparrowDesk is now connected. You can close this tab and return to your app.</p>
    <a href="${appUrl}">Return to app</a>
  </div>
  <script>window.location.href = ${JSON.stringify(appUrl)};</script>
</body>
</html>`);
});

app.post(["/oauth/token", "/mcp/oauth/token"], authLimiter, (req, res) => {
  const { code, code_verifier, redirect_uri } = req.body as Record<string, string>;

  console.log(`[token] code=${code?.slice(0, 8)} redirect_uri=${redirect_uri} pkce_verifier=${code_verifier ? "present" : "absent"}`);

  const pending = pendingCodes.get(code);
  if (!pending) {
    console.warn(`[token] code=${code?.slice(0, 8)} not found in pendingCodes (size=${pendingCodes.size}) — likely expired or already used`);
    res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired code" });
    return;
  }

  if (pending.codeChallenge && pending.codeChallengeMethod === "S256") {
    if (!code_verifier) {
      console.warn(`[token] code=${code?.slice(0, 8)} PKCE required but code_verifier missing`);
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
      return;
    }
    const challenge = crypto.createHash("sha256").update(code_verifier).digest().toString("base64url");
    if (challenge !== pending.codeChallenge) {
      console.warn(`[token] code=${code?.slice(0, 8)} PKCE mismatch computed=${challenge} expected=${pending.codeChallenge}`);
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
  }

  if (redirect_uri && redirect_uri !== pending.clientRedirectUri) {
    console.warn(`[token] code=${code?.slice(0, 8)} redirect_uri mismatch got=${redirect_uri} expected=${pending.clientRedirectUri}`);
    res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    return;
  }

  if (sessions.size >= MAX_SESSIONS) {
    console.warn(`[token] sessions cap reached (${sessions.size})`);
    res.status(429).json({ error: "too_many_requests" });
    return;
  }

  pendingCodes.delete(code);
  const mcpToken = crypto.randomBytes(32).toString("hex");
  sessions.set(mcpToken, {
    sdToken: pending.token,
    refreshToken: pending.refreshToken,
    expiresAt: Date.now() + (pending.expiresIn ?? 3600) * 1000,
  });
  console.log(`[token] ok session created token=${mcpToken.slice(0, 8)} expires_in=${pending.expiresIn ?? 3600}s`);
  res.json({ access_token: mcpToken, token_type: "Bearer" });
});

app.all("/mcp", mcpLimiter, async (req, res) => {
  const origin = req.headers.origin;
  const protocolVersion = req.headers["mcp-protocol-version"] as string | undefined;
  const authHeader = req.headers.authorization;

  console.log(`[mcp] ${req.method} origin=${origin ?? "(none)"} protocol-version=${protocolVersion ?? "(none)"} auth=${authHeader ? "present" : "missing"}`);

  // Origin header validation — prevents DNS rebinding attacks (MCP spec MUST requirement)
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    console.warn(`[mcp] rejected: invalid origin=${origin} allowed=${JSON.stringify([...ALLOWED_ORIGINS])}`);
    res.status(403).json({ error: "Forbidden: invalid Origin" });
    return;
  }



  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    console.warn("[mcp] rejected: no Bearer token in Authorization header");
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: "Valid OAuth token required" });
    return;
  }

  const session = await refreshSession(token);
  if (!session) {
    console.warn(`[mcp] rejected: token=${token.slice(0, 8)} not valid or refresh failed`);
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: "Valid OAuth token required" });
    return;
  }

  const sessionHint = token.slice(0, 8);
  console.log(`[mcp] session=${sessionHint} ok, handling ${req.method} request`);

  const server = createServer(session.sdToken, sessionHint);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SparrowDesk MCP server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});
