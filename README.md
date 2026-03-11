# SparrowDesk MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [SparrowDesk](https://sparrowdesk.com) API. Lets AI assistants like Claude interact with your SparrowDesk support data directly.

## Tools

| Tool | Description |
|------|-------------|
| `get_conversation` | Retrieve a conversation by ID |
| `list_conversation_replies` | List all replies for a conversation (supports pagination, filtering, sorting) |
| `get_contact` | Retrieve a contact by ID |

## Setup

### Prerequisites

- Node.js 18+
- A SparrowDesk API key

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

## Configuration

Set your SparrowDesk API key as an environment variable:

```bash
export SPARROWDESK_API_KEY=your_api_key_here
```

## Usage

### With Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "command": "node",
      "args": ["/path/to/sparrowdesk-mcp/dist/index.js"],
      "env": {
        "SPARROWDESK_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### With Claude Code

```bash
claude mcp add sparrowdesk -- node /path/to/sparrowdesk-mcp/dist/index.js
```

Then set the env var in your shell or pass it via the MCP config.

### With Cursor

Open **Cursor Settings → MCP** and add a new server, or edit `~/.cursor/mcp.json` directly:

```json
{
  "mcpServers": {
    "sparrowdesk": {
      "command": "node",
      "args": ["/path/to/sparrowdesk-mcp/dist/index.js"],
      "env": {
        "SPARROWDESK_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Restart Cursor after saving. The SparrowDesk tools will appear in the Agent tool list.

### Run directly

```bash
npm start
```

Or in dev mode (no build needed):

```bash
npm run dev
```

### Run with Docker

```bash
# Build the image
docker build -t sparrowdesk-mcp .

# Run the container
docker run -p 3000:3000 sparrowdesk-mcp
```

The server will be available at `http://localhost:3000/mcp`.

Pass your API key at runtime:

```bash
docker run -p 3000:3000 -e SPARROWDESK_API_KEY=your_api_key_here sparrowdesk-mcp
```

## Tool Reference

### `get_conversation`

Fetch a single conversation by its numeric ID.

**Parameters:**
- `id` (integer, required) — The conversation ID

### `list_conversation_replies`

List replies for a conversation, with optional filtering and pagination.

**Parameters:**
- `id` (integer, required) — The conversation ID
- `starting_after` (string, optional) — Pagination cursor
- `per_page` (integer, optional) — Items per page, 1–100 (default: 25)
- `type` (string, optional) — Filter by `INTERNAL_NOTE` or `REPLY`
- `sort_order` (string, optional) — `asc` or `desc` (default: `desc`)

### `get_contact`

Fetch a single contact by its numeric ID.

**Parameters:**
- `id` (integer, required) — The contact ID
