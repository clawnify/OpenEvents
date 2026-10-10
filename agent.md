# OpenEvents: agent guide

## What you do, and what you must not

**You work the event's portal. The app holds the record and the approvals.**

- **You** open the event's attendee portal in your own logged-in browser, read
  profiles and company sites, draft messages, send what was approved, and read
  replies.
- **The app** decides who has already been contacted (across every event), which
  messages may go out, and what was sent.

The wrong moves, said out loud:

- **Never send a message the app does not list as approved.** You cannot approve
  one: the app refuses an agent's approval or text change with `403`. A person
  approves in the app.
- **Never copy the attendee directory in bulk** into a file, a spreadsheet or
  another outreach tool. Open profiles one at a time, within the event's limits.
- **Never type a password or ticket number.** On a login page, report the run as
  `blocked` with `error: "login_required"`; the person signs in through your
  browser.
- **Never claim a past meeting, a booth visit or anything that did not happen.**

## The procedure

Work arrives as a **run**: one of `shortlist`, `send` or `inbox`, each with its
own procedure. A run started from the app's buttons reaches you with the full
procedure and its `run_id` in the instruction. Follow that text.

When a person asks you in chat ("find people for Growth Week", "check my event
inbox"):

1. `GET /api/events?search=` to find the event. Its settings say who to look for,
   what to offer and the portal's quirks (`platform_notes`).
2. `POST /api/events/{id}/runs` with a new UUID and the kind. The response holds
   `instruction`: the same procedure a dispatched run carries. Follow it exactly.
3. Report as you go with `PATCH /api/runs/{id}`: `{status: running}` at least every
   10 minutes, then `done` with `coverage`, or `failed`/`blocked` with `error`.

Asked to approve or send something directly in chat: you cannot approve. Tell the
person their drafts are in the event's **To approve** tab.

## Pages

- `/`: every event with what waits on the person (drafts, replies).
- `/events/{id}`: one event. Tabs: People, To approve, Inbox, Meetings, Runs,
  Settings. `?tab=approve` is the screen to point a person at.
- `/events/{id}/people/{attendee_id}`: one person, the conversation, meetings.

## API anchors

- `GET /api/events/{id}`: settings, counts, and `resolved_offer` (what to pitch).
- `POST /api/runs/{id}/attendees`: shortlisted people with drafts, up to 25 a call.
  Rows answer `created`, `duplicate` (listed already, or contacted at another
  event: never draft for them) or `limit_reached` (stop).
- `GET /api/events/{id}/messages?status=approved`: what a send run sends.
- `PATCH /api/messages/{id}`: `{status: sent}`, or `failed`/`held` with `error`.
- `POST /api/runs/{id}/inbound` and `POST /api/runs/{id}/meetings`: what other
  attendees wrote, and confirmed meetings. Repeats are dropped.
- `PATCH /api/events/{id}`: `{platform_notes: [...existing, new]}` when you learn
  a portal quirk.

Everything else: `/llms.txt`.

## Reading failures

- `410 run_closed`: the run is finished or was stopped by a person. Stop.
- `409 wrong_run`: you are using a run of another kind for this write.
- `409 run_in_progress`: another run of this kind is active for the event.
- `403 approval_required`: only a person can do this. Do not retry.
- `400 too_long`: the message is over the portal's limit; a person must shorten it.

## Cost

The app spends nothing. Your browsing is the cost: keep to the event's
`max_profiles`, `max_research` and `max_sends` per run.
