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
export function recordMcpTransaction(summary: RpcSummary, session: string, traceId: string) {
  newrelic.setTransactionName(summary.tool ? `mcp/${summary.rpc}/${summary.tool}` : `mcp/${summary.rpc}`);
  newrelic.addCustomAttributes({
    "mcp.rpc": summary.rpc,
    "mcp.tool": summary.tool ?? "",
    "mcp.session": session,
    "sd.traceId": traceId,
  });
}
