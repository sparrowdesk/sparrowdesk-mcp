import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type express from "express";
import { createRevoker, revokeHandler } from "./revoke.js";
import type { TokenSession } from "./store.js";

const REVOKE_URL = "https://app.sparrowdesk.test/oauth/revoke";
const CLIENT_ID = "client_test";
const CLIENT_SECRET = "secret-not-for-logs";
const MCP_TOKEN = "a".repeat(64);
const SESSION: TokenSession = { sdToken: "sd-access", refreshToken: "sd-refresh", expiresAt: Date.now() + 60_000 };

function fakeStore(initial: TokenSession | null) {
  let current = initial ? { value: initial, version: "v1" } : null;
  const removed: string[] = [];
  return {
    removed,
    store: {
      get: async (_kind: string, id: string) => (id === MCP_TOKEN ? current : null),
      remove: async (_kind: string, id: string, version: string) => {
        if (!current || id !== MCP_TOKEN || current.version !== version) return false;
        current = null;
        removed.push(id);
        return true;
      },
    } as never,
  };
}

function fakeFetch(respond: (body: URLSearchParams) => Response | Promise<Response>) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body));
    calls.push({ url, body });
    return respond(body);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

function captureLog() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, log: { log: push, warn: push, error: push } };
}

describe("createRevoker", () => {
  it("revokes the SparrowDesk refresh and access tokens of a known MCP token and removes its session", async () => {
    const { store, removed } = fakeStore(SESSION);
    const http = fakeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
    const { lines, log } = captureLog();
    const revoke = createRevoker({ store, revokeUrl: REVOKE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: http.impl, log });

    const result = await revoke(MCP_TOKEN);

    assert.deepEqual(result, { found: true, upstreamRevoked: true });
    assert.deepEqual(http.calls.map((c) => c.url), [REVOKE_URL, REVOKE_URL]);
    assert.deepEqual(http.calls.map((c) => c.body.get("token")), ["sd-refresh", "sd-access"]);
    for (const call of http.calls) {
      assert.equal(call.body.get("client_id"), CLIENT_ID);
      assert.equal(call.body.get("client_secret"), CLIENT_SECRET);
    }
    assert.deepEqual(removed, [MCP_TOKEN]);
    assert.ok(lines.every((l) => !l.includes(CLIENT_SECRET) && !l.includes("sd-refresh") && !l.includes("sd-access") && !l.includes(MCP_TOKEN)), lines.join("\n"));
  });

  it("makes no SparrowDesk call for an unknown token", async () => {
    const { store, removed } = fakeStore(null);
    const http = fakeFetch(() => new Response("{}", { status: 200 }));
    const revoke = createRevoker({ store, revokeUrl: REVOKE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: http.impl, log: captureLog().log });

    const result = await revoke(MCP_TOKEN);

    assert.deepEqual(result, { found: false, upstreamRevoked: false });
    assert.equal(http.calls.length, 0);
    assert.deepEqual(removed, []);
  });

  it("still removes the session and logs the failure when SparrowDesk refuses or is unreachable", async () => {
    for (const respond of [
      () => new Response(JSON.stringify({ message: "Token not found" }), { status: 404 }),
      () => { throw new Error("connect ECONNREFUSED"); },
    ]) {
      const { store, removed } = fakeStore(SESSION);
      const http = fakeFetch(respond);
      const { lines, log } = captureLog();
      const revoke = createRevoker({ store, revokeUrl: REVOKE_URL, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, fetchImpl: http.impl, log });

      const result = await revoke(MCP_TOKEN);

      assert.deepEqual(result, { found: true, upstreamRevoked: false });
      assert.deepEqual(removed, [MCP_TOKEN]);
      assert.ok(lines.some((l) => l.includes("upstream refresh_token revoke failed")), lines.join("\n"));
      assert.ok(lines.every((l) => !l.includes(CLIENT_SECRET) && !l.includes("sd-refresh")), lines.join("\n"));
    }
  });
});

describe("revokeHandler", () => {
  function fakeRes() {
    const res = { statusCode: 0, body: undefined as unknown };
    const api = {
      status(code: number) { res.statusCode = code; return api; },
      json(body: unknown) { res.body = body; return api; },
      end() { return api; },
    };
    return { res, api: api as unknown as express.Response };
  }

  it("answers 200 for a known token, an unknown token and after an upstream failure alike", async () => {
    for (const outcome of [{ found: true, upstreamRevoked: true }, { found: false, upstreamRevoked: false }, { found: true, upstreamRevoked: false }]) {
      const seen: string[] = [];
      const { res, api } = fakeRes();
      await revokeHandler(async (token) => { seen.push(token); return outcome; })({ body: { token: MCP_TOKEN } } as express.Request, api);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(seen, [MCP_TOKEN]);
    }
  });

  it("answers 400 invalid_request without a token and revokes nothing", async () => {
    let called = false;
    const { res, api } = fakeRes();
    await revokeHandler(async () => { called = true; })({ body: {} } as express.Request, api);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: "invalid_request", error_description: "token required" });
    assert.equal(called, false);
  });
});
