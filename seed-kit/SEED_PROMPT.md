# Seed SparrowDesk with demo data

Copy everything below the line into Claude (Claude Code, or claude.ai / Claude Desktop with code execution turned on), and attach `demo-conversations.csv` (in Claude Code you can give its path instead). The SparrowDesk connector must be connected (`https://mcp.sparrowdesk.com/mcp`).

---

You are going to seed my SparrowDesk account with realistic demo conversations, using the SparrowDesk MCP tools and the attached `demo-conversations.csv`. Follow these steps in order. Keep your messages to me short; don't paste large JSON into the chat.

## Ground rules

- Use only these tools to write data: `create_company`, `bulk_create_contacts`, `import_conversations`, `import_conversation_replies`. Never use `create_conversation` or `add_conversation_reply` here: they email customers and run workflows.
- Only use member emails and ids returned by the tools. Never invent them.
- Build the payloads by running the Python script at the end of this prompt. Don't calculate timestamps or rewrite message text yourself. If you can't run Python, tell me this needs Claude Code or claude.ai with code execution, and stop.
- Write the script and its output to a scratch/temp directory, not into any project folder.
- Stop and tell me if a step fails twice in a row.

## Step 1: Check the connection

1. Check that `import_conversations`, `import_conversation_replies`, `get_conversation_import_status` and `get_reply_import_status` are available. If any are missing, tell me to reconnect or update the SparrowDesk connector, and stop.
2. Call `get_me`. Note `domain`, `company_name` and `time_zone`.
3. Call `list_members` (`per_page` 100). Keep the verified human members (skip AI or bot members).
4. Find the current UTC time with code (`datetime.now(timezone.utc)`).

## Step 2: Ask me for the options

Send me one message showing the account `domain` and these questions with their defaults. I can answer "defaults", or change only some of them.

1. **Account check:** is `<domain>` the account to seed? (Must be yes.)
2. **Conversations:** how many, 1–100. Default 30.
3. **Date range:** "last N days" or `YYYY-MM-DD to YYYY-MM-DD`. Default: the last 30 days. Nothing can be in the future.
4. **Messages per conversation:** the average, counting the opening message and internal notes. Default 4. The dataset supports roughly 3.5–5; you'll show the exact range for my selection.
5. **Agents:** which members to assign conversations to (up to 4). Default: the first 4 verified members. List their names so I can choose.
6. **Names used in the text:** product name and company name. Default: `company_name` for both.
7. **Status mix:** `realistic` (about 27% open or pending), `resolved` (mostly closed out) or `busy` (a backlog of more than 50% open or pending). Default `realistic`.
8. **Internal notes:** include them, yes or no. Default yes.
9. **Business hours:** should agent replies happen only on weekdays from 09:00 to 18:00 in `time_zone`? Default yes.
10. **Tag:** the tag put on every seeded conversation, for finding and cleaning up later. Default `demo-data`.

## Step 3: Build and confirm the plan

1. Save the script below as `build_seed_plan.py`.
2. Build the options JSON:
   - `count`, `from`, `to` (dates, `YYYY-MM-DD`), `avg_messages`
   - `now`: the UTC time in ISO-8601
   - `timezone`, `business_hours`, `notes`, `status_mix`, `tag`, `product`, `company`
   - `run`: `"v1"`
   - `agents`: map `agent_1`…`agent_4` to `{"email", "name"}` of the chosen members. With fewer than 4 members, repeat them round-robin.
3. Run `python3 build_seed_plan.py <csv path> '<options json>' > plan.json`.
4. Show me the `summary`. If `avg_messages` is outside `avg_messages_range_for_this_selection`, say so: the closest possible value was used. Wait for me to say go.

`plan.json` contains:
- `companies`: `{name, domain}`
- `contacts`: `{first_name, last_name, email, company_domain}`
- `conversation_batches`: lists of `import_conversations` items, ready to send
- `reply_batches`: lists of `{external_id, replies}`, where `external_id` is the conversation's external_id

## Step 4: Seed

Read each batch from `plan.json` and pass it to the tool exactly as it is.

1. **Companies:** for each company, call `list_companies` with `domain`. Reuse the id if one exists; otherwise call `create_company` with `name` and `domain`. Keep a map from domain to id.
2. **Contacts:** call `bulk_create_contacts` once with every contact as `{first_name, last_name, email, company_ids: [<id for company_domain>]}`. Leave out `company_ids` when there is no company. Poll `get_bulk_job_status` until it finishes. Rows that fail because the contact already exists are fine.
3. **Conversations:** for each batch in `conversation_batches`:
   - Call `import_conversations` with `{conversations: <batch>}`.
   - Poll `get_conversation_import_status` with the `job_id` until the status is `completed`, `partial` or `failed`.
   - Record `external_id → conversation_id` from `results`. Include `skipped` results, which are conversations an earlier run already imported. Their replies are sent again in step 4, and any replies that already exist are skipped.
4. **Replies:** for each batch in `reply_batches`:
   - Turn each entry into `{conversation_id, replies}` using the map from step 3. Drop entries without a `conversation_id`.
   - Call `import_conversation_replies` with `{items: [...]}`.
   - If `rate_limited` is true, the account's per-minute API limit was hit. Tell me, and once about a minute has passed (or I say continue), resend only the items whose status is `not_attempted`, or `error` with a 429.
   - Retry any other error once.
5. **Check:** call `get_reply_import_status` for the last job of each batch until it's `completed`. Then call `list_conversation_replies` for one seeded conversation and confirm the thread looks right.

Re-running with the same `run` value is safe: items that were already imported are skipped by `external_id`.

## Step 5: Report

Tell me:
- conversations, replies, contacts and companies created
- any failures, with their reasons
- the range of dates covered
- that every seeded conversation has the tag I chose, contacts use `example.com` / `example.net` addresses, and to remove the data you can delete the conversations by id. List the ids.

## Script: `build_seed_plan.py`

```python
"""Turn demo-conversations.csv + the user's answers into SparrowDesk MCP import payloads.

Usage: python3 build_seed_plan.py <csv_path> '<options json>'  (prints the plan as JSON)
Options: count, from, to (YYYY-MM-DD), avg_messages, now (ISO-8601), agents ({"agent_1": {"email", "name"}, ...}),
         product, company, timezone, business_hours, notes, status_mix (realistic|resolved|busy), run, seed.
"""
import csv
import html
import json
import random
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

STATUS_MIX = {
    "realistic": {"Open": 0.15, "Pending": 0.12, "Resolved": 0.55, "Closed": 0.18},
    "resolved": {"Open": 0.05, "Pending": 0.05, "Resolved": 0.65, "Closed": 0.25},
    "busy": {"Open": 0.35, "Pending": 0.20, "Resolved": 0.35, "Closed": 0.10},
}
CONV_BATCH = 25
REPLY_BATCH = 10
OPEN_DAY, CLOSE_DAY = 9, 18


def load_pool(path):
    convs = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            key = row["conv_key"]
            if row["msg_seq"] == "1":
                convs[key] = {**row, "messages": []}
            convs[key]["messages"].append({
                "seq": int(row["msg_seq"]),
                "author": row["author"],
                "gap": int(row["gap_minutes"]),
                "drop": row["drop_group"],
                "body": row["body_html"],
            })
    return list(convs.values())


def pick(pool, count, mix, rng):
    by_status = defaultdict(list)
    for c in pool:
        by_status[c["end_status"]].append(c)
    quotas = {s: round(count * share) for s, share in mix.items()}
    while sum(quotas.values()) != count:  # fix rounding drift on the biggest bucket
        biggest = max(quotas, key=quotas.get)
        quotas[biggest] += 1 if sum(quotas.values()) < count else -1
    chosen = []
    for status, quota in quotas.items():
        # Round-robin over categories so a small sample still covers many of them.
        by_cat = defaultdict(list)
        for c in rng.sample(by_status[status], len(by_status[status])):
            by_cat[c["category"]].append(c)
        cats = sorted(by_cat, key=lambda _: rng.random())
        while len([c for c in chosen if c["end_status"] == status]) < min(quota, len(by_status[status])):
            for cat in cats:
                if by_cat[cat] and len([c for c in chosen if c["end_status"] == status]) < quota:
                    chosen.append(by_cat[cat].pop())
    # A status bucket smaller than its quota is topped up from the rest of the pool.
    rest = [c for c in pool if c not in chosen]
    rng.shuffle(rest)
    chosen += rest[: count - len(chosen)]
    return chosen


def trim(chosen, avg, notes, rng):
    """Drop whole drop groups (and notes, if disabled) until the average message count reaches avg."""
    for c in chosen:
        c["keep"] = [m for m in c["messages"] if notes or m["author"] != "note"]
    groups = [(c, g) for c in chosen for g in sorted({m["drop"] for m in c["keep"] if m["drop"]})]
    rng.shuffle(groups)
    target_total = avg * len(chosen)
    for c, g in groups:
        total = sum(len(x["keep"]) for x in chosen)
        size = len([m for m in c["keep"] if m["drop"] == g])
        if total - size < target_total - 0.5 * size:
            continue  # dropping this group would undershoot more than it helps
        if total <= target_total:
            break
        c["keep"] = [m for m in c["keep"] if m["drop"] != g]


def business_slot(t, tz, rng):
    """Move t forward to the next weekday business-hours moment (local time)."""
    local = t.astimezone(tz)
    if local.weekday() < 5 and OPEN_DAY <= local.hour < CLOSE_DAY:
        return t
    day = local.date() if local.hour < OPEN_DAY else local.date() + timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    start = datetime(day.year, day.month, day.day, OPEN_DAY, tzinfo=tz) + timedelta(minutes=rng.randint(3, 50))
    return start.astimezone(timezone.utc)


def schedule(c, start, tz, business_hours, rng):
    times, t = [], start
    for i, m in enumerate(c["keep"]):
        t = t + timedelta(minutes=m["gap"]) if i else t
        if business_hours and m["author"] != "requester":
            t = business_slot(t, tz, rng)
        times.append(t)
    return times


def place(chosen, window_from, window_to, tz, business_hours, rng):
    span = (window_to - window_from).total_seconds()
    recent = max(timedelta(days=2).total_seconds(), span * 0.1)
    for c in chosen:
        unresolved = c["end_status"] in ("Open", "Pending")
        lo = window_to.timestamp() - recent if unresolved else window_from.timestamp()
        lo = max(lo, window_from.timestamp())
        for _ in range(40):
            start = datetime.fromtimestamp(rng.uniform(lo, window_to.timestamp()), timezone.utc)
            if business_hours:
                start = business_slot(start, tz, rng)
            times = schedule(c, start, tz, business_hours, rng)
            if times[-1] <= window_to:
                break
            lo = window_from.timestamp()  # thread too long for the recent window; allow anywhere
        else:
            # Still overflowing: end the thread at window_to, keeping its gaps.
            times = schedule(c, window_from, tz, False, rng)
            shift = window_to - times[-1]
            times = [t + shift for t in times]
        c["times"] = times


def fill(text, values):
    for k, v in values.items():
        text = text.replace("{{" + k + "}}", html.escape(v))
    return text


def iso(t):
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    path, opts = sys.argv[1], json.loads(sys.argv[2])
    count = int(opts.get("count", 30))
    avg = float(opts.get("avg_messages", 4))
    if not 1 <= count <= 100:
        sys.exit("count must be 1-100")
    rng = random.Random(opts.get("seed", 7))
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(opts.get("timezone") or "UTC")
    except Exception:
        tz = timezone.utc
    now = datetime.fromisoformat(opts["now"].replace("Z", "+00:00")).astimezone(timezone.utc)
    latest = now - timedelta(minutes=15)  # imports reject future timestamps
    window_from = datetime.fromisoformat(opts["from"]).replace(tzinfo=tz).astimezone(timezone.utc)
    window_to = min(datetime.fromisoformat(opts["to"]).replace(tzinfo=tz) + timedelta(days=1), latest)
    window_to = window_to.astimezone(timezone.utc)
    if window_to <= window_from:
        sys.exit("date range is empty or entirely in the future")

    agents = opts["agents"]
    refs = sorted({c["assignee_ref"] for c in load_pool(path) if c["assignee_ref"]})
    missing = [r for r in refs if r not in agents]
    if missing:
        sys.exit(f"agents must map every assignee_ref: missing {missing}")
    run = opts.get("run", "v1")
    tag = opts.get("tag", "demo-data")
    base = {"product": opts.get("product", "our app"), "company": opts.get("company", "our team")}

    chosen = pick(load_pool(path), count, STATUS_MIX[opts.get("status_mix", "realistic")], rng)
    trim(chosen, avg, opts.get("notes", True), rng)
    place(chosen, window_from, window_to, tz, opts.get("business_hours", True), rng)
    chosen.sort(key=lambda c: c["times"][0])

    companies, contacts, conversations, replies = {}, {}, [], []
    for c in chosen:
        agent = agents.get(c["assignee_ref"]) if c["assignee_ref"] else None
        values = {**base, "agent_name": (agent["name"].split() or ["Support"])[0] if agent else "Support"}
        email = c["requester_email"]
        if c["company_domain"]:
            companies[c["company_domain"]] = {"name": c["company_name"], "domain": c["company_domain"]}
        contacts[email] = {"first_name": c["requester_first"], "last_name": c["requester_last"],
                           "email": email, "company_domain": c["company_domain"] or None}
        last_public = [i for i, m in enumerate(c["keep"]) if m["author"] != "note"][-1]
        conv = {
            "external_id": f"sd-demo-{run}-{c['conv_key']}",
            "subject": fill(c["subject"], base).replace("&amp;", "&"),
            "description_html": fill(c["keep"][0]["body"], values),
            "requester": {"email": email, "name": f"{c['requester_first']} {c['requester_last']}"},
            "created_at": iso(c["times"][0]),
            "status": c["end_status"],
            "priority": c["priority"],
            "tags": [tag, c["category"], c["channel"]] + [t for t in c["tags"].split(";") if t],
        }
        if agent:
            conv["assignee_email"] = agent["email"]
        if c["end_status"] in ("Resolved", "Closed"):
            conv["resolved_at"] = iso(c["times"][last_public])
        conversations.append(conv)
        thread = []
        for m, t in zip(c["keep"][1:], c["times"][1:]):
            thread.append({
                "external_id": f"sd-demo-{run}-{c['conv_key']}-{m['seq']}",
                "author_type": "requester" if m["author"] == "requester" else "agent",
                "author_email": email if m["author"] == "requester" else agent["email"],
                "public": m["author"] != "note",
                "html_body": fill(m["body"], values),
                "created_at": iso(t),
            })
        if thread:
            replies.append({"external_id": conv["external_id"], "replies": thread})

    msgs = [len(c["keep"]) for c in chosen]
    plan = {
        "summary": {
            "conversations": len(conversations),
            "messages": sum(msgs),
            "avg_messages": round(sum(msgs) / len(msgs), 2),
            "avg_messages_range_for_this_selection": [
                round(sum(len([m for m in c["messages"] if not m["drop"] and (opts.get("notes", True) or m["author"] != "note")]) for c in chosen) / len(chosen), 2),
                round(sum(len([m for m in c["messages"] if opts.get("notes", True) or m["author"] != "note"]) for c in chosen) / len(chosen), 2),
            ],
            "by_status": {s: sum(1 for c in conversations if c["status"] == s) for s in STATUS_MIX["realistic"]},
            "first_created_at": conversations[0]["created_at"],
            "last_message_at": iso(max(c["times"][-1] for c in chosen)),
            "companies": len(companies),
            "contacts": len(contacts),
            "replies": sum(len(r["replies"]) for r in replies),
        },
        "companies": list(companies.values()),
        "contacts": list(contacts.values()),
        "conversation_batches": [conversations[i:i + CONV_BATCH] for i in range(0, len(conversations), CONV_BATCH)],
        "reply_batches": [replies[i:i + REPLY_BATCH] for i in range(0, len(replies), REPLY_BATCH)],
    }
    json.dump(plan, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
```
