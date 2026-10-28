# Demo data seed kit

Seeds a SparrowDesk account with realistic support conversations through the SparrowDesk MCP connector. It works in Claude Code and in claude.ai / Claude Desktop with code execution on.

| File | What it is |
|------|------------|
| `SEED_PROMPT.md` | The prompt to paste into Claude. It asks for the options, builds the payloads with the embedded script, then imports. |
| `demo-conversations.csv` | 100 conversation threads (486 messages) between 40 customers at 12 fictional companies. They cover 10 categories and three channels (email, chat, web form), with a mix of statuses. |

## Sharing it

Send both files. The person attaches the CSV, pastes everything below the line in `SEED_PROMPT.md`, and answers the option questions. Claude asks for:
- the number of conversations (up to 100)
- the date range
- the average messages per conversation
- which agents to assign
- the product and company names used in the text
- the status mix
- whether to include internal notes
- business hours for agent replies
- the cleanup tag

It needs the import tools added to the connector (`import_conversations`, `import_conversation_replies` and their status tools).

## How the data is written

- Conversations and replies go through the import endpoints. Timestamps are backdated, customers get no emails, and no workflows or SLAs run.
- Customers use reserved `*.example.com` / `example.net` addresses.
- Every conversation gets the cleanup tag (default `demo-data`) plus tags for its category and channel.
- External ids look like `sd-demo-<run>-C001` and `sd-demo-<run>-C001-3`. Re-running with the same `run` resumes an interrupted seed without creating duplicates.

## CSV format

One row per message, in order. The conversation-level columns are filled only on the row where `msg_seq` is 1.

| Column | Meaning |
|--------|---------|
| `conv_key`, `msg_seq` | Thread id (`C001`–`C100`) and message position |
| `author` | `requester`, `agent` or `note` (an internal note by the assignee) |
| `gap_minutes` | Minutes since the previous message |
| `drop_group` | Messages with the same number can be removed together without breaking the thread. Used to hit the requested average message count. |
| `body_html` | Message body. May contain `{{product}}`, `{{company}}` and `{{agent_name}}`. |
| `subject`, `category`, `channel`, `priority`, `end_status`, `tags` | Conversation fields. `end_status` matches how the thread ends. |
| `requester_*`, `company_name`, `company_domain` | The customer, and the company if they belong to one |
| `assignee_ref` | `agent_1`–`agent_4`, mapped to real members at seed time |

If you edit the dataset, keep these rules, which the builder script relies on:
- Each thread has 2–8 messages and starts with the requester.
- `end_status` matches the last non-note message:
  - Open ends with the requester.
  - Pending ends with the agent asking for something.
  - Resolved and Closed end with the agent's fix, or the customer's thanks.
- That last message isn't in a drop group, and at least 2 messages remain after every drop group is removed.
- `assignee_ref` is blank only on Open threads that have no agent messages.
- A given email always has the same name and company.
