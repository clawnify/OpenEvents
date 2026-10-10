import { caller, createApp, createRoute, pagedResponse, pageParams, PageQuery, user, widgets, z } from "@clawnify/app";
import type { Context } from "hono";
import { createAgents, ClawnifyAgentsError, type AgentsEnv } from "@clawnify/agents";
import { offering } from "@clawnify/knowledge";
import { get, initDB, query, run } from "./db.js";
import { runBrief } from "./brief.js";
import { SKILLS } from "./skills.gen.js";
import {
  InputError, WAITING_SQL, addAttendees, addInbound, addMeetings, clearInbox, createRun, eventCounts,
  listRuns, notes, openRun, readAttendee, readEvent, readMessage, readRun, setAttendeeStatus, updateMessage, updateRun,
  writeMessage, type Actor, type AttendeeRow, type EventRow, type MessageRow, type RunKind, type RunRow,
} from "./domain.js";

type Env = { Bindings: AgentsEnv & { DB: D1Database } };
type C = Context<Env>;

const app = createApp<Env>({
  title: "OpenEvents",
  version: "1.0.0",
  description:
    "Work an event's attendee directory with your agent: shortlist people worth meeting, approve every message before it is sent through the event's own chat, and keep track of replies and meetings across events.",
});

// createApp initialises its own copy of the database client; this makes sure the
// copy these routes import is initialised too, whichever one the bundler resolves.
app.use("*", async (c, next) => {
  initDB(c.env);
  await next();
});

app.onError((err, c) => {
  if (err instanceof InputError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  if (err instanceof ClawnifyAgentsError) return c.json({ error: err.message, code: err.code }, 502);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

/**
 * Approving is the one thing an agent may never do for itself. A person in the
 * dashboard (or through their own access token) approves; an agent, its browser
 * driving this UI, or another app never does. Outside Clawnify (local dev) there
 * is no perimeter and the person at the keyboard is the approver.
 */
function actor(c: C): Actor {
  const who = caller(c);
  const u = user(c);
  if ((who === "user" || who === "api") && u) return { approver: true, name: u.name ?? u.email ?? "A teammate", avatar: u.avatarUrl };
  if (who === "public" && !c.env.CLAWNIFY_TOKEN) return { approver: true, name: "Local", avatar: null };
  return { approver: false, name: who, avatar: null };
}

const appUrl = (c: C) => new URL(c.req.url).origin;

// ── Schemas ─────────────────────────────────────────────────────────

const Id = z.string().uuid();
const IdParam = z.object({ id: Id.openapi({ param: { name: "id", in: "path" } }) });
const Err = z.object({ error: z.string(), code: z.string().optional() }).openapi("Error");
const errors = {
  400: { description: "Invalid input", content: { "application/json": { schema: Err } } },
  403: { description: "Needs a person", content: { "application/json": { schema: Err } } },
  404: { description: "Not found", content: { "application/json": { schema: Err } } },
  409: { description: "Conflict", content: { "application/json": { schema: Err } } },
  410: { description: "Run finished", content: { "application/json": { schema: Err } } },
};
const json = <T extends z.ZodTypeAny>(schema: T, description = "OK") => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { content: { "application/json": { schema } }, required: true } });

const Counts = z.object({
  people: z.number(), to_approve: z.number(), to_send: z.number(), needs_attention: z.number(),
  sent: z.number(), waiting: z.number(), meetings: z.number(),
}).openapi("EventCounts");

const EventFields = z.object({
  name: z.string().trim().min(1).max(200),
  portal_url: z.string().url().max(1000).openapi({ description: "The event's attendee portal, where the networking and chat are" }),
  starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  location: z.string().max(200).optional(),
  icp: z.string().max(4000).optional().openapi({ description: "Who is worth meeting at this event" }),
  offer: z.string().max(4000).optional().openapi({ description: "What we offer them. Empty: the org's pinned Company Knowledge offering" }),
  language: z.string().max(40).optional(),
  message_max_chars: z.number().int().min(80).max(5000).optional(),
  max_profiles: z.number().int().min(1).max(500).optional(),
  max_research: z.number().int().min(1).max(100).optional(),
  max_sends: z.number().int().min(1).max(200).optional(),
  platform_notes: z.array(z.string().trim().min(1).max(300)).max(30).optional().openapi({ description: "Quirks of this portal, learned by the agent" }),
  archived: z.boolean().optional(),
});

const Event = z.object({
  id: z.string(), name: z.string(), portal_url: z.string(), starts_on: z.string().nullable(), ends_on: z.string().nullable(),
  location: z.string(), icp: z.string(), offer: z.string(), language: z.string(), message_max_chars: z.number(),
  max_profiles: z.number(), max_research: z.number(), max_sends: z.number(), platform_notes: z.array(z.string()),
  archived: z.boolean(), created_at: z.string(), updated_at: z.string(), counts: Counts,
}).openapi("Event");

const EventDetail = Event.extend({
  resolved_offer: z.string().openapi({ description: "offer, or the org's pinned offering when offer is empty" }),
  offer_source: z.object({ title: z.string(), version: z.number(), url: z.string() }).nullable(),
}).openapi("EventDetail");

const Run = z.object({
  id: z.string(), event_id: z.string(), kind: z.enum(["shortlist", "send", "inbox"]),
  status: z.enum(["running", "done", "failed", "blocked"]), stale: z.boolean(), coverage: z.string(), error: z.string(),
  skill_version: z.string(), dispatched: z.boolean(), heartbeat_at: z.string().nullable(), finished_at: z.string().nullable(),
  stopped_by_name: z.string().nullable().openapi({ description: "The person who stopped the run; null when it ended itself" }),
  stopped_by_avatar: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
}).openapi("Run");

const Evidence = z.object({ url: z.string().url().max(1000), quote: z.string().trim().min(1).max(500) });
const Attendee = z.object({
  id: z.string(), event_id: z.string(), source: z.enum(["shortlist", "inbound"]), name: z.string(), title: z.string(),
  company: z.string(), domain: z.string(), portal_profile_url: z.string(), linkedin_url: z.string(),
  fit: z.enum(["strong", "maybe", "no"]).nullable(), why_fit: z.string(), evidence: z.array(z.object({ url: z.string(), quote: z.string() })),
  status: z.enum(["new", "contacted", "replied", "meeting", "skipped", "declined"]), waiting: z.boolean(),
  last_message: z.object({ direction: z.enum(["out", "in"]), status: z.string(), body: z.string(), created_at: z.string() }).nullable(),
  created_at: z.string(), updated_at: z.string(),
}).openapi("Attendee");

const Message = z.object({
  id: z.string(), event_id: z.string(), attendee_id: z.string(), direction: z.enum(["out", "in"]), body: z.string(),
  status: z.enum(["draft", "approved", "sent", "failed", "held", "discarded", "received"]), error: z.string(),
  author: z.enum(["agent", "user", "them"]), approved_by: z.string().nullable(), approved_at: z.string().nullable(),
  sent_at: z.string().nullable(), received_at: z.string().nullable(), thread_url: z.string(), created_at: z.string(),
  updated_at: z.string(),
  attendee: z.object({
    name: z.string(), title: z.string(), company: z.string(), domain: z.string(), portal_profile_url: z.string(),
    fit: z.enum(["strong", "maybe", "no"]).nullable(), why_fit: z.string(), evidence: z.array(z.object({ url: z.string(), quote: z.string() })),
  }).optional(),
}).openapi("Message");

const Meeting = z.object({
  id: z.string(), event_id: z.string(), attendee_id: z.string(), starts_at: z.string().nullable(), location: z.string(),
  portal_url: z.string(), created_at: z.string(), attendee: z.object({ name: z.string(), company: z.string() }),
}).openapi("Meeting");

// ── Presenters ──────────────────────────────────────────────────────

async function presentEvent(e: EventRow) {
  return { ...e, platform_notes: notes(e), archived: Boolean(e.archived), counts: await eventCounts(e.id) };
}

// A run handed over by hand counts as dispatched once the agent reports in.
const presentRun = (r: RunRow) => ({ ...r, stale: Boolean(r.stale), dispatched: Boolean(r.dispatched || r.heartbeat_at) });

type AttendeeListRow = AttendeeRow & { waiting: number; lm_direction: "out" | "in" | null; lm_status: string | null; lm_body: string | null; lm_created_at: string | null };
const ATTENDEE_SELECT = `a.*, ${WAITING_SQL} AS waiting,
  lm.direction lm_direction, lm.status lm_status, lm.body lm_body, lm.created_at lm_created_at
  FROM attendees a LEFT JOIN messages lm ON lm.id = (
    SELECT id FROM messages x WHERE x.attendee_id = a.id AND x.status != 'discarded' ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)`;

function parseEvidence(raw: string): { url: string; quote: string }[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // written by this app; unreadable means empty
  }
}

function presentAttendee(a: AttendeeListRow) {
  const { lm_direction, lm_status, lm_body, lm_created_at, person_id: _p, run_id: _r, inbox_cleared_at: _i, ...rest } = a;
  return {
    ...rest,
    evidence: parseEvidence(a.evidence),
    waiting: Boolean(a.waiting),
    last_message: lm_direction ? { direction: lm_direction, status: lm_status!, body: lm_body!, created_at: lm_created_at! } : null,
  };
}

async function attendeeView(id: string) {
  const row = await get<AttendeeListRow>(`SELECT ${ATTENDEE_SELECT} WHERE a.id = ?`, [id]);
  if (!row) throw new InputError("Attendee not found", 404);
  return presentAttendee(row);
}

// ── Events ──────────────────────────────────────────────────────────

app.openapi(
  createRoute({
    method: "get", path: "/api/events", summary: "List events, newest first",
    request: { query: PageQuery.extend({ archived: z.enum(["true", "false"]).optional() }) },
    responses: { 200: pagedResponse("events", Event) },
  }),
  async (c) => {
    const q = c.req.valid("query");
    const { page, limit, offset, search } = pageParams(q);
    const where = ["archived = ?"];
    const args: unknown[] = [q.archived === "true" ? 1 : 0];
    if (search) { where.push("name LIKE ?"); args.push(`%${search}%`); }
    const rows = await query<EventRow>(
      `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY COALESCE(starts_on, created_at) DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM events WHERE ${where.join(" AND ")}`, args))?.n ?? 0;
    return c.json({ events: await Promise.all(rows.map(presentEvent)), total, page, limit } as never, 200);
  },
);

app.openapi(
  createRoute({
    method: "post", path: "/api/events", summary: "Create an event",
    request: body(EventFields.extend({ id: Id.optional().openapi({ description: "Pass one to make a retry safe" }) })),
    responses: { 201: json(Event, "Created"), 400: errors[400], 409: errors[409] },
  }),
  async (c) => {
    const { id = crypto.randomUUID(), ...f } = c.req.valid("json");
    const existing = await get<EventRow>("SELECT * FROM events WHERE id = ?", [id]);
    if (existing) {
      if (existing.name !== f.name) throw new InputError("This event id is already used.", 409);
      return c.json((await presentEvent(existing)) as never, 201);
    }
    await run(
      `INSERT INTO events (id, name, portal_url, starts_on, ends_on, location, icp, offer, language, message_max_chars, max_profiles, max_research, max_sends, platform_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, f.name, f.portal_url, f.starts_on ?? null, f.ends_on ?? null, f.location ?? "", f.icp ?? "", f.offer ?? "",
        f.language ?? "English", f.message_max_chars ?? 400, f.max_profiles ?? 60, f.max_research ?? 5, f.max_sends ?? 20,
        JSON.stringify(f.platform_notes ?? []),
      ],
    );
    return c.json((await presentEvent(await readEvent(id))) as never, 201);
  },
);

app.openapi(
  createRoute({
    method: "get", path: "/api/events/{id}", summary: "An event's settings, counts and the offer to pitch",
    request: { params: IdParam },
    responses: { 200: json(EventDetail), 404: errors[404] },
  }),
  async (c) => {
    const e = await readEvent(c.req.valid("param").id);
    let resolved = e.offer;
    let source: { title: string; version: number; url: string } | null = null;
    if (!resolved.trim()) {
      const pinned = await offering(c.env).catch(() => null);
      if (pinned) { resolved = pinned.body; source = { title: pinned.title, version: pinned.version, url: pinned.url }; }
    }
    return c.json({ ...(await presentEvent(e)), resolved_offer: resolved, offer_source: source } as never, 200);
  },
);

app.openapi(
  createRoute({
    method: "patch", path: "/api/events/{id}", summary: "Change an event; send only the fields to change",
    description: "To add a portal quirk, send platform_notes as the existing list plus the new note.",
    request: { params: IdParam, ...body(EventFields.partial()) },
    responses: { 200: json(Event), 400: errors[400], 404: errors[404] },
  }),
  async (c) => {
    const e = await readEvent(c.req.valid("param").id);
    const f = c.req.valid("json");
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(k === "platform_notes" ? JSON.stringify(v) : k === "archived" ? (v ? 1 : 0) : v);
    }
    if (sets.length) await run(`UPDATE events SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...args, e.id]);
    return c.json((await presentEvent(await readEvent(e.id))) as never, 200);
  },
);

// ── Runs ────────────────────────────────────────────────────────────

const RunKindSchema = z.enum(["shortlist", "send", "inbox"]);

app.openapi(
  createRoute({
    method: "get", path: "/api/events/{id}/runs", summary: "An event's runs, newest first",
    request: { params: IdParam, query: PageQuery },
    responses: { 200: pagedResponse("runs", Run) },
  }),
  async (c) => {
    const e = await readEvent(c.req.valid("param").id);
    const { page, limit, offset } = pageParams(c.req.valid("query"));
    const { rows, total } = await listRuns(e.id, limit, offset);
    return c.json({ runs: rows.map(presentRun), total, page, limit } as never, 200);
  },
);

app.openapi(
  createRoute({
    method: "post", path: "/api/events/{id}/runs", summary: "Start a run yourself and get its procedure",
    description:
      "For an agent asked in chat to work an event. Returns the run and the instruction to follow: the same procedure a dispatched run carries. Runs started from the app's buttons arrive already created.",
    request: { params: IdParam, ...body(z.object({ id: Id, kind: RunKindSchema })) },
    responses: { 201: json(z.object({ run: Run, instruction: z.string() }), "Created"), 400: errors[400], 409: errors[409] },
  }),
  async (c) => {
    const e = await readEvent(c.req.valid("param").id);
    if (e.archived) throw new InputError("This event is archived.", 409);
    const { id, kind } = c.req.valid("json");
    const { run: r } = await createRun(id, e.id, kind, SKILLS[kind].version);
    await run("UPDATE runs SET dispatched = 1 WHERE id = ?", [r.id]);
    return c.json({ run: presentRun(await readRun(r.id)), instruction: runBrief(kind, appUrl(c), e.id, r.id) } as never, 201);
  },
);

app.openapi(
  createRoute({
    method: "get", path: "/api/runs/{id}", summary: "A run's status",
    request: { params: IdParam }, responses: { 200: json(Run), 404: errors[404] },
  }),
  async (c) => c.json(presentRun(await readRun(c.req.valid("param").id)) as never, 200),
);

app.openapi(
  createRoute({
    method: "patch", path: "/api/runs/{id}", summary: "Report progress: heartbeat, finish, or block",
    description: "Send {status: running} as a heartbeat at least every 10 minutes. failed and blocked need an error.",
    request: {
      params: IdParam,
      ...body(z.object({ status: z.enum(["running", "done", "failed", "blocked"]).optional(), coverage: z.string().max(2000).optional(), error: z.string().max(1000).optional() })),
    },
    responses: { 200: json(Run), 400: errors[400], 404: errors[404], 410: errors[410] },
  }),
  async (c) => c.json(presentRun(await updateRun(c.req.valid("param").id, c.req.valid("json"))) as never, 200),
);

const AttendeeIn = z.object({
  name: z.string().trim().min(1).max(200),
  title: z.string().max(300).optional(),
  company: z.string().max(200).optional(),
  domain: z.string().max(200).optional(),
  portal_profile_url: z.string().url().max(1000).optional(),
  linkedin_url: z.string().url().max(1000).optional(),
  fit: z.enum(["strong", "maybe", "no"]),
  why_fit: z.string().max(1000).optional(),
  evidence: z.array(Evidence).max(10).optional(),
  draft: z.string().max(5000).optional().openapi({ description: "The first message, for a person to approve. Omit for fit no." }),
});

app.openapi(
  createRoute({
    method: "post", path: "/api/runs/{id}/attendees", summary: "Record shortlisted people and their drafts (shortlist runs)",
    description: "Up to 25 per call. Each row answers created, duplicate (already listed here, or contacted at another event) or limit_reached.",
    request: { params: IdParam, ...body(z.object({ attendees: z.array(AttendeeIn).min(1).max(25) })) },
    responses: {
      200: json(z.object({ results: z.array(z.object({ status: z.enum(["created", "duplicate", "limit_reached"]), attendee_id: z.string().optional(), reason: z.string().optional(), event_name: z.string().optional(), draft: z.string().optional() })) })),
      400: errors[400], 404: errors[404], 409: errors[409], 410: errors[410],
    },
  }),
  async (c) => c.json({ results: await addAttendees(c.req.valid("param").id, c.req.valid("json").attendees) } as never, 200),
);

const Sighting = {
  name: z.string().trim().min(1).max(200),
  company: z.string().max(200).optional(),
  portal_profile_url: z.string().url().max(1000).optional(),
};

app.openapi(
  createRoute({
    method: "post", path: "/api/runs/{id}/inbound", summary: "Record messages other attendees sent (inbox and send runs)",
    description: "Up to 25 per call, oldest first. Repeats are dropped, so send the visible history.",
    request: {
      params: IdParam,
      ...body(z.object({ messages: z.array(z.object({ ...Sighting, body: z.string().trim().min(1).max(5000), received_at: z.string().max(40).nullable().optional(), thread_url: z.string().url().max(1000).optional() })).min(1).max(25) })),
    },
    responses: { 200: json(z.object({ results: z.array(z.object({ status: z.enum(["recorded", "duplicate"]), attendee_id: z.string() })) })), 400: errors[400], 404: errors[404], 409: errors[409], 410: errors[410] },
  }),
  async (c) => c.json({ results: await addInbound(c.req.valid("param").id, c.req.valid("json").messages) } as never, 200),
);

app.openapi(
  createRoute({
    method: "post", path: "/api/runs/{id}/meetings", summary: "Record confirmed one-to-one meetings (inbox runs)",
    request: {
      params: IdParam,
      ...body(z.object({ meetings: z.array(z.object({ ...Sighting, starts_at: z.string().max(40).nullable().optional(), location: z.string().max(300).optional(), portal_url: z.string().url().max(1000).optional() })).min(1).max(25) })),
    },
    responses: { 200: json(z.object({ results: z.array(z.object({ status: z.enum(["recorded", "duplicate"]), attendee_id: z.string() })) })), 400: errors[400], 404: errors[404], 409: errors[409], 410: errors[410] },
  }),
  async (c) => c.json({ results: await addMeetings(c.req.valid("param").id, c.req.valid("json").meetings) } as never, 200),
);

// ── Attendees ───────────────────────────────────────────────────────

app.openapi(
  createRoute({
    method: "get", path: "/api/events/{id}/attendees", summary: "People at an event",
    description: "By default: fits and people who wrote to you. view=waiting: their message waits on you. view=all includes fit no.",
    request: {
      params: IdParam,
      query: PageQuery.extend({
        view: z.enum(["people", "waiting", "all"]).optional(),
        status: z.enum(["new", "contacted", "replied", "meeting", "skipped", "declined"]).optional(),
        fit: z.enum(["strong", "maybe", "no"]).optional(),
      }),
    },
    responses: { 200: pagedResponse("attendees", Attendee), 404: errors[404] },
  }),
  async (c) => {
    const e = await readEvent(c.req.valid("param").id);
    const q = c.req.valid("query");
    const { page, limit, offset, search } = pageParams(q);
    const where = ["a.event_id = ?"];
    const args: unknown[] = [e.id];
    if (q.view === "waiting") where.push(WAITING_SQL);
    else if (q.view !== "all") where.push("(a.fit IN ('strong', 'maybe') OR a.source = 'inbound')");
    if (q.status) { where.push("a.status = ?"); args.push(q.status); }
    if (q.fit) { where.push("a.fit = ?"); args.push(q.fit); }
    if (search) { where.push("(a.name LIKE ? OR a.company LIKE ? OR a.title LIKE ?)"); args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const order = q.view === "waiting"
      ? "(SELECT MAX(created_at) FROM messages m WHERE m.attendee_id = a.id AND m.direction = 'in') DESC"
      : "CASE a.fit WHEN 'strong' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, a.created_at DESC";
    const rows = await query<AttendeeListRow>(`SELECT ${ATTENDEE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, limit, offset]);
    const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM attendees a WHERE ${where.join(" AND ")}`, args))?.n ?? 0;
    return c.json({ attendees: rows.map(presentAttendee), total, page, limit } as never, 200);
  },
);

app.openapi(
  createRoute({
    method: "get", path: "/api/attendees/{id}", summary: "One person at an event, with the conversation and meetings",
    description: "messages holds the latest 50, oldest first. other_events lists where else this person was met.",
    request: { params: IdParam },
    responses: {
      200: json(Attendee.extend({
        messages: z.array(Message), meetings: z.array(Meeting.omit({ attendee: true })),
        other_events: z.array(z.object({ attendee_id: z.string(), event_id: z.string(), event_name: z.string(), status: z.string() })),
      })),
      404: errors[404],
    },
  }),
  async (c) => {
    const a = await readAttendee(c.req.valid("param").id);
    const latest = await query<MessageRow & { seq: number }>(
      "SELECT * FROM (SELECT *, rowid AS seq FROM messages WHERE attendee_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50) ORDER BY created_at, seq",
      [a.id],
    );
    const messages = latest.map(({ seq: _seq, ...m }) => m);
    const meetings = await query("SELECT * FROM meetings WHERE attendee_id = ? ORDER BY starts_at", [a.id]);
    const other = await query(
      "SELECT a.id attendee_id, e.id event_id, e.name event_name, a.status FROM attendees a JOIN events e ON e.id = a.event_id WHERE a.person_id = ? AND a.id != ? ORDER BY a.created_at DESC LIMIT 10",
      [a.person_id, a.id],
    );
    return c.json({ ...(await attendeeView(a.id)), messages, meetings, other_events: other } as never, 200);
  },
);

app.openapi(
  createRoute({
    method: "patch", path: "/api/attendees/{id}", summary: "Skip, decline or reopen a person (people only)",
    description: "Skipping or declining discards any message still waiting to go out to them.",
    request: { params: IdParam, ...body(z.object({ status: z.enum(["new", "contacted", "replied", "meeting", "skipped", "declined"]) })) },
    responses: { 200: json(Attendee), 403: errors[403], 404: errors[404] },
  }),
  async (c) => {
    const a = await setAttendeeStatus(c.req.valid("param").id, actor(c), c.req.valid("json").status);
    return c.json((await attendeeView(a.id)) as never, 200);
  },
);

app.openapi(
  createRoute({
    method: "post", path: "/api/attendees/{id}/messages", summary: "Write a message to this person (people only)",
    description: "A person's own message is approved as written and goes out with the next send run.",
    request: { params: IdParam, ...body(z.object({ body: z.string().trim().min(1).max(5000) })) },
    responses: { 201: json(Message, "Queued"), 400: errors[400], 403: errors[403], 404: errors[404] },
  }),
  async (c) => c.json((await writeMessage(c.req.valid("param").id, actor(c), c.req.valid("json").body)) as never, 201),
);

app.openapi(
  createRoute({
    method: "post", path: "/api/attendees/{id}/clear", summary: "Mark their latest message as dealt with (people only)",
    request: { params: IdParam },
    responses: { 200: json(Attendee), 403: errors[403], 404: errors[404] },
  }),
  async (c) => {
    const a = await clearInbox(c.req.valid("param").id, actor(c));
    return c.json((await attendeeView(a.id)) as never, 200);
  },
);

// ── Messages ────────────────────────────────────────────────────────

app.openapi(
  createRoute({
    method: "get", path: "/api/events/{id}/messages", summary: "An event's messages, filtered by status",
    description: "Send runs read status=approved: the messages a person approved, oldest approval first.",
    request: {
      params: IdParam,
      query: PageQuery.extend({
        status: z.enum(["draft", "approved", "sent", "failed", "held", "discarded", "received"]).optional(),
        direction: z.enum(["out", "in"]).optional(),
      }),
    },
    responses: { 200: pagedResponse("messages", Message), 404: errors[404] },
  }),
  async (c) => {
    const e = await readEvent(c.req.valid("param").id);
    const q = c.req.valid("query");
    const { page, limit, offset } = pageParams(q);
    const where = ["m.event_id = ?"];
    const args: unknown[] = [e.id];
    if (q.status) { where.push("m.status = ?"); args.push(q.status); }
    if (q.direction) { where.push("m.direction = ?"); args.push(q.direction); }
    // Approved: in the order people approved them, which is the order they go out.
    // Drafts: strongest fits first, so the best conversations are approved first.
    const order = q.status === "approved"
      ? "m.approved_at, m.rowid"
      : q.status === "draft"
        ? "CASE a.fit WHEN 'strong' THEN 0 WHEN 'maybe' THEN 1 ELSE 2 END, m.created_at, m.rowid"
        : "m.created_at DESC, m.rowid DESC";
    type Joined = MessageRow & { a_name: string; a_title: string; a_company: string; a_domain: string; a_portal: string; a_fit: AttendeeRow["fit"]; a_why: string; a_evidence: string };
    const rows = await query<Joined>(
      `SELECT m.*, a.name a_name, a.title a_title, a.company a_company, a.domain a_domain, a.portal_profile_url a_portal,
         a.fit a_fit, a.why_fit a_why, a.evidence a_evidence
       FROM messages m JOIN attendees a ON a.id = m.attendee_id
       WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    const total = (await get<{ n: number }>(`SELECT COUNT(*) n FROM messages m WHERE ${where.join(" AND ")}`, args))?.n ?? 0;
    const messages = rows.map(({ a_name, a_title, a_company, a_domain, a_portal, a_fit, a_why, a_evidence, ...m }) => ({
      ...m,
      attendee: {
        name: a_name, title: a_title, company: a_company, domain: a_domain, portal_profile_url: a_portal,
        fit: a_fit, why_fit: a_why, evidence: parseEvidence(a_evidence),
      },
    }));
    return c.json({ messages, total, page, limit } as never, 200);
  },
);

app.openapi(
  createRoute({
    method: "patch", path: "/api/messages/{id}", summary: "Edit, approve or report on a message",
    description:
      "People edit, approve, return to draft or discard. Agents only report on an approved message: sent, failed or held (failed and held need an error). An agent can never approve or change text.",
    request: {
      params: IdParam,
      ...body(z.object({ body: z.string().max(5000).optional(), status: z.enum(["draft", "approved", "sent", "failed", "held", "discarded"]).optional(), error: z.string().max(500).optional() })),
    },
    responses: { 200: json(Message), 400: errors[400], 403: errors[403], 404: errors[404], 409: errors[409] },
  }),
  async (c) => c.json((await updateMessage(c.req.valid("param").id, actor(c), c.req.valid("json"))) as never, 200),
);

app.openapi(
  createRoute({
    method: "get", path: "/api/events/{id}/meetings", summary: "Meetings booked at an event",
    request: { params: IdParam, query: PageQuery },
    responses: { 200: pagedResponse("meetings", Meeting), 404: errors[404] },
  }),
  async (c) => {
    const e = await readEvent(c.req.valid("param").id);
    const { page, limit, offset } = pageParams(c.req.valid("query"));
    const rows = await query<Record<string, string | null>>(
      `SELECT m.*, a.name a_name, a.company a_company FROM meetings m JOIN attendees a ON a.id = m.attendee_id
       WHERE m.event_id = ? ORDER BY m.starts_at IS NULL, m.starts_at LIMIT ? OFFSET ?`,
      [e.id, limit, offset],
    );
    const total = (await get<{ n: number }>("SELECT COUNT(*) n FROM meetings WHERE event_id = ?", [e.id]))?.n ?? 0;
    const meetings = rows.map(({ a_name, a_company, ...m }) => ({ ...m, attendee: { name: a_name, company: a_company } }));
    return c.json({ meetings, total, page, limit } as never, 200);
  },
);

// ── Control routes: deliberately not in the agent's API discovery ───
// Dispatching and choosing an agent are a person's buttons. An instruction must
// never teach its recipient to dispatch or reconfigure itself.

app.get("/api/agents", async (c) => {
  if (!c.env.CLAWNIFY_TOKEN) return c.json({ available: false, servers: [], selected: null });
  const data = await createAgents(c.env).list({ limit: 100 });
  const s = await get<{ server_id: string | null }>("SELECT server_id FROM settings WHERE id = 1");
  return c.json({ available: true, servers: data.servers, selected: s?.server_id ?? null });
});

app.put("/api/settings", async (c) => {
  if (!actor(c).approver) throw new InputError("Only a person can choose the agent.", 403);
  const { server_id } = z.object({ server_id: z.string().max(100).nullable() }).parse(await c.req.json());
  await run(
    "INSERT INTO settings (id, server_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET server_id = excluded.server_id, updated_at = datetime('now')",
    [server_id],
  );
  return c.json({ server_id });
});

app.post("/api/events/:id/dispatch", async (c) => {
  if (!actor(c).approver) throw new InputError("Only a person can start a run from here.", 403);
  const e = await readEvent(Id.parse(c.req.param("id")));
  if (e.archived) throw new InputError("This event is archived.", 409);
  const { id, kind } = z.object({ id: Id, kind: RunKindSchema }).parse(await c.req.json());
  if (kind === "send") {
    const approved = (await get<{ n: number }>("SELECT COUNT(*) n FROM messages WHERE event_id = ? AND status = 'approved'", [e.id]))?.n ?? 0;
    if (!approved) throw new InputError("Nothing is approved to send yet.");
  }
  const { run: r, created } = await createRun(id, e.id, kind as RunKind, SKILLS[kind as RunKind].version);
  const brief = runBrief(kind as RunKind, appUrl(c), e.id, r.id);
  if (!created) return c.json({ run: presentRun(r), brief, dispatched: Boolean(r.dispatched) });
  if (!c.env.CLAWNIFY_TOKEN) return c.json({ run: presentRun(r), brief, dispatched: false });

  const s = await get<{ server_id: string | null }>("SELECT server_id FROM settings WHERE id = 1");
  try {
    const result = await createAgents(c.env).dispatch({
      instruction: brief,
      ...(s?.server_id ? { server_id: s.server_id } : {}),
      idempotency_key: `open-events-run:${r.id}`,
    });
    await run("UPDATE runs SET dispatched = 1, task_id = ?, updated_at = datetime('now') WHERE id = ?", [result.task_id, r.id]);
  } catch (err) {
    // An unknown outcome may still have reached the agent: leave the run open and
    // say so, rather than failing it and inviting a second, duplicate run.
    const unknown = !(err instanceof ClawnifyAgentsError) || err.outcomeUnknown;
    const message = err instanceof Error ? err.message : String(err);
    await run(
      `UPDATE runs SET status = ?, error = ?, finished_at = CASE WHEN ? = 'failed' THEN datetime('now') END, updated_at = datetime('now') WHERE id = ?`,
      [unknown ? "running" : "failed", unknown ? `Not sure the agent received this: ${message}` : message, unknown ? "running" : "failed", r.id],
    );
    return c.json({ run: presentRun(await readRun(r.id)), brief, dispatched: false, error: message }, unknown ? 202 : 502);
  }
  return c.json({ run: presentRun(await readRun(r.id)), brief, dispatched: true }, 202);
});

app.post("/api/runs/:id/stop", async (c) => {
  const who = actor(c);
  if (!who.approver) throw new InputError("Only a person can stop a run from here.", 403);
  const r = await openRun(Id.parse(c.req.param("id")));
  await run(
    `UPDATE runs SET status = 'failed', error = ?, stopped_by_name = ?, stopped_by_avatar = ?,
       finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [`Stopped by ${who.name}`, who.name, who.avatar, r.id],
  );
  return c.json(presentRun(await readRun(r.id)));
});

// ── Dashboard widgets ───────────────────────────────────────────────

widgets(app, async () => {
  const waiting = (await get<{ n: number }>(`SELECT COUNT(*) n FROM attendees a JOIN events e ON e.id = a.event_id WHERE e.archived = 0 AND ${WAITING_SQL}`))?.n ?? 0;
  const drafts = (await get<{ n: number }>("SELECT COUNT(*) n FROM messages m JOIN events e ON e.id = m.event_id WHERE e.archived = 0 AND m.status = 'draft'"))?.n ?? 0;
  return [
    { key: "waiting", kind: "metric", title: "Replies waiting on you", value: waiting, at: "/", icon: "inbox", color: "sky" },
    { key: "drafts", kind: "metric", title: "Messages to approve", value: drafts, at: "/", icon: "check-square", color: "amber" },
  ];
});

export default app;
