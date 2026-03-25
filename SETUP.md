# SparrowDesk MCP — Setup & Testing Guide

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Run the server

```bash
npm run dev
```

The server starts at `http://localhost:3000`. Verify it's running:

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

### 3. Configure your MCP client

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <your_sparrowdesk_api_key>"
      }
    }
  }
}
```

**Claude Code** (`.mcp.json` in project root or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer <your_sparrowdesk_api_key>"
      }
    }
  }
}
```

### 4. Test a tool call directly

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer <your_sparrowdesk_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

---

## Deployed Server

The server is live at `https://mcp.campaignsparrow.com`.

### 1. Verify the server is up

```bash
curl https://mcp.campaignsparrow.com/health
# {"status":"ok"}
```

### 2. Configure your MCP client

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "url": "https://mcp.campaignsparrow.com/mcp",
      "headers": {
        "Authorization": "Bearer <your_sparrowdesk_api_key>"
      }
    }
  }
}
```

**Claude Code** (`.mcp.json` in project root or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "url": "https://mcp.campaignsparrow.com/mcp",
      "headers": {
        "Authorization": "Bearer <your_sparrowdesk_api_key>"
      }
    }
  }
}
```

### 3. Test a tool call directly

```bash
curl -X POST https://mcp.campaignsparrow.com/mcp \
  -H "Authorization: Bearer <your_sparrowdesk_api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'
```

### 4. Test a specific tool

```bash
curl -X POST https://mcp.campaignsparrow.com/mcp \
  -H "Authorization: Bearer <your_sparrowdesk_api_key>" \
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
| `get_contact` | Retrieve a contact by ID |
| `create_contact` | Create a new contact |
| `update_contact` | Update an existing contact |
