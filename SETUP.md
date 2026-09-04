# SparrowDesk MCP Setup and Testing

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Create a `.env` file

`npm run dev` loads `.env` from the repo root, so put your config there rather than exporting it in your shell:

```bash
SPARROWDESK_CLIENT_ID=your_client_id
SPARROWDESK_CLIENT_SECRET=your_client_secret
SPARROWDESK_OAUTH_ISSUER=https://app.sparrowdesk.com
MCP_PUBLIC_URL=http://localhost:3000
```

The server exits at startup if `SPARROWDESK_CLIENT_ID`, `SPARROWDESK_CLIENT_SECRET`, or `SPARROWDESK_OAUTH_ISSUER` is missing, and logs the config it resolved.

`MCP_PUBLIC_URL` is optional, but set it anyway. It defaults to `https://mcp.campaignsparrow.com`, and the OAuth discovery endpoints advertise that value verbatim, so clients get sent to the wrong host.

Other optional variables:

| Variable | Default |
|---|---|
| `PORT` | `3000` |
| `SPARROWDESK_API_BASE` | `https://api.sparrowdesk.com/v1` |
| `SPARROWDESK_OAUTH_AUTHORIZE_URL` | `{ISSUER}/oauth/authorize` |
| `SPARROWDESK_OAUTH_TOKEN_URL` | `{ISSUER}/oauth/token` |

### 3. Run the server

```bash
npm run dev
```

It listens on `http://localhost:3000`. Check it came up:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### 4. Point your MCP client at it

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
