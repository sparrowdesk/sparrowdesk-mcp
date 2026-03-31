# SparrowDesk MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [SparrowDesk](https://sparrowdesk.com). Connect AI assistants like Claude to your SparrowDesk account to read and manage tickets, contacts, and team data directly from your conversations.

Authentication is handled via OAuth — no API keys to manage. Your MCP client will open a browser window to log in with your SparrowDesk account the first time you connect.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_conversation` | Retrieve a conversation by ID |
| `list_conversations` | List conversations with optional filters (status, priority, assignee, etc.) |
| `list_conversation_replies` | List all replies for a conversation |
| `add_conversation_reply` | Add a reply or internal note to a conversation |
| `create_conversation` | Create a new conversation/ticket |
| `create_contact` | Create a new contact |
| `update_contact` | Update an existing contact |
| `get_contact` | Retrieve a contact by ID |
| `list_contact_fields` | List all contact fields |
| `list_members` | List all team members |
| `get_me` | Retrieve the currently authenticated member's profile |

## Installing in Claude

Add to your `claude_desktop_config.json`:

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

Or with Claude Code:

```bash
claude mcp add --transport http sparrowdesk https://mcp.sparrowdesk.com/mcp
```

## Installing in Cursor

Edit `~/.cursor/mcp.json`:

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

Restart Cursor after saving. The SparrowDesk tools will appear in the Agent tool list. Cursor will open a browser window to complete the OAuth login with your SparrowDesk account.

## Tool Reference

### `get_conversation`

Fetch a single conversation by its numeric ID.

**Parameters:**
- `id` (integer, required) — The conversation ID

---

### `list_conversations`

List conversations with optional filters, sorting, and pagination.

**Parameters:**
- `starting_after` (string, optional) — Pagination cursor
- `per_page` (integer, optional) — Items per page, 1–100 (default: 25)
- `status` (array, optional) — Filter by status: `Open`, `Pending`, `Resolved`, `Closed`
- `priority` (array, optional) — Filter by priority: `Low`, `Medium`, `High`, `Urgent`
- `assigned_to_member_id` (array of integers, optional) — Filter by assigned agent IDs
- `assigned_to_team_id` (array of integers, optional) — Filter by assigned team IDs
- `brand_id` (array of integers, optional) — Filter by brand IDs
- `requested_by_id` (integer, optional) — Filter by requestor contact ID
- `sort_by` (string, optional) — `created_at` or `updated_at` (default: `created_at`)
- `sort_order` (string, optional) — `asc` or `desc` (default: `desc`)

---

### `list_conversation_replies`

List replies for a conversation, with optional filtering and pagination.

**Parameters:**
- `id` (integer, required) — The conversation ID
- `starting_after` (string, optional) — Pagination cursor
- `per_page` (integer, optional) — Items per page, 1–100 (default: 25)
- `type` (string, optional) — Filter by `INTERNAL_NOTE` or `REPLY`
- `sort_order` (string, optional) — `asc` or `desc` (default: `desc`)

---

### `add_conversation_reply`

Add a reply or internal note to a conversation.

**Parameters:**
- `id` (integer, required) — The conversation ID
- `reply_text` (string, required) — The content of the reply message
- `type` (string, required) — `REPLY` (visible to customer) or `INTERNAL_NOTE` (agents only)

---

### `create_conversation`

Create a new conversation/ticket in SparrowDesk.

**Parameters:**
- `subject` (string, required) — Conversation subject
- `description` (string, required) — Conversation description
- `requested_by` (string, required) — Email or phone number of the requester
- `priority` (string, optional) — `Low`, `Medium`, `High`, or `Urgent` (default: `Medium`)
- `source` (string, optional) — `Mail` or `Call` (default: `Call`)
- `status` (string, optional) — `Open`, `Pending`, `Resolved`, or `Closed` (default: `Open`)
- `brand_id` (integer, optional) — Brand ID (uses account default if omitted)
- `assignee` (string, optional) — Agent email address to assign the conversation to
- `team_id` (integer, optional) — Team ID to assign the conversation to
- `custom_fields` (array, optional) — Array of `{ internal_name, value }` objects

---

### `create_contact`

Create a new contact. Either `email` or `phone` must be provided.

**Parameters:**
- `first_name` (string, required) — Contact's first name
- `last_name` (string, optional) — Contact's last name
- `email` (string, optional) — Contact's email address (required if phone not provided)
- `phone` (string, optional) — Contact's phone number (required if email not provided)
- `company_id` (integer, optional) — ID of the company to associate with
- `custom_fields` (object, optional) — Custom field key-value pairs

---

### `update_contact`

Update an existing contact.

**Parameters:**
- `id` (integer, required) — The contact ID to update
- `first_name` (string, optional) — Contact's first name
- `last_name` (string, optional) — Contact's last name
- `email` (string, optional) — Contact's email address
- `phone` (string, optional) — Contact's phone number
- `company_id` (integer, optional) — ID of the company to associate with
- `blocked` (boolean, optional) — Whether the contact is blocked
- `custom_fields` (object, optional) — Custom field key-value pairs

---

### `get_contact`

Fetch a single contact by its numeric ID.

**Parameters:**
- `id` (integer, required) — The contact ID

---

### `list_contact_fields`

Retrieve all contact fields defined in the account.

**Parameters:**
- `search` (string, optional) — Search contact fields by name
- `page` (integer, optional) — Page number for pagination
- `limit` (integer, optional) — Results per page

---

### `list_members`

Retrieve a paginated list of all team members in the account.

**Parameters:**
- `starting_after` (string, optional) — Pagination cursor
- `per_page` (integer, optional) — Items per page, 1–100 (default: 25)

---

### `get_me`

Retrieve the currently authenticated member's profile.

**Parameters:** None

---

## Local Development

See [SETUP.md](./SETUP.md) for local development instructions, environment variables, and Docker setup.
