# Claude Connectors Directory — submission packet

Everything needed for the submission portal at
<https://claude.ai/admin-settings/directory/submissions/new>, step by step.

Requirements source: [submission docs](https://claude.com/docs/connectors/building/submission) ·
[review criteria](https://claude.com/docs/connectors/building/review-criteria)

---

## Before you open the portal

| # | Item | Status |
|---|------|--------|
| 1 | Every tool has a `title` + `readOnlyHint`/`destructiveHint` | Done in code — **must be deployed** |
| 2 | Read and write split into separate tools (no catch-all `api_request`) | Already true |
| 3 | Tool names ≤ 64 chars | Already true (longest: `list_conversations_with_replies`, 31) |
| 4 | OAuth 2.0 with dynamic client registration + PKCE | Live and verified |
| 5 | Server on HTTPS, production hosting | `https://mcp.sparrowdesk.com/mcp` — 200 OK |
| 6 | Public documentation URL | `https://developer.sparrowdesk.com/mcp` — 200 OK |
| 7 | Privacy policy URL | `https://www.sparrowdesk.com/legal/privacy-policy` — 200 OK |
| 8 | Icon (PNG) | **You need to supply this** |
| 9 | Test account, fully populated | **You need to create this** |
| 10 | Support contact email | **You need to decide this** |
| 11 | Every tool exercised via MCP Inspector or a custom connector | **You need to confirm this** |

**Sequencing matters.** The portal's Tools step syncs tool metadata live from
`mcp.sparrowdesk.com`. The `title`/annotation fixes are on the
`add-company-and-with-replies-tools` branch, not on `main`. Merge and deploy
first, or the portal will flag every tool for missing titles.

---

## Step 2 — Connection

- **Server URL:** `https://mcp.sparrowdesk.com/mcp`
- **Transport:** Streamable HTTP
- **Same URL for every user:** yes (account is resolved from the OAuth token, not the URL)

## Step 3 — Tools

36 tools sync automatically. They group as:

- **Read-only (20):** `get_conversation`, `list_conversations`,
  `list_conversations_with_replies`, `list_conversation_replies`,
  `list_conversation_fields`, `get_conversation_field`, `get_contact`,
  `list_contacts`, `list_contact_fields`, `get_bulk_job_status`,
  `list_companies`, `get_company`, `list_helpcenters`, `list_articles`,
  `get_article`, `list_collections`, `get_collection`, `list_members`,
  `get_me`, `list_tags`
- **Write, additive (7):** `create_conversation`, `create_conversation_field`,
  `create_contact`, `bulk_create_contacts`, `create_company`,
  `create_article`, `create_collection`
- **Write, destructive (9):** `add_conversation_reply` (sends customer-visible
  email), `update_conversation`, `delete_conversation`,
  `update_conversation_field`, `update_contact`, `delete_contact`,
  `update_company`, `update_article`, `archive_article`

## Step 4 — Listing

**Server name**

```
SparrowDesk
```

**Tagline** (55 max)

```
Run support from Claude: tickets, contacts, articles
```

**Description** (2,000 max)

```
SparrowDesk is a helpdesk your team runs itself — email, chat, and tickets in
one place, with AI built in.

This connector puts your helpdesk in Claude. Ask for the tickets that came in
overnight, and Claude reads them. Ask what a customer has written before, and
Claude pulls their history. Draft a reply, create the ticket, bump the
priority, write the help center article: you say what you want, Claude does
the typing.

What you can do:

- Read and search conversations, with replies and internal notes inlined
- Filter by status, priority, assignee, team, brand, or requester
- Create tickets, reply to customers, add internal notes, update status and
  assignment
- Look up contacts and companies, create them, keep their details current
- Read, write, and publish Knowledge Base articles and collections
- List team members, tags, and custom conversation fields

You stay in control. Claude asks before anything writes, replies, or deletes.
Reads run without a prompt, so asking about your queue stays quick.

Sign in with OAuth using your existing SparrowDesk account — there are no API
keys to manage. Claude sees only what your account's permissions allow, and
every action is recorded against your user in SparrowDesk.

Requires a SparrowDesk account. Setup and tool reference:
developer.sparrowdesk.com/mcp
```

**Categories** (1–5, pick from the portal's list): Customer support first, then
Productivity. Add Knowledge management / Content if offered.

**Documentation URL:** `https://developer.sparrowdesk.com/mcp`
**Privacy policy URL:** `https://www.sparrowdesk.com/legal/privacy-policy`
**Support contact:** _decide — a monitored address, e.g. `support@sparrowdesk.com`_
**Icon:** _supply PNG_
**Slug:** `sparrowdesk` — permanent once published

## Step 5 — Use cases

**Primary use cases**

1. Triage the queue in conversation: "what came in overnight", "which urgent
   tickets are unassigned", "summarise this customer's history before I reply."
2. Draft and send replies and internal notes without leaving Claude, with the
   ticket's full thread as context.
3. Turn resolved tickets into Knowledge Base articles — read the thread, write
   the article, publish it to a collection.
4. Keep contact and company records current: look up a requester, create a
   missing contact, bulk-import a list.
5. Report on the queue: filter by status, priority, assignee, team, or brand
   and ask Claude to summarise the pattern.

**What users need first:** a SparrowDesk account, and a user whose role grants
the relevant permissions (viewing and editing tickets, contacts, and — for
Knowledge Base tools — collections). The connector requests these scopes at
sign-in; the account's own permissions still apply on every call.

**Reads or writes:** both.

## Step 6 — Company

- **Company:** SurveySparrow (SparrowDesk)
- **Website:** `https://www.sparrowdesk.com`
- **Primary contact:** _pre-filled from your account — confirm it's monitored_

## Step 7 — Authentication

OAuth 2.0 with **dynamic client registration** (RFC 7591) and PKCE (S256).
Nothing needs to be held by Anthropic.

Verified live:

- `GET /.well-known/oauth-authorization-server` → issuer, authorize, token, register
- `GET /.well-known/oauth-protected-resource` → resource metadata
- `POST /oauth/register` → per-client `client_id`
- Unauthenticated `/mcp` → `401` with `WWW-Authenticate: Bearer resource_metadata=...`

No tool prompts for auth on demand; the whole server is behind OAuth.

## Step 8 — Data handling

- **API ownership:** first-party. The server calls SparrowDesk's own public API
  (`api.sparrowdesk.com`), and the MCP host domain matches the service.
- **Personal health data:** no.
- **Sponsored content:** no.
- Note for the reviewer: ticket content is customer support correspondence, so
  it can contain personal data that the account's own users entered. The
  connector reads and writes it under the signed-in user's permissions and
  stores nothing beyond in-memory OAuth session state.

## Step 9 — Test & launch

Reviewers need to reach the server end to end. Provide:

1. Connector URL: `https://mcp.sparrowdesk.com/mcp`
2. Test account credentials for a **populated** SparrowDesk account — needs
   conversations across several statuses and priorities, contacts, companies,
   at least one help center with published articles and collections, a couple
   of team members, tags, and one custom conversation field.
3. The exact sign-in steps: connect the connector → browser opens the
   SparrowDesk login → sign in with the test credentials → consent → returns to
   Claude.
4. Suggested first calls: `get_me`, then `list_conversations`, then
   `get_conversation` on an ID from that list.

Also confirm you've run every tool yourself — MCP Inspector or as a custom
connector in Claude — before ticking this step.

## Step 10 — Compliance

Seven acknowledgments, all required. Notes on the ones with substance:

- **First-party API usage:** yes, SparrowDesk's own API.
- **Financial transactions:** none.
- **AI media generation:** none.
- **Prompt injection:** tool descriptions state only what each tool does; none
  instruct Claude to call other software or fetch behavioural instructions.
- **Conversation data collection:** the server stores no conversation data;
  requests are proxied to the SparrowDesk API and only OAuth session state is
  held in memory.
- **Public documentation:** live at `developer.sparrowdesk.com/mcp`.

---

## Recommended before submitting (not strictly required)

1. **Rate limiting is keyed by IP.** `/mcp` allows 100 requests/minute per IP
   (`src/index.ts`). Traffic from Claude arrives from Anthropic's shared egress
   addresses, so many users — and the reviewer — can collectively exhaust one
   bucket and see 429s. Key the limiter on the bearer token instead.
2. **OAuth sessions are in-memory.** A restart or a second replica signs
   everyone out (`src/index.ts` notes this), and `MAX_SESSIONS` (10,000) has no
   eviction, so a full map rejects new sign-ins with 429. Fine for a small beta,
   thin for a directory listing.
3. **`MCP_PUBLIC_URL` defaults to `https://mcp.campaignsparrow.com`.** Reviewers
   expect the server domain to match the service. Production sets the env var,
   so this is cosmetic — but worth changing the default to
   `https://mcp.sparrowdesk.com` once you've confirmed nothing relies on it.
