# SparrowDesk MCP Setup and Testing

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file

`npm run dev` loads `.env` from the repo root, so put your config there rather than exporting it in your shell. The template targets a local SparrowDesk (`sd-app-backend` docker compose plus `sd-app-frontend` running `npm start`):

```bash
cp .env.template .env
```

Fill in `SPARROWDESK_CLIENT_ID` and `SPARROWDESK_CLIENT_SECRET` with an OAuth client on that SparrowDesk. There is no UI for creating one: log in at `http://app.sparrowdesk.test` and run this in the browser console.

```js
fetch("/api/internal/oauth/clients", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    clientName: "MCP local",
    redirectUri: "http://localhost:3000/oauth/callback",
    isPublic: true,
    scopes: ["MANAGE_CONTACTS", "VIEW_ALL_TICKETS", "VIEW_CONTACTS", "VIEW_OWN_TICKETS", "EDIT_OWN_TICKETS", "DELETE_OWN_TICKETS", "VIEW_ALL_TAGS", "EDIT_ALL_TICKETS", "DELETE_ALL_TICKETS", "VIEW_MEMBERS", "VIEW_COLLECTIONS", "MANAGE_COLLECTIONS", "VIEW_ARTICLES", "MANAGE_ARTICLES"],
  }),
}).then((r) => r.json()).then(console.log);
```

The response shows `clientSecret` once. `redirectUri` must equal `{MCP_PUBLIC_URL}/oauth/callback` exactly.

The local public API validates OAuth tokens by hashing them with `OAUTH_ENCRYPTION_KEY`, and that key must match the helpdesk application's. If tool calls return 401 and the public API logs `OAuth encryption key not configured`, add `OAUTH_ENCRYPTION_KEY` from `application/public-api/.env.template` to `application/public-api/.env` in `sd-app-backend`, then restart the public API and nginx containers.

The server exits at startup if `SPARROWDESK_CLIENT_ID`, `SPARROWDESK_CLIENT_SECRET`, `SPARROWDESK_OAUTH_ISSUER`, `DYNAMO_REGION`, or `DYNAMO_PREFIX` is missing, and logs the config it resolved. A missing DynamoDB table does not stop it: `/health` still answers, while the OAuth endpoints and `/mcp` return 503 until the table exists (see step 3).

`MCP_PUBLIC_URL` is optional, but set it anyway. It defaults to `https://mcp.campaignsparrow.com`, and the OAuth discovery endpoints advertise that value verbatim, so clients get sent to the wrong host.

Other optional variables:

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `SPARROWDESK_API_BASE` | `https://api.sparrowdesk.com/v1` |
| `SPARROWDESK_OAUTH_AUTHORIZE_URL` | `{ISSUER}/oauth/authorize` |
| `SPARROWDESK_OAUTH_TOKEN_URL` | `{ISSUER}/oauth/token` |
| `DYNAMO_ENDPOINT` | the regional AWS endpoint |

### 3. Create the DynamoDB table

OAuth clients, pending logins and sessions live in one DynamoDB table, `{DYNAMO_PREFIX}oauth`, so they survive restarts and are shared across replicas. Tokens are encrypted with a key derived from `SPARROWDESK_CLIENT_SECRET`. Rotating that secret signs everyone out, which also happens upstream, because SparrowDesk revokes every token when the secret is regenerated.

Locally, run DynamoDB Local (the `sd-app-backend` docker compose already starts one on port 8000, or use `docker run -p 8000:8000 amazon/dynamodb-local`), then create the table once:

```bash
npm run create-table
```

This creates the table with a string partition key `pk`, on-demand billing, and TTL on the `expiresAt` attribute. Deployed environments need the same table, plus `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `DescribeTable` and `DescribeTimeToLive` on it for the pod's role. The server picks up AWS credentials from the default provider chain.

To create the table in a deployed environment, open a terminal in the running pod (for example from ArgoCD) and run `node dist/create-table.js`; this also needs `CreateTable` and `UpdateTimeToLive` for the pod's role. The server re-checks the table every few seconds, so no restart is needed afterwards; the log shows `[store] DynamoDB table … is ready`.

### 4. Run the server

```bash
npm run dev
```

It listens on `http://localhost:3000`. Check it came up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### 5. Point your MCP client at it

**Cursor** (`~/.cursor/mcp.json`) or **Claude Code** (`.mcp.json` in the project root, or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Your client opens a browser window to complete the OAuth login with your SparrowDesk account.

## Docker

The image builds TypeScript and runs `dist/index.js` (with the New Relic agent preloaded) on port 3000. It reads no `.env` of its own, so pass the config in:

```bash
docker build -t sparrowdesk-mcp .
docker run --rm -p 3000:3000 --env-file .env sparrowdesk-mcp
```

Inside the container `localhost` is the container itself, so point `DYNAMO_ENDPOINT` at `http://host.docker.internal:8000` to reach DynamoDB Local on the host.

## Observability

**Logs (Loki, `{container="mcp-app"}`).** Each authenticated `/mcp` request logs one line naming the JSON-RPC method, the tool for `tools/call`, and a trace id:

```
[mcp] session=18b20444 ok, handling POST request rpc=tools/call tool=list_conversations trace=mcp-6f1c…
{"event":"api_call","session":"18b20444","trace":"mcp-6f1c…","method":"GET","url":"https://api.sparrowdesk.com/v1/conversations"}
```

Tool names a client sends that this server does not register are logged as `tool=unknown`, and methods outside the MCP spec as `rpc=other`.

Every `[mcp]`, `api_call` and `tool_result` line carries `account` (the SparrowDesk account, from `GET /me` at sign-in) and `client` (the registering app's `client_name`, e.g. `Claude`).

- `{"event":"tool_result",…}`: one per `tools/call`, with `ok`, `ms`, and for failures `error` (`api_error` with `status`, `invalid_arguments`, `unknown_tool`, `timeout`, `network`, `bad_response`, `rpc_error`) and a short `message` with emails masked.

```logql
# failures by tool and kind, last 7 days
sum by (tool, error) (count_over_time({container="mcp-app"} |= `"event":"tool_result"` | json | ok="false" [7d]))
# active accounts per day
count(sum by (account) (count_over_time({container="mcp-app"} |= `"event":"tool_result"` | json [1d])))
```

```logql
# tool calls per tool, per day
sum by (tool) (count_over_time({container="mcp-app"} |= "rpc=tools/call" | regexp `tool=(?P<tool>\S+)` [1d]))
```

**Following a request across services.** The trace id goes to the public API as `x-sd-trace-id` and comes back on the response in the same header. public-api and helpdesk take that header as their own request id (the third bracket of their log lines) and pass it on, so one id finds the request in all three:

```logql
{container=~"mcp-app|public-api-app|helpdesk"} |= "mcp-6f1c…"
```

**New Relic.** The image starts the agent (`node --import newrelic/esm-loader.mjs -r newrelic`). It reports when `NEW_RELIC_LICENSE_KEY` (Vault) and `NEW_RELIC_APP_NAME` (config repo) are set, and stays off otherwise. Transactions are named `mcp/<method>[/<tool>]` and carry `mcp.rpc`, `mcp.tool`, `mcp.session` and `sd.traceId`. Distributed tracing links the outgoing call to the public API's transaction:

```sql
SELECT count(*) FROM Transaction WHERE appName = 'SparrowDesk-MCP-Production' FACET mcp.tool SINCE 1 day ago
```

Locally, `npm run dev` does not load the agent; `.env.template` sets `NEW_RELIC_ENABLED=false` for `npm start`.

## Testing the Deployed Server

The server is live at `https://mcp.sparrowdesk.com`. To use it from a client, follow [the install steps in the README](./README.md#install). The rest of this section is for poking at it directly.

Check it's up:

```bash
curl https://mcp.sparrowdesk.com/health
# {"status":"ok"}
```

Check OAuth discovery:

```bash
curl https://mcp.sparrowdesk.com/.well-known/oauth-authorization-server
```

List the tools. This needs an OAuth access token, which you get by connecting once from an MCP client:

```bash
curl -X POST https://mcp.sparrowdesk.com/mcp \
  -H "Authorization: Bearer <your_oauth_access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

Call one tool:

```bash
curl -X POST https://mcp.sparrowdesk.com/mcp \
  -H "Authorization: Bearer <your_oauth_access_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "list_conversations",
      "arguments": { "per_page": 5 }
    }
  }'
```

`/mcp` is rate limited to 100 requests per minute per IP, and the OAuth endpoints to 50 per 15 minutes.

For the full list of 36 tools and their parameters, see the [tool reference in the README](./README.md#tool-reference).
