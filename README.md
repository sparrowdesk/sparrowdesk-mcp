# SparrowDesk MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [SparrowDesk](https://sparrowdesk.com). Connect AI assistants like Claude to your SparrowDesk account to read and manage tickets, contacts, Knowledge Base content, tags, companies, and team data.

Authentication is handled via OAuth — no API keys to manage. Your MCP client will open a browser window to log in with your SparrowDesk account the first time you connect.

## Available Tools

Tools mirror the [SparrowDesk Developer API](https://api.sparrowdesk.com/public-api/swagger.json). Knowledge Base collections and related endpoints require **`VIEW_COLLECTIONS`** and **`MANAGE_COLLECTIONS`** (included in the MCP default OAuth scope list). Other KB behavior may still depend on additional scopes or account features.

| Tool | Description |
|------|-------------|
| **Account** | |
| `get_me` | Current account information (subdomain, company, timezone, language) |
| **Conversations** | |
| `get_conversation` | Retrieve a conversation by ID |
| `list_conversations` | List conversations with optional filters |
| `create_conversation` | Create a new conversation/ticket |
| `update_conversation` | Update subject, status, priority, assignee, team, custom fields |
| `delete_conversation` | Delete a conversation |
| `list_conversation_replies` | List replies for a conversation |
| `add_conversation_reply` | Add a reply or internal note |
| **Conversation fields** | |
| `list_conversation_fields` | List ticket custom field definitions |
| `get_conversation_field` | Get one conversation field by ID |
| `create_conversation_field` | Create a custom conversation field |
| `update_conversation_field` | Update a conversation field |
| **Contacts & companies** | |
| `list_contacts` | List contacts (search, email, phone, pagination) |
| `get_contact` | Retrieve a contact by ID |
| `create_contact` | Create a contact |
| `update_contact` | Update a contact |
| `delete_contact` | Delete a contact |
| `bulk_create_contacts` | Bulk create contacts (returns job id) |
| `get_bulk_job_status` | Poll bulk contact job status |
| `list_companies` | List companies |
| **Contact fields** | |
| `list_contact_fields` | List contact field definitions |
| **Members & tags** | |
| `list_members` | List team members |
| `list_tags` | List tags |
| **Knowledge Base** | |
| `list_helpcenters` | List help centers |
| `list_collections` | List KB collections for a help center |
| `get_collection` | Get a collection with subcollections and articles |
| `create_collection` | Create a KB collection |
| `list_articles` | List articles for a help center |
| `get_article` | Get one article |
| `create_article` | Create an article (draft or publish) |
| `update_article` | Update an article draft / publish |
| `archive_article` | Archive an article |

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
- `requested_by_company` (integer, optional) — Filter by requester contact company ID (intersects with `requested_by_id` when both are set)
- `sort_by` (string, optional) — `created_at` or `updated_at` (default: `created_at`)
- `sort_order` (string, optional) — `asc` or `desc` (default: `desc`)

---

### `update_conversation`

Patch an existing conversation.

**Parameters:**
- `id` (integer, required) — Conversation ID
- `subject`, `priority`, `status`, `assignee` (email), `team` (string) — Optional updates
- `custom_fields` (array, optional) — `{ internal_name, value }` (values as strings)

---

### `delete_conversation`

Delete a conversation by ID.

**Parameters:**
- `id` (integer, required)

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

### Conversation field tools

- **`list_conversation_fields`** — `starting_after`, `per_page`, `is_active`, `is_default`
- **`get_conversation_field`** — `id`
- **`create_conversation_field`** — `name`, `type` (`single_line_text` | `multi_line_text` | `dropdown` | `number` | `date` | `email`), optional `internal_name`, `description`, `is_mandatory_on_close`, `field_options` (required for dropdowns)
- **`update_conversation_field`** — `id` plus any of `name`, `description`, `is_active`, `is_mandatory_on_close`, `field_options`

---

### `list_contacts`

List contacts with filters (requires **view contacts** scope where enforced).

**Parameters:** `search`, `requested_by_email`, `requested_by_phone`, `starting_after`, `per_page`

---

### `delete_contact`

**Parameters:** `id` (integer, required)

---

### `bulk_create_contacts` / `get_bulk_job_status`

Bulk create accepts `contacts`: array of objects with optional `first_name`, `last_name`, `email`, `phone`, `company_id`, `custom_fields`. Response includes `job_id`. Poll **`get_bulk_job_status`** with `job_id` until `completed` or `failed`.

---

### `list_companies`

**Parameters:** `starting_after`, `per_page`, `domain` (exact), `name` (exact)

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

Retrieve current SparrowDesk **account** information (not a user profile).

**Parameters:** None

---

### `list_tags`

**Parameters:** `starting_after`, `per_page`, `search`

---

### Knowledge Base tools

Use **`list_helpcenters`** first to obtain `helpCenterId`. Collections and articles are scoped per help center and brand.

- **`list_collections`** — `helpCenterId` (required); optional `page`, `limit`, `collectionId`, `isRoot`
- **`get_collection`** — `id`; optional `page`, `limit` for articles
- **`create_collection`** — `name`, `helpCenterId`, `brandId`; optional `description`, `parentCollectionId`
- **`list_articles`** — `helpCenterId` (required); optional `published`, `draft`, `archived`, `page`, `limit`, `search`, `collectionId`
- **`get_article`** — `id`
- **`create_article`** — `helpCenterId`, `brandId`; optional `title`, `content` (HTML), `publish`, `collectionId`, `isPublic` (publish flow per API docs)
- **`update_article`** — `id`; optional `title`, `content`, `collectionId` (null to remove from collection), `brandId`, `publish`, `isPublic`, `aiAgentEnabled`, `aiCopilotEnabled`
- **`archive_article`** — `id`

---

## Local Development

See [SETUP.md](./SETUP.md) for local development instructions, environment variables, and Docker setup.
