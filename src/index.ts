import crypto from "crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_BASE = (process.env.SPARROWDESK_API_BASE ?? "https://api.sparrowdesk.com/v1").replace(/\/$/, "");
const parsedPort = parseInt(process.env.PORT ?? "");
const PORT = Number.isNaN(parsedPort) ? 3000 : parsedPort;
const STATE_SECRET = process.env.STATE_SECRET ?? crypto.randomBytes(32).toString("hex");

const MCP_PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? "https://mcp.campaignsparrow.com").replace(/\/$/, "");
const SD_OAUTH_ISSUER = (process.env.SPARROWDESK_OAUTH_ISSUER ?? "").replace(/\/$/, "");
const SD_AUTHORIZE_URL = process.env.SPARROWDESK_OAUTH_AUTHORIZE_URL ?? `${SD_OAUTH_ISSUER}/oauth/authorize`;
const SD_TOKEN_URL = process.env.SPARROWDESK_OAUTH_TOKEN_URL ?? `${SD_OAUTH_ISSUER}/oauth/token`;
const SD_CLIENT_ID = process.env.SPARROWDESK_CLIENT_ID ?? "";
const SD_CLIENT_SECRET = process.env.SPARROWDESK_CLIENT_SECRET ?? "";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function signState(data: PendingAuth): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + STATE_TTL_MS })).toString("base64url");
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyState(token: string): PendingAuth | null {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedBuf = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest();
  const sigBuf = Buffer.from(sig, "base64url");
  // Fix: timingSafeEqual throws if lengths differ — check first
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as PendingAuth & { exp?: number };
    if (parsed.exp !== undefined && Date.now() > parsed.exp) return null;
    const { exp: _exp, ...rest } = parsed;
    return rest;
  } catch {
    return null;
  }
}

// OAuth state stored as signed tokens in the state parameter — works across multiple instances
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

const pendingCodes = new Map<string, PendingCode>();
const sessions = new Map<string, TokenSession>();
const sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function expireAfter(map: Map<string, unknown>, key: string, ms = 10 * 60 * 1000) {
  setTimeout(() => map.delete(key), ms);
}

function setSessionExpiry(mcpToken: string, ms: number) {
  const existing = sessionTimers.get(mcpToken);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    sessions.delete(mcpToken);
    sessionTimers.delete(mcpToken);
  }, ms);
  sessionTimers.set(mcpToken, handle);
}

async function refreshSession(mcpToken: string): Promise<TokenSession | null> {
  const session = sessions.get(mcpToken);
  if (!session) return null;
  if (Date.now() < session.expiresAt) return session;

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
    sessions.delete(mcpToken);
    return null;
  }

  const data = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  const expiresIn = (data.expires_in ?? 3600) * 1000;
  const updated: TokenSession = {
    sdToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt: Date.now() + expiresIn,
  };
  sessions.set(mcpToken, updated);
  setSessionExpiry(mcpToken, expiresIn);
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


function createServer(authToken: string) {
  const server = new McpServer({
    name: "sparrowdesk",
    version: "1.0.0",
  });

  async function apiRequest(url: string, options?: { method?: string; body?: unknown }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(url, {
        method: options?.method ?? "GET",
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
        requested_by: z.string().describe("Email or phone number of the requester"),
        priority: z.enum(["Low", "Medium", "High", "Urgent"]).optional().describe("Priority level (default: Medium)"),
        source: z.enum(["Mail", "Call"]).optional().describe("Source channel (default: Call)"),
        status: z.enum(["Open", "Pending", "Resolved", "Closed"]).optional().describe("Initial status (default: Open)"),
        brand_id: z.number().int().optional().describe("Brand ID (uses account default if omitted)"),
        assignee: z.email().optional().describe("Agent email address to assign the conversation to"),
        team_id: z.number().int().optional().describe("Team ID to assign the conversation to"),
        custom_fields: z.array(z.object({
          internal_name: z.string().describe("Custom field internal name"),
          value: z.unknown().describe("Custom field value"),
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
        email: z.email().optional().describe("Contact's email address (required if phone not provided)"),
        phone: z.string().optional().describe("Contact's phone number (required if email not provided)"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        custom_fields: z.record(z.string(), z.unknown()).optional().describe("Custom field key-value pairs"),
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
        email: z.email().optional().describe("Contact's email address"),
        phone: z.string().optional().describe("Contact's phone number"),
        company_id: z.number().int().optional().describe("ID of the company to associate the contact with"),
        blocked: z.boolean().optional().describe("Whether the contact is blocked"),
        custom_fields: z.record(z.string(), z.unknown()).optional().describe("Custom field key-value pairs"),
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
        page: z.number().int().optional().describe("Page number for pagination"),
        limit: z.number().int().optional().describe("Results per page"),
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

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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

// Dynamic client registration (RFC 7591) — client_id is a signed token encoding the
// redirect_uris so no server-side storage is needed (survives restarts and multi-instance).
function signClient(redirectUris: string[]): string {
  const payload = Buffer.from(JSON.stringify({ redirectUris })).toString("base64url");
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyClient(clientId: string): { redirectUris: string[] } | null {
  const dot = clientId.lastIndexOf(".");
  if (dot === -1) {
    console.error("verifyClient: no dot separator — likely old-format hex client_id");
    return null;
  }
  const payload = clientId.slice(0, dot);
  const sig = clientId.slice(dot + 1);
  const expectedBuf = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest();
  const sigBuf = Buffer.from(sig, "base64url");
  if (sigBuf.length !== expectedBuf.length) {
    console.error(`verifyClient: sig length mismatch (got ${sigBuf.length}, expected ${expectedBuf.length})`);
    return null;
  }
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    console.error("verifyClient: HMAC signature mismatch — STATE_SECRET likely differs between registration and this request");
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString()) as { redirectUris: string[] };
  } catch {
    console.error("verifyClient: payload JSON parse failed");
    return null;
  }
}

app.post(["/register", "/oauth/register", "/mcp/oauth/register"], (req, res) => {
  const { redirect_uris, client_name } = req.body as { redirect_uris?: string[]; client_name?: string };

  if (!redirect_uris?.length) {
    res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris required" });
    return;
  }

  // Spec: redirect URIs MUST be localhost or HTTPS
  const invalidUris = redirect_uris.filter((uri) => {
    try {
      const parsed = new URL(uri);
      const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
      return !isLoopback && parsed.protocol !== "https:";
    } catch {
      return true;
    }
  });
  if (invalidUris.length > 0) {
    res.status(400).json({ error: "invalid_redirect_uri", error_description: "Redirect URIs must be localhost or HTTPS" });
    return;
  }

  const clientId = signClient(redirect_uris);
  console.log(`OAuth client registered: ${client_name ?? "unknown"} — client_id prefix: ${clientId.slice(0, 40)}`);

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

app.get(["/authorize", "/oauth/authorize", "/mcp/oauth/authorize"], (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.query as Record<string, string>;

  if (!redirect_uri || !state) {
    res.status(400).json({ error: "invalid_request", error_description: "Missing redirect_uri or state" });
    return;
  }

  const client = client_id ? verifyClient(client_id) : undefined;
  if (!client) {
    console.error(`authorize: invalid client_id (len=${client_id?.length ?? 0}): ${client_id?.slice(0, 40)}...`);
    res.status(400).json({ error: "invalid_client", error_description: "Unknown or missing client_id" });
    return;
  }
  if (!client.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not registered for this client" });
    return;
  }

  if (!code_challenge) {
    res.status(400).json({ error: "invalid_request", error_description: "code_challenge required (S256)" });
    return;
  }

  const internalState = signState({
    clientRedirectUri: redirect_uri,
    clientState: state,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    scope,
  });

  const params = new URLSearchParams({
    client_id: SD_CLIENT_ID,
    redirect_uri: `${MCP_PUBLIC_URL}/oauth/callback`,
    response_type: "code",
    state: internalState,
    scope: scope || DEFAULT_SCOPE,
  });

  res.redirect(`${SD_AUTHORIZE_URL}?${params.toString()}`);
});

app.get(["/oauth/callback", "/mcp/oauth/callback"], async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    res.status(400).json({ error: "oauth_error", error_description: error });
    return;
  }

  const pending = verifyState(state);
  if (!pending) {
    res.status(400).json({ error: "invalid_request", error_description: "Invalid or expired state" });
    return;
  }

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
    console.error("Token exchange failed:", tokenRes.status, await tokenRes.text());
    res.status(502).json({ error: "server_error", error_description: "Token exchange failed" });
    return;
  }

  const tokenData = await tokenRes.json() as { access_token: string; refresh_token: string; expires_in?: number };
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

app.post(["/token", "/oauth/token", "/mcp/oauth/token"], (req, res) => {
  const { code, code_verifier, redirect_uri } = req.body as Record<string, string>;

  const pending = pendingCodes.get(code);
  if (!pending) {
    res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired code" });
    return;
  }

  if (pending.codeChallenge && pending.codeChallengeMethod === "S256") {
    if (!code_verifier) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
      return;
    }
    const challenge = crypto.createHash("sha256").update(code_verifier).digest().toString("base64url");
    if (challenge !== pending.codeChallenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
  }

  if (redirect_uri && redirect_uri !== pending.clientRedirectUri) {
    res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
    return;
  }

  pendingCodes.delete(code);
  const mcpToken = crypto.randomBytes(32).toString("hex");
  const expiresInMs = (pending.expiresIn ?? 3600) * 1000;
  sessions.set(mcpToken, {
    sdToken: pending.token,
    refreshToken: pending.refreshToken,
    expiresAt: Date.now() + expiresInMs,
  });
  setSessionExpiry(mcpToken, expiresInMs);
  res.json({ access_token: mcpToken, token_type: "Bearer", expires_in: pending.expiresIn ?? 3600 });
});

app.all("/mcp", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  const session = token ? await refreshSession(token) : null;
  if (!session) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${MCP_PUBLIC_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: "Valid OAuth token required" });
    return;
  }

  const server = createServer(session.sdToken);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SparrowDesk MCP server running on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
});
