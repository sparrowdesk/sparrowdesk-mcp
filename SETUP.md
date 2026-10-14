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

The server exits at startup if `SPARROWDESK_CLIENT_ID`, `SPARROWDESK_CLIENT_SECRET`, `SPARROWDESK_OAUTH_ISSUER`, `DYNAMO_REGION`, or `DYNAMO_PREFIX` is missing, or if the DynamoDB table is not there. It logs the config it resolved.

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

The image builds TypeScript and runs `dist/index.js` on port 3000. It reads no `.env` of its own, so pass the config in:

```bash
docker build -t sparrowdesk-mcp .
docker run --rm -p 3000:3000 --env-file .env sparrowdesk-mcp
```

Inside the container `localhost` is the container itself, so point `DYNAMO_ENDPOINT` at `http://host.docker.internal:8000` to reach DynamoDB Local on the host.

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
