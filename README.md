# SparrowDesk MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for [SparrowDesk](https://sparrowdesk.com). Connect AI assistants like Claude to your SparrowDesk account to read and manage tickets, contacts, companies, Knowledge Base content, tags, and team data.

You sign in with OAuth, so there are no API keys to manage. The first time you connect, your MCP client opens a browser window to log in with your SparrowDesk account.

## Install

The server URL is the same for every user — your account comes from the OAuth token, not the URL:

```
https://mcp.sparrowdesk.com/mcp
```

**Claude Code:**

```bash
claude mcp add --transport http sparrowdesk https://mcp.sparrowdesk.com/mcp
```

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`~/.cursor/mcp.json`) take the same block:

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

Restart the app after saving. The SparrowDesk tools appear in the tool list, and the client opens a browser window to complete the OAuth login.

## Permissions

Tools mirror the [SparrowDesk Developer API](https://api.sparrowdesk.com/public-api/swagger.json), and each call runs under the permissions of the account you signed in with.

Knowledge Base tools need the collection and article scopes: `VIEW_COLLECTIONS` and `MANAGE_COLLECTIONS` for collections, `VIEW_ARTICLES` and `MANAGE_ARTICLES` for articles. All four are included in the MCP default scope list. Other Knowledge Base behavior can depend on further scopes or account features.

## Available Tools

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
| `list_conversations_with_replies` | List conversations with their replies inlined in one call |
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
| `get_company` | Retrieve a company by ID |
| `create_company` | Create a company |
| `update_company` | Update a company |
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

## Tool Reference

### Conversations

#### `get_conversation`

Fetch a single conversation by its numeric ID. Parameters: `id` (integer, required).

#### `list_conversations`

List conversations with optional filters, sorting, and pagination.

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

#### `list_conversations_with_replies`

List conversations with their replies inlined in a single call. It takes the same filters as `list_conversations` plus reply controls. Root `pages` and `total_count` apply to conversations only; each row carries a `replies` object shaped like `list_conversation_replies`.

- `starting_after` (string, optional) — Cursor for conversation list pagination
- `per_page` (integer, optional) — Conversations per page, 1–20 (default: 20)
- `replies_per_page` (integer, optional) — Replies per conversation, 1–50 (default: 50)
- `replies_sort_order` (string, optional) — Reply sort by `sent_at`: `asc` or `desc` (default: `desc`)
- `type` (string, optional) — Filter replies by `INTERNAL_NOTE` or `REPLY`
- `status`, `priority`, `assigned_to_member_id`, `assigned_to_team_id`, `brand_id`, `requested_by_id` — Same conversation filters as `list_conversations`
- `handled_by_ai_agent` (boolean, optional) — Filter by whether the conversation was handled by the AI agent
- `sort_by` (string, optional) — `created_at` or `updated_at` (default: `created_at`)
- `sort_order` (string, optional) — `asc` or `desc` (default: `desc`)

#### `list_conversation_replies`

List replies for a conversation, with optional filtering and pagination.

- `id` (integer, required) — The conversation ID
- `starting_after` (string, optional) — Pagination cursor
- `per_page` (integer, optional) — Items per page, 1–100 (default: 25)
- `type` (string, optional) — Filter by `INTERNAL_NOTE` or `REPLY`
- `sort_order` (string, optional) — `asc` or `desc` (default: `desc`)

#### `add_conversation_reply`

Add a reply or internal note to a conversation.

- `id` (integer, required) — The conversation ID
- `reply_text` (string, required) — The content of the reply message
- `type` (string, required) — `REPLY` (visible to the customer) or `INTERNAL_NOTE` (agents only)

#### `create_conversation`

Create a new conversation/ticket in SparrowDesk.

- `subject` (string, required) — Conversation subject
- `description` (string, required) — Conversation description
- `requested_by` (string, required) — Email or phone number of the requester
- `priority` (string, optional) — `Low`, `Medium`, `High`, or `Urgent` (default: `Medium`)
- `source` (string, optional) — `Mail` or `Call` (default: `Call`)
- `status` (string, optional) — `Open`, `Pending`, `Resolved`, or `Closed` (default: `Open`)
- `brand_id` (integer, optional) — Brand ID (uses the account default if omitted)
- `assignee` (string, optional) — Agent email address to assign the conversation to
- `team_id` (integer, optional) — Team ID to assign the conversation to
- `custom_fields` (array, optional) — Array of `{ internal_name, value }` objects

#### `update_conversation`

Patch an existing conversation.

- `id` (integer, required) — Conversation ID
- `subject`, `priority`, `status`, `assignee` (email), `team` (string) — Optional updates
- `custom_fields` (array, optional) — `{ internal_name, value }` (values as strings)

#### `delete_conversation`

Delete a conversation. Parameters: `id` (integer, required).

### Conversation fields

- `list_conversation_fields` — `starting_after`, `per_page`, `is_active`, `is_default`
- `get_conversation_field` — `id`
- `create_conversation_field` — `name`, `type` (`single_line_text` | `multi_line_text` | `dropdown` | `number` | `date` | `email`), optional `internal_name`, `description`, `is_mandatory_on_close`, `field_options` (required for dropdowns)
- `update_conversation_field` — `id` plus any of `name`, `description`, `is_active`, `is_mandatory_on_close`, `field_options`

### Contacts

#### `list_contacts`

List contacts with filters. Requires the view contacts scope where the account enforces it.

Parameters: `search`, `requested_by_email`, `requested_by_phone`, `starting_after`, `per_page`.

#### `get_contact`

Fetch a single contact by its numeric ID. Parameters: `id` (integer, required).

#### `create_contact`

Create a new contact. Give either `email` or `phone`.

- `first_name` (string, required) — Contact's first name
- `last_name` (string, optional) — Contact's last name
- `email` (string, optional) — Contact's email address (required if `phone` is omitted)
- `phone` (string, optional) — Contact's phone number (required if `email` is omitted)
- `company_id` (integer, optional) — ID of the company to associate with
- `custom_fields` (object, optional) — Custom field key-value pairs

#### `update_contact`

Update an existing contact.

- `id` (integer, required) — The contact ID to update
- `first_name` (string, optional) — Contact's first name
- `last_name` (string, optional) — Contact's last name
- `email` (string, optional) — Contact's email address
- `phone` (string, optional) — Contact's phone number
- `company_id` (integer, optional) — ID of the company to associate with
- `blocked` (boolean, optional) — Whether the contact is blocked
- `custom_fields` (object, optional) — Custom field key-value pairs

#### `delete_contact`

Delete a contact. Parameters: `id` (integer, required).

#### `bulk_create_contacts` and `get_bulk_job_status`

`bulk_create_contacts` accepts `contacts`: an array of objects with optional `first_name`, `last_name`, `email`, `phone`, `company_id`, and `custom_fields`. The response includes a `job_id`. Poll `get_bulk_job_status` with that `job_id` until the job reports `completed` or `failed`.

### Contact fields

#### `list_contact_fields`

Retrieve all contact fields defined in the account.

- `search` (string, optional) — Search contact fields by name
- `page` (integer, optional) — Page number for pagination
- `limit` (integer, optional) — Results per page

### Companies

#### `list_companies`

Parameters: `starting_after`, `per_page`, `domain` (exact), `name` (exact).

#### `get_company`

Fetch a single company by its numeric ID. Parameters: `id` (integer, required).

#### `create_company`

Create a new company.

- `name` (string, required) — Company name
- `domain` (string, optional) — Lowercase domain like `example.com`
- `address` (string, optional) — Company address
- `notes` (string, optional) — Free-form notes

#### `update_company`

Update an existing company. Give at least one field besides `id`.

- `id` (integer, required) — The company ID to update
- `name`, `domain`, `phone`, `address`, `notes` — Optional updates

### Knowledge Base

Call `list_helpcenters` first to get a `helpCenterId`. Collections and articles are scoped per help center and brand.

Reads need `VIEW_COLLECTIONS` / `VIEW_ARTICLES`; writes need `MANAGE_COLLECTIONS` / `MANAGE_ARTICLES`.

- `list_helpcenters` — no parameters
- `list_collections` — `helpCenterId` (required); optional `page`, `limit`, `collectionId`, `isRoot` — needs `VIEW_COLLECTIONS`
- `get_collection` — `id`; optional `page`, `limit` for articles — needs `VIEW_COLLECTIONS`
- `create_collection` — `name`, `helpCenterId`, `brandId`; optional `description`, `parentCollectionId` — needs `MANAGE_COLLECTIONS`
- `list_articles` — `helpCenterId` (required); optional `published`, `draft`, `archived`, `page`, `limit`, `search`, `collectionId` — needs `VIEW_ARTICLES`
- `get_article` — `id` — needs `VIEW_ARTICLES`
- `create_article` — `helpCenterId`, `brandId`; optional `title`, `content` (HTML), `publish`, `collectionId`, `isPublic` (publish flow per the API docs) — needs `MANAGE_ARTICLES`
- `update_article` — `id`; optional `title`, `content`, `collectionId` (null to remove from collection), `brandId`, `publish`, `isPublic`, `aiAgentEnabled`, `aiCopilotEnabled` — needs `MANAGE_ARTICLES`
- `archive_article` — `id` — needs `MANAGE_ARTICLES`

### Account

#### `get_me`

Retrieve current SparrowDesk account information: account ID, subdomain, domain, company name, timezone, and language. This is the account, not a user profile. Takes no parameters.

#### `list_members`

Retrieve a paginated list of all team members in the account.

- `starting_after` (string, optional) — Pagination cursor
- `per_page` (integer, optional) — Items per page, 1–100 (default: 25)

#### `list_tags`

Parameters: `starting_after`, `per_page`, `search`.

## Privacy Policy

This server proxies requests to the SparrowDesk API on behalf of the signed-in user. It stores no ticket, contact, or Knowledge Base content, only in-memory OAuth session state (access and refresh tokens), which it discards when the process restarts. What the server can read or write is bounded by the permissions of the SparrowDesk account you sign in with, and SparrowDesk records every action against your user.

Data collection, storage, retention, third-party sharing, and contact details are covered in the [SparrowDesk Privacy Policy](https://www.sparrowdesk.com/legal/privacy-policy). Use of SparrowDesk is governed by the [Terms of Service](https://www.sparrowdesk.com/legal/terms-of-service).

## Support

For questions, see [developer.sparrowdesk.com/mcp](https://developer.sparrowdesk.com/mcp) or open an issue on this repository.

## Local Development

See [SETUP.md](./SETUP.md) for running the server locally, the environment variables it reads, Docker, and how to call the deployed server with curl.
