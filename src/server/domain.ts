// The rules the app enforces no matter who calls: which run may write, who is the
// same person across events, what a message may become and who may move it there.
// Routes parse input and call these; nothing here knows about HTTP.

import { get, query, run } from "./db.js";

export class InputError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 410 = 400, readonly code?: string) {
    super(message);
  }
}

/** A run with no heartbeat or write for this long is shown as stalled and may be replaced. */
export const STALE_MINUTES = 20;

export type RunKind = "shortlist" | "send" | "inbox";
export type Fit = "strong" | "maybe" | "no";

export interface EventRow {
  id: string;
  name: string;
  portal_url: string;
  starts_on: string | null;
  ends_on: string | null;
  location: string;
  icp: string;
  offer: string;
  language: string;
  message_max_chars: number;
  max_profiles: number;
  max_research: number;
  max_sends: number;
  platform_notes: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  event_id: string;
  kind: RunKind;
  status: "running" | "done" | "failed" | "blocked";
  coverage: string;
  error: string;
  skill_version: string;
  task_id: string | null;
  dispatched: number;
  heartbeat_at: string | null;
  finished_at: string | null;
  stopped_by_name: string | null;
  stopped_by_avatar: string | null;
  created_at: string;
  updated_at: string;
  stale?: number;
}

export interface AttendeeRow {
  id: string;
  event_id: string;
  person_id: string;
  run_id: string | null;
  source: "shortlist" | "inbound";
  name: string;
  title: string;
  company: string;
  domain: string;
  portal_profile_url: string;
  linkedin_url: string;
  fit: Fit | null;
  why_fit: string;
  evidence: string;
  status: "new" | "contacted" | "replied" | "meeting" | "skipped" | "declined";
  inbox_cleared_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  event_id: string;
  attendee_id: string;
  direction: "out" | "in";
  body: string;
  status: "draft" | "approved" | "sent" | "failed" | "held" | "discarded" | "received";
  error: string;
  author: "agent" | "user" | "them";
  approved_by: string | null;
  approved_at: string | null;
  sent_at: string | null;
  received_at: string | null;
  thread_url: string;
  created_at: string;
  updated_at: string;
}

const uuid = () => crypto.randomUUID();

// ── Events ──────────────────────────────────────────────────────────

export async function readEvent(id: string): Promise<EventRow> {
  const row = await get<EventRow>("SELECT * FROM events WHERE id = ?", [id]);
  if (!row) throw new InputError("Event not found", 404);
  return row;
}

export function notes(event: Pick<EventRow, "platform_notes">): string[] {
  try {
    const parsed = JSON.parse(event.platform_notes);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

// ── Runs ────────────────────────────────────────────────────────────

const RUN_COLUMNS = `*, CASE WHEN status = 'running' AND
  COALESCE(heartbeat_at, created_at) < datetime('now', '-${STALE_MINUTES} minutes') THEN 1 ELSE 0 END AS stale`;

export async function readRun(id: string): Promise<RunRow> {
  const row = await get<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, [id]);
  if (!row) throw new InputError("Run not found", 404);
  return row;
}

export async function listRuns(eventId: string, limit: number, offset: number) {
  const rows = await query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE event_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    [eventId, limit, offset],
  );
  const total = (await get<{ n: number }>("SELECT COUNT(*) n FROM runs WHERE event_id = ?", [eventId]))?.n ?? 0;
  return { rows, total };
}

/** The run an agent writes through. A finished run takes no more writes, so a late or replayed agent cannot reopen it. */
export async function openRun(id: string, kind?: RunKind): Promise<RunRow> {
  const r = await readRun(id);
  if (r.status !== "running") throw new InputError(`This run is ${r.status}; it takes no more writes.`, 410, "run_closed");
  if (kind && r.kind !== kind) throw new InputError(`This is a ${r.kind} run, not a ${kind} run.`, 409, "wrong_run");
  await touch(r.id);
  return r;
}

async function touch(runId: string) {
  await run("UPDATE runs SET heartbeat_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [runId]);
}

/** Creates the run, or returns the one already created under this id (a retried click). */
export async function createRun(id: string, eventId: string, kind: RunKind, skillVersion: string) {
  const existing = await get<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`, [id]);
  if (existing) {
    if (existing.event_id !== eventId || existing.kind !== kind) throw new InputError("This run id is already used for other work.", 409);
    return { run: existing, created: false };
  }
  const busy = await get<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM runs WHERE event_id = ? AND kind = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1`,
    [eventId, kind],
  );
  if (busy && !busy.stale) throw new InputError(`A ${kind} run is already in progress for this event.`, 409, "run_in_progress");
  if (busy) {
    await run(
      "UPDATE runs SET status = 'failed', error = ?, finished_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'running'",
      [`No word from the agent for ${STALE_MINUTES} minutes; replaced by a new run.`, busy.id],
    );
  }
  await run("INSERT INTO runs (id, event_id, kind, skill_version) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING", [id, eventId, kind, skillVersion]);
  return { run: await readRun(id), created: true };
}

export async function updateRun(id: string, patch: { status?: RunRow["status"]; coverage?: string; error?: string }) {
  const r = await openRun(id);
  const status = patch.status ?? r.status;
  if (status === "failed" || status === "blocked") {
    if (!(patch.error ?? r.error)) throw new InputError("Say what went wrong in error.");
  }
  await run(
    `UPDATE runs SET status = ?, coverage = ?, error = ?, updated_at = datetime('now'),
       finished_at = CASE WHEN ? = 'running' THEN NULL ELSE datetime('now') END WHERE id = ?`,
    [status, patch.coverage ?? r.coverage, patch.error ?? r.error, status, id],
  );
  return readRun(id);
}

// ── People: one person across events ───────────────────────────────

export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
}

function linkedinKey(url: string): string | null {
  const m = url.trim().toLowerCase().match(/linkedin\.com\/(in|pub)\/([^/?#]+)/);
  return m ? `li:${m[1]}/${decodeURIComponent(m[2])}` : null;
}

const squash = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Every key this sighting can be recognised by, strongest first. */
export function personKeys(p: { name: string; domain?: string; linkedin_url?: string; portal_profile_url?: string }, eventId: string): string[] {
  const keys: string[] = [];
  const li = p.linkedin_url ? linkedinKey(p.linkedin_url) : null;
  if (li) keys.push(li);
  const domain = p.domain ? normalizeDomain(p.domain) : "";
  if (domain && p.name.trim()) keys.push(`nd:${squash(p.name)}|${domain}`);
  if (p.portal_profile_url?.trim()) keys.push(`portal:${p.portal_profile_url.trim().replace(/\/+$/, "")}`);
  // A bare name is only trusted inside one event: across events it is too weak.
  if (p.name.trim()) keys.push(`ne:${squash(p.name)}|${eventId}`);
  return keys;
}

/** Finds the person behind any of these keys, or creates one, and records every key against them. */
export async function resolvePerson(keys: string[]): Promise<string> {
  let personId: string | undefined;
  for (const key of keys) {
    const hit = await get<{ person_id: string }>("SELECT person_id FROM person_keys WHERE key = ?", [key]);
    if (hit) {
      personId = hit.person_id;
      break;
    }
  }
  if (!personId) {
    personId = uuid();
    await run("INSERT INTO people (id) VALUES (?)", [personId]);
  }
  for (const key of keys) {
    await run("INSERT INTO person_keys (key, person_id) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", [key, personId]);
  }
  return personId;
}

// ── Shortlist: attendees from the agent ─────────────────────────────

export interface AttendeeInput {
  name: string;
  title?: string;
  company?: string;
  domain?: string;
  portal_profile_url?: string;
  linkedin_url?: string;
  fit: Fit;
  why_fit?: string;
  evidence?: { url: string; quote: string }[];
  draft?: string;
}

export type AttendeeResult =
  | { status: "created"; attendee_id: string; draft: "saved" | "none" | "too_long" }
  | { status: "duplicate"; attendee_id: string; reason: "already_listed" | "contacted"; event_name: string }
  | { status: "limit_reached" };

export async function addAttendees(runId: string, rows: AttendeeInput[]): Promise<AttendeeResult[]> {
  const r = await openRun(runId, "shortlist");
  const event = await readEvent(r.event_id);
  const results: AttendeeResult[] = [];
  for (const row of rows) {
    results.push(await addAttendee(r, event, row));
  }
  return results;
}

async function addAttendee(r: RunRow, event: EventRow, row: AttendeeInput): Promise<AttendeeResult> {
  const counts = await get<{ total: number; fits: number }>(
    "SELECT COUNT(*) total, COALESCE(SUM(fit IN ('strong', 'maybe')), 0) fits FROM attendees WHERE run_id = ?",
    [r.id],
  );
  const isFit = row.fit !== "no";
  if ((counts?.total ?? 0) >= event.max_profiles || (isFit && (counts?.fits ?? 0) >= event.max_research)) {
    return { status: "limit_reached" };
  }

  const personId = await resolvePerson(personKeys(row, event.id));

  const here = await get<{ id: string }>("SELECT id FROM attendees WHERE event_id = ? AND person_id = ?", [event.id, personId]);
  if (here) return { status: "duplicate", attendee_id: here.id, reason: "already_listed", event_name: event.name };

  const contacted = await get<{ id: string; event_name: string }>(
    `SELECT a.id, e.name event_name FROM attendees a JOIN events e ON e.id = a.event_id
     WHERE a.person_id = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.attendee_id = a.id AND m.direction = 'out' AND m.status = 'sent')
     ORDER BY a.created_at DESC LIMIT 1`,
    [personId],
  );
  if (contacted) return { status: "duplicate", attendee_id: contacted.id, reason: "contacted", event_name: contacted.event_name };

  const id = uuid();
  await run(
    `INSERT INTO attendees (id, event_id, person_id, run_id, name, title, company, domain, portal_profile_url, linkedin_url, fit, why_fit, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, event.id, personId, r.id, row.name.trim(), row.title?.trim() ?? "", row.company?.trim() ?? "",
      row.domain ? normalizeDomain(row.domain) : "", row.portal_profile_url?.trim() ?? "", row.linkedin_url?.trim() ?? "",
      row.fit, row.why_fit?.trim() ?? "", JSON.stringify(row.evidence ?? []),
    ],
  );

  const body = isFit ? row.draft?.trim() ?? "" : "";
  if (!body) return { status: "created", attendee_id: id, draft: "none" };
  await run(
    "INSERT INTO messages (id, event_id, attendee_id, direction, body, status, author) VALUES (?, ?, ?, 'out', ?, 'draft', 'agent')",
    [uuid(), event.id, id, body],
  );
  return { status: "created", attendee_id: id, draft: body.length > event.message_max_chars ? "too_long" : "saved" };
}

// ── Inbox: what other attendees wrote, and meetings ────────────────

export interface Sighting {
  name: string;
  company?: string;
  portal_profile_url?: string;
}

/** The attendee this sighting belongs to in the event; an unknown sender becomes an attendee. */
async function attendeeFor(event: EventRow, s: Sighting, runId: string): Promise<string> {
  const portal = s.portal_profile_url?.trim().replace(/\/+$/, "");
  if (portal) {
    const hit = await get<{ id: string }>(
      "SELECT id FROM attendees WHERE event_id = ? AND RTRIM(portal_profile_url, '/') = ?",
      [event.id, portal],
    );
    if (hit) return hit.id;
  }
  const personId = await resolvePerson(personKeys({ name: s.name, portal_profile_url: s.portal_profile_url }, event.id));
  const existing = await get<{ id: string }>("SELECT id FROM attendees WHERE event_id = ? AND person_id = ?", [event.id, personId]);
  if (existing) return existing.id;
  const id = uuid();
  await run(
    `INSERT INTO attendees (id, event_id, person_id, run_id, source, name, company, portal_profile_url, status)
     VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, 'replied') ON CONFLICT(event_id, person_id) DO NOTHING`,
    [id, event.id, personId, runId, s.name.trim(), s.company?.trim() ?? "", portal ?? ""],
  );
  return (await get<{ id: string }>("SELECT id FROM attendees WHERE event_id = ? AND person_id = ?", [event.id, personId]))!.id;
}

async function fingerprint(...parts: string[]): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface InboundInput extends Sighting {
  body: string;
  received_at?: string | null;
  thread_url?: string;
}

/** Records messages from other attendees. The same message seen twice is stored once. */
export async function addInbound(runId: string, rows: InboundInput[]) {
  const r = await openRun(runId);
  if (r.kind === "shortlist") throw new InputError("A shortlist run does not read the inbox.", 409, "wrong_run");
  const event = await readEvent(r.event_id);
  const results: { status: "recorded" | "duplicate"; attendee_id: string }[] = [];
  for (const row of rows) {
    const attendeeId = await attendeeFor(event, row, r.id);
    const body = row.body.trim();
    const fp = await fingerprint(attendeeId, squash(body), row.received_at ?? "");
    const inserted = await run(
      `INSERT INTO messages (id, event_id, attendee_id, direction, body, status, author, received_at, thread_url, fingerprint)
       VALUES (?, ?, ?, 'in', ?, 'received', 'them', ?, ?, ?) ON CONFLICT(fingerprint) DO NOTHING`,
      [uuid(), event.id, attendeeId, body, row.received_at ?? null, row.thread_url?.trim() ?? "", fp],
    );
    const fresh = inserted.changes > 0;
    if (fresh) {
      await run(
        "UPDATE attendees SET status = 'replied', updated_at = datetime('now') WHERE id = ? AND status IN ('new', 'contacted', 'skipped')",
        [attendeeId],
      );
    }
    results.push({ status: fresh ? "recorded" : "duplicate", attendee_id: attendeeId });
  }
  return results;
}

export interface MeetingInput extends Sighting {
  starts_at?: string | null;
  location?: string;
  portal_url?: string;
}

export async function addMeetings(runId: string, rows: MeetingInput[]) {
  const r = await openRun(runId, "inbox");
  const event = await readEvent(r.event_id);
  const results: { status: "recorded" | "duplicate"; attendee_id: string }[] = [];
  for (const row of rows) {
    const attendeeId = await attendeeFor(event, row, r.id);
    const startsAt = row.starts_at ?? null;
    const seen = await get<{ id: string }>(
      "SELECT id FROM meetings WHERE attendee_id = ? AND starts_at IS ?",
      [attendeeId, startsAt],
    );
    if (!seen) {
      await run(
        "INSERT INTO meetings (id, event_id, attendee_id, starts_at, location, portal_url) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [uuid(), event.id, attendeeId, startsAt, row.location?.trim() ?? "", row.portal_url?.trim() ?? ""],
      );
      await run(
        "UPDATE attendees SET status = 'meeting', updated_at = datetime('now') WHERE id = ? AND status != 'declined'",
        [attendeeId],
      );
    }
    results.push({ status: seen ? "duplicate" : "recorded", attendee_id: attendeeId });
  }
  return results;
}

// ── Messages: who may move a message where ─────────────────────────

/** A person approving through the dashboard or a personal token. Agents are never one. */
export interface Actor {
  approver: boolean;
  name: string;
  avatar: string | null;
}

export async function readMessage(id: string): Promise<MessageRow> {
  const row = await get<MessageRow>("SELECT * FROM messages WHERE id = ?", [id]);
  if (!row) throw new InputError("Message not found", 404);
  return row;
}

const PERSON_MOVES: Record<string, MessageRow["status"][]> = {
  draft: ["approved", "discarded"],
  approved: ["draft", "discarded", "sent"],
  held: ["approved", "discarded"],
  failed: ["approved", "discarded"],
};
const AGENT_MOVES: Record<string, MessageRow["status"][]> = {
  approved: ["sent", "failed", "held"],
};

export async function updateMessage(
  id: string,
  actor: Actor,
  patch: { body?: string; status?: MessageRow["status"]; error?: string },
): Promise<MessageRow> {
  const m = await readMessage(id);
  if (m.direction !== "out") throw new InputError("Messages from other attendees cannot be changed.", 409);
  const event = await readEvent(m.event_id);

  let body = m.body;
  if (patch.body !== undefined && patch.body.trim() !== m.body) {
    if (!actor.approver) throw new InputError("Only a person can change a message's text.", 403, "approval_required");
    if (!["draft", "approved", "held", "failed"].includes(m.status)) throw new InputError(`A ${m.status} message cannot be edited.`, 409);
    body = patch.body.trim();
    if (!body) throw new InputError("A message needs text.");
  }

  let status = m.status;
  if (patch.status && patch.status !== m.status) {
    const allowed = (actor.approver ? PERSON_MOVES : AGENT_MOVES)[m.status] ?? [];
    if (!allowed.includes(patch.status)) {
      if (!actor.approver && patch.status === "approved") {
        throw new InputError("Only a person can approve a message.", 403, "approval_required");
      }
      throw new InputError(`A ${m.status} message cannot become ${patch.status}.`, 409);
    }
    if (patch.status === "failed" || patch.status === "held") {
      if (!patch.error?.trim()) throw new InputError("Say what happened in error.");
    }
    status = patch.status;
  }
  if (status === "approved" && body.length > event.message_max_chars) {
    throw new InputError(`This message is ${body.length} characters; the event allows ${event.message_max_chars}.`, 400, "too_long");
  }

  const approving = status === "approved" && (m.status !== "approved" || body !== m.body);
  const error = status === "failed" || status === "held" ? patch.error!.trim() : "";
  await run(
    `UPDATE messages SET body = ?, status = ?, error = ?, updated_at = datetime('now'),
       approved_by = CASE WHEN ? THEN ? ELSE approved_by END,
       approved_at = CASE WHEN ? THEN datetime('now') ELSE approved_at END,
       sent_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE sent_at END
     WHERE id = ?`,
    [body, status, error, approving ? 1 : 0, actor.name, approving ? 1 : 0, status, id],
  );
  if (status === "sent") {
    await run(
      "UPDATE attendees SET status = 'contacted', updated_at = datetime('now') WHERE id = ? AND status = 'new'",
      [m.attendee_id],
    );
  }
  return readMessage(id);
}

/** A message a person writes is approved as written; it goes out with the next send run. */
export async function writeMessage(attendeeId: string, actor: Actor, text: string): Promise<MessageRow> {
  if (!actor.approver) throw new InputError("Only a person can write a message here; agents draft through a shortlist run.", 403, "approval_required");
  const a = await readAttendee(attendeeId);
  const event = await readEvent(a.event_id);
  const body = text.trim();
  if (!body) throw new InputError("A message needs text.");
  if (body.length > event.message_max_chars) {
    throw new InputError(`This message is ${body.length} characters; the event allows ${event.message_max_chars}.`, 400, "too_long");
  }
  const id = uuid();
  await run(
    `INSERT INTO messages (id, event_id, attendee_id, direction, body, status, author, approved_by, approved_at)
     VALUES (?, ?, ?, 'out', ?, 'approved', 'user', ?, datetime('now'))`,
    [id, event.id, a.id, body, actor.name],
  );
  await run("UPDATE attendees SET inbox_cleared_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [a.id]);
  return readMessage(id);
}

// ── Attendees ───────────────────────────────────────────────────────

export async function readAttendee(id: string): Promise<AttendeeRow> {
  const row = await get<AttendeeRow>("SELECT * FROM attendees WHERE id = ?", [id]);
  if (!row) throw new InputError("Attendee not found", 404);
  return row;
}

/** Waiting on you: their latest message is newer than anything you sent, queued or cleared. */
export const WAITING_SQL = `EXISTS (
  SELECT 1 FROM messages i WHERE i.attendee_id = a.id AND i.direction = 'in'
    AND i.created_at > COALESCE(a.inbox_cleared_at, '')
    AND i.created_at > COALESCE((SELECT MAX(o.created_at) FROM messages o
      WHERE o.attendee_id = a.id AND o.direction = 'out' AND o.status IN ('approved', 'sent')), ''))`;

export async function setAttendeeStatus(id: string, actor: Actor, status: AttendeeRow["status"]) {
  if (!actor.approver) throw new InputError("Only a person can change who to contact.", 403, "approval_required");
  const a = await readAttendee(id);
  await run("UPDATE attendees SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, a.id]);
  if (status === "skipped" || status === "declined") {
    // Nobody we decided not to contact keeps a message waiting to go out.
    await run(
      "UPDATE messages SET status = 'discarded', updated_at = datetime('now') WHERE attendee_id = ? AND direction = 'out' AND status IN ('draft', 'approved', 'held', 'failed')",
      [a.id],
    );
  }
  return readAttendee(id);
}

export async function clearInbox(id: string, actor: Actor) {
  if (!actor.approver) throw new InputError("Only a person can mark a conversation as dealt with.", 403, "approval_required");
  await readAttendee(id);
  await run("UPDATE attendees SET inbox_cleared_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
  return readAttendee(id);
}

export async function eventCounts(eventId: string) {
  const row = await get<Record<string, number>>(
    `SELECT
       (SELECT COUNT(*) FROM attendees a WHERE a.event_id = ?1 AND (a.fit IN ('strong', 'maybe') OR a.source = 'inbound')) people,
       (SELECT COUNT(*) FROM messages WHERE event_id = ?1 AND status = 'draft') to_approve,
       (SELECT COUNT(*) FROM messages WHERE event_id = ?1 AND status = 'approved') to_send,
       (SELECT COUNT(*) FROM messages WHERE event_id = ?1 AND status IN ('held', 'failed')) needs_attention,
       (SELECT COUNT(*) FROM messages WHERE event_id = ?1 AND status = 'sent') sent,
       (SELECT COUNT(*) FROM attendees a WHERE a.event_id = ?1 AND ${WAITING_SQL}) waiting,
       (SELECT COUNT(*) FROM meetings WHERE event_id = ?1) meetings`,
    [eventId],
  );
  return {
    people: row?.people ?? 0,
    to_approve: row?.to_approve ?? 0,
    to_send: row?.to_send ?? 0,
    needs_attention: row?.needs_attention ?? 0,
    sent: row?.sent ?? 0,
    waiting: row?.waiting ?? 0,
    meetings: row?.meetings ?? 0,
  };
}
