# SparrowDesk MCP — Setup & Testing Guide

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
export SPARROWDESK_CLIENT_ID=your_client_id
export SPARROWDESK_CLIENT_SECRET=your_client_secret
export SPARROWDESK_OAUTH_ISSUER=https://app.sparrowdesk.com
export MCP_PUBLIC_URL=http://localhost:3000
```

### 3. Run the server

```bash
npm run dev
```

The server starts at `http://localhost:3000`. Verify it's running:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### 4. Configure your MCP client

**Cursor** (`~/.cursor/mcp.json`):

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

**Claude Code** (`.mcp.json` in project root or `~/.claude/mcp.json`):

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

Your MCP client will open a browser window to complete the OAuth login with your SparrowDesk account.

---

## Deployed Server

The server is live at `https://mcp.sparrowdesk.com`.

### 1. Verify the server is up

```bash
curl https://mcp.sparrowdesk.com/health
# {"status":"ok"}
```

### 2. Configure your MCP client

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "type": "http",
      "url": "https://mcp.sparrowdesk.com/mcp"
    }
  }
}
```

**Claude Code** (`.mcp.json` in project root or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "type": "http",
      "url": "https://mcp.sparrowdesk.com/mcp"
    }
  }
}
```

Your MCP client will open a browser window to complete the OAuth login with your SparrowDesk account.

### 3. Test the OAuth discovery endpoint

```bash
curl https://mcp.sparrowdesk.com/.well-known/oauth-authorization-server
```

### 4. Test a tool call directly

Once you have an OAuth access token, you can test tool calls directly:

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

### 5. Test a specific tool

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

---

## Available Tools

| Tool | Description |
|------|-------------|
| `get_conversation` | Retrieve a conversation by ID |
| `list_conversations` | List conversations with optional filters |
| `list_conversation_replies` | List replies for a conversation |
| `add_conversation_reply` | Add a reply or internal note to a conversation |
| `create_conversation` | Create a new conversation/ticket |
| `get_contact` | Retrieve a contact by ID |
| `create_contact` | Create a new contact |
| `update_contact` | Update an existing contact |
| `list_contact_fields` | List all contact fields |
| `list_members` | List all team members |
| `get_me` | Retrieve the currently authenticated member's profile |
