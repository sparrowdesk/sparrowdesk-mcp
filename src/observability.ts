import crypto from "crypto";
import newrelic from "newrelic";

// ---------------------------------------------------------------------------
// Request tracing and New Relic naming for /mcp.
//
// Every authenticated /mcp request gets a trace id that is logged here and sent
// to the public API as `x-sd-trace-id`. public-api and helpdesk both adopt that
// header as their own request id (the 3rd bracket of their log lines) and
// forward it, so one id finds the request in all three services' logs.
//
// The New Relic agent is loaded by the start command
// (`node --import newrelic/esm-loader.mjs -r newrelic`). Without a license key
// it stays disabled and these calls are no-ops.
// ---------------------------------------------------------------------------

export const TRACE_HEADER = "x-sd-trace-id";

export function newTraceId(): string {
  return `mcp-${crypto.randomUUID()}`;
}

// JSON-RPC methods defined by the MCP spec. Anything else is reported as
// "other" so a client cannot mint unbounded log values or New Relic
// transaction names.
const KNOWN_METHOD = /^(initialize|ping|tools\/(list|call)|resources\/(list|read|templates\/list|subscribe|unsubscribe)|prompts\/(list|get)|completion\/complete|logging\/setLevel|notifications\/[a-z_]+(\/[a-z_]+)?)$/;

export interface RpcSummary {
  /** JSON-RPC method, "batch" for an array body, "none" when there is no body. */
  rpc: string;
  /** Tool name for tools/call, when it is a registered tool. */
  tool?: string;
}

export function describeRpc(body: unknown, knownTools: ReadonlySet<string>): RpcSummary {
  if (Array.isArray(body)) return { rpc: "batch" };
  if (!body || typeof body !== "object") return { rpc: "none" };

  const { method, params } = body as { method?: unknown; params?: { name?: unknown } };
  if (typeof method !== "string") return { rpc: "response" };
  if (!KNOWN_METHOD.test(method)) return { rpc: "other" };

  if (method !== "tools/call") return { rpc: method };
  const name = params?.name;
  return { rpc: method, tool: typeof name === "string" && knownTools.has(name) ? name : "unknown" };
}

/** Name the current New Relic transaction after the MCP call and tag it. */
export function recordMcpTransaction(summary: RpcSummary, ctx: CallContext) {
  newrelic.setTransactionName(summary.tool ? `mcp/${summary.rpc}/${summary.tool}` : `mcp/${summary.rpc}`);
  newrelic.addCustomAttributes({
    "mcp.rpc": summary.rpc,
    "mcp.tool": summary.tool ?? "",
    "mcp.session": ctx.session,
    "mcp.account": String(ctx.account),
    "mcp.client": ctx.client,
    "sd.traceId": ctx.trace,
  });
}

// ---------------------------------------------------------------------------
// Who is calling: account and client app, for adoption and usage by account.
// ---------------------------------------------------------------------------

/** client_name from dynamic registration is client-supplied: keep it short and printable. */
export function cleanClientName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const cleaned = name.replace(/[^\x20-\x7E]/g, "").replace(/["\\]/g, "").trim().slice(0, 64);
  return cleaned || undefined;
}

/** The SparrowDesk account behind an access token, from GET /me. Undefined if the call fails. */
export async function lookupAccountId(apiBase: string, sdToken: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${apiBase}/me`, {
      headers: { Authorization: `Bearer ${sdToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[account] GET /me failed status=${res.status}`);
      return undefined;
    }
    const body = await res.json() as { data?: { id?: unknown } };
    const id = Number(body?.data?.id);
    return Number.isInteger(id) && id > 0 ? id : undefined;
  } catch (err) {
    console.warn(`[account] GET /me failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// Sessions created before accountId was stored on them: resolve once per pod and remember.
// Not written back to the store, because that write could race a token refresh on another
// replica and put back a revoked refresh token.
const LEGACY_CACHE_MAX = 5_000;
const legacyAccounts = new Map<string, Promise<number | undefined>>();

export function accountForLegacySession(mcpToken: string, apiBase: string, sdToken: string): Promise<number | undefined> {
  const key = crypto.createHash("sha256").update(mcpToken).digest("hex");
  let pending = legacyAccounts.get(key);
  if (!pending) {
    if (legacyAccounts.size >= LEGACY_CACHE_MAX) {
      legacyAccounts.delete(legacyAccounts.keys().next().value!);
    }
    pending = lookupAccountId(apiBase, sdToken).then((id) => {
      if (id === undefined) legacyAccounts.delete(key); // retry on the next request
      return id;
    });
    legacyAccounts.set(key, pending);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Tool outcomes: one `tool_result` line per tools/call, success or failure.
// ---------------------------------------------------------------------------

export interface CallContext {
  session: string;
  account: number | "unknown";
  client: string;
  trace: string;
}

const MESSAGE_MAX = 300;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;

function shortMessage(text: string): string {
  return text.replace(EMAIL, "<email>").replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
}

/** Classify the text of an isError tool result (see apiRequest in index.ts and the SDK's validation errors). */
export function classifyToolError(text: string): { error: string; status?: number } {
  const api = /^Error (\d{3}):/.exec(text);
  if (api) return { error: "api_error", status: Number(api[1]) };
  if (/Tool \S+ not found/.test(text)) return { error: "unknown_tool" };
  if (/-32602|Input validation error|Invalid arguments/i.test(text)) return { error: "invalid_arguments" };
  if (text.startsWith("Request timed out")) return { error: "timeout" };
  if (text.startsWith("Unexpected error contacting")) return { error: "network" };
  if (text.startsWith("Unexpected response")) return { error: "bad_response" };
  return { error: "tool_error" };
}

type Sendable = { send: (message: any, options?: any) => Promise<void> };

/**
 * Log the outcome of a tools/call by watching the response the transport sends back.
 * Watching the transport (rather than wrapping each tool) also catches argument
 * validation failures, which the SDK returns before any tool code runs.
 */
export function watchToolResult(transport: Sendable, requestId: unknown, tool: string, ctx: CallContext) {
  const started = Date.now();
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    if (message && typeof message === "object" && message.id === requestId && ("result" in message || "error" in message)) {
      const line: Record<string, unknown> = { event: "tool_result", ...ctx, tool, ok: true, ms: Date.now() - started };
      if ("error" in message) {
        Object.assign(line, { ok: false, error: "rpc_error", status: message.error?.code, message: shortMessage(String(message.error?.message ?? "")) });
      } else if (message.result?.isError) {
        const text = (message.result.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" ");
        Object.assign(line, { ok: false, ...classifyToolError(text), message: shortMessage(text) });
      }
      console.log(JSON.stringify(line));
      newrelic.addCustomAttributes({ "mcp.ok": line.ok as boolean, "mcp.error": (line.error as string) ?? "" });
    }
    return send(message, options);
  };
}
