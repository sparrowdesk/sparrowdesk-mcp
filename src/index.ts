import crypto from "crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools/index.js";

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
  "VIEW_COLLECTIONS",
  "MANAGE_COLLECTIONS",
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

  registerAllTools({ server, apiRequest, apiBase: API_BASE });

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

app.get("/", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SparrowDesk MCP</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: "SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 24px;
    }
    pre.logo {
      font-size: clamp(4px, 1vw, 9px);
      line-height: 1.1;
      color: #0e7a6e;
      letter-spacing: 0;
      white-space: pre;
      user-select: none;
    }
    .content {
      margin-top: 40px;
      text-align: center;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      color: #ffffff;
      letter-spacing: 0.04em;
      margin-bottom: 24px;
    }
    .divider {
      width: 40px;
      height: 2px;
      background: #0e7a6e;
      margin: 0 auto 24px;
    }
    .links {
      display: flex;
      flex-direction: column;
      gap: 12px;
      align-items: center;
    }
    .links a {
      color: #0e7a6e;
      text-decoration: none;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: color 0.15s;
    }
    .links a:hover { color: #14a899; }
    .links .label {
      color: #666;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <pre class="logo">
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:::::::::::::::::::::::::::::::::::::::::::::::::::::               .:::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::                     .::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::                         :::::::::::::::::::::::::::
:::::::::::::::::::::::::::::::::::::::::::::::          .:::::.              .:::::::::::::::::::::
:::::::::::::::::::::::::::::::::::::::::::::::::::.. .:::::::::::.           .:::::::::::::::::::::
::::::::::::::::::::::.                ..:::::::::::::::::::::::::::         :::::::::::::::::::::::
::::::::::::::::::::::                         .:::::::::::::::::::::      :::::::::::::::::::::::::
:::::::::::::::::::::.                             .:::::::::::::::::.   :::::::::::::::::::::::::::
:::::::::::::::::::::                                 .::::::::::::::. :::::::::::::::::::::::::::::
:::::::::::::::::::::                                   .:::::::::::    ::::::::::::::::::::::::::::
:::::::::::::::::::::                                     .:::::::      .:::::::::::::::::::::::::::
:::::::::::::::::::::                                       ::::::       :::::::::::::::::::::::::::
:::::::::::::::::::::.                                       :::::.       ::::::::::::::::::::::::::
::::::::::::::::::::::           ..                           :::::       ::::::::::::::::::::::::::
:::::::::::::::::::::::  :::::::::::::::::.                   .:::::      .:::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::.                  :::::       :::::::::::::::::::::::::
:::::::::::::::::::::::::::             .::::::                :::::       :::::::::::::::::::::::::
:::::::::::::::::::::::::::.               .::::.              .::::       :::::::::::::::::::::::::
:::::::::::::::::::::::::::::.               ::::              .::::       :::::::::::::::::::::::::
:::::::::::::::::::::::::::::::.             :::::             :::::       :::::::::::::::::::::::::
:::::::::::::::::::::::::  ::::::.           :::::             ::::       ::::::::::::::::::::::::::
:::::::::::::::::::::::::.   .:::::..       .::::             .::::       ::::::::::::::::::::::::::
::::::::::::::::::::::::::.     ::::::::::::::::              ::::       .::::::::::::::::::::::::::
:::::::::::::::::::::::::::        .:::::::::.               ::::        :::::::::::::::::::::::::::
::::::::::::::::::::::::::::.                              .::::        ::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::                            :::::        :::::::::::::::::::::::::::::
:::::::::::::::::::::::::::::::.                        .::::         ::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::.                  .:::::          :::::::::::::::::::::::::::::::
:::::::::::::::::::::::::::::::::::::::.        ..::::::.          .::::::::::::::::::::::::::::::::
:::::::::::::::::::::::::::::::: .::::::::::::::::::..           .::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::.      ............              .::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::.                                .::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::.                               .:::::::::::::::::::::::::::::::::::::::::
:::::::::::::::::::::::::                              :::::::::::::::::::::::::::::::::::::::::::::
:::::::::::::::::::::::.          ::::.        ..:::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
  </pre>
  <div class="content">
    <h1>SparrowDesk MCP</h1>
    <div class="divider"></div>
    <div class="links">
      <div>
        <span class="label">Documentation&nbsp;&nbsp;</span>
        <a href="https://developer.sparrowdesk.com/mcp" target="_blank" rel="noopener">developer.sparrowdesk.com/mcp</a>
      </div>
      <div>
        <span class="label">Website&nbsp;&nbsp;</span>
        <a href="https://www.sparrowdesk.com?utm_source=mcp&utm_medium=referral&utm_campaign=mcp_landing" target="_blank" rel="noopener">sparrowdesk.com</a>
      </div>
    </div>
  </div>
</body>
</html>`);
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

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-protocol-version");
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
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
