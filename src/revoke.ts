import type express from "express";
import type { OAuthStore } from "./store.js";

// Token revocation (RFC 7009) for the tokens this server issues. An MCP token maps to a stored
// session holding the user's SparrowDesk access and refresh tokens; revoking it revokes that
// SparrowDesk grant upstream and deletes the session, so the user's consent does not outlive the
// client that asked for it. SparrowDesk refresh tokens never expire on their own (SDE-6361).

const UPSTREAM_TIMEOUT_MS = 10_000;
const REMOVE_ATTEMPTS = 3;

type Log = Pick<Console, "log" | "warn" | "error">;

export interface RevokeDeps {
  store: Pick<OAuthStore, "get" | "remove">;
  /** SparrowDesk's revocation endpoint, `${SPARROWDESK_OAUTH_ISSUER}/oauth/revoke` */
  revokeUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  log?: Log;
}

export function createRevoker({ store, revokeUrl, clientId, clientSecret, fetchImpl = fetch, log = console }: RevokeDeps) {
  async function revokeUpstream(sdToken: string, kind: "refresh_token" | "access_token", hint: string) {
    try {
      const res = await fetchImpl(revokeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: sdToken, client_id: clientId, client_secret: clientSecret }).toString(),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        log.error(`[revoke] token=${hint} upstream ${kind} revoke failed status=${res.status} body=${body}`);
        return false;
      }
      return true;
    } catch (err) {
      log.error(`[revoke] token=${hint} upstream ${kind} revoke failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Revoke an MCP token: revoke its SparrowDesk refresh and access tokens, then delete the session.
   * The session is deleted even when SparrowDesk refuses, so the MCP token stops working either way.
   * A refresh that lands meanwhile rewrites the session; it is then read again and its new tokens
   * revoked too.
   */
  return async function revokeSession(mcpToken: string): Promise<{ found: boolean; upstreamRevoked: boolean }> {
    const hint = mcpToken.slice(0, 8);
    let found = false;
    let upstreamRevoked = true;
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt++) {
      const stored = await store.get("session", mcpToken);
      if (!stored) break;
      found = true;
      const { refreshToken, sdToken } = stored.value;
      const refreshOk = await revokeUpstream(refreshToken, "refresh_token", hint);
      const accessOk = await revokeUpstream(sdToken, "access_token", hint);
      upstreamRevoked = upstreamRevoked && refreshOk && accessOk;
      if (await store.remove("session", mcpToken, stored.version)) {
        log.log(`[revoke] ok token=${hint} session removed upstream_revoked=${upstreamRevoked}`);
        return { found, upstreamRevoked };
      }
    }
    if (found) {
      log.warn(`[revoke] token=${hint} session kept changing; gave up after ${REMOVE_ATTEMPTS} attempts`);
    } else {
      log.log(`[revoke] token=${hint} not found (already revoked, expired or never issued)`);
    }
    return { found, upstreamRevoked: found && upstreamRevoked };
  };
}

/**
 * POST /oauth/revoke. Takes `token` from a form or JSON body. Answers 200 whether or not the token
 * was known (RFC 7009 section 2.2), and 400 invalid_request when no token is given.
 */
export function revokeHandler(revokeSession: (token: string) => Promise<unknown>) {
  return async (req: express.Request, res: express.Response) => {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.length === 0) {
      res.status(400).json({ error: "invalid_request", error_description: "token required" });
      return;
    }
    await revokeSession(token);
    res.status(200).end();
  };
}
