import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import app from "./index";
import { INSTRUCTION_LIMIT } from "./brief";

// The platform's Storage binding over node:sqlite: rows for anything that reads,
// changes for anything that writes. No mocks, the real routes and SQL run.
let db: DatabaseSync;
const STORAGE = {
  async query(sql: string, params: unknown[] = []) {
    const stmt = db.prepare(sql);
    const values = params as (string | number | null)[];
    if (/^\s*(select|with|pragma)/i.test(sql) || /\breturning\b/i.test(sql)) return { rows: stmt.all(...values) };
    const r = stmt.run(...values);
    return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  },
};

type Who = "user" | "agent" | "agent-browser" | "local";
const HEADERS: Record<Who, Record<string, string>> = {
  user: { "X-Clawnify-Caller": "user", "X-Clawnify-User-Id": "u1", "X-Clawnify-User-Name": "Jordan Lee", "X-Clawnify-Org-Id": "o1" },
  agent: { "X-Clawnify-Caller": "agent", "X-Clawnify-Org-Id": "o1" },
  "agent-browser": { "X-Clawnify-Caller": "agent-browser" },
  local: {},
};

async function call(method: string, path: string, body?: unknown, who: Who = "user") {
  const env = who === "local" ? { STORAGE } : { STORAGE, CLAWNIFY_TOKEN: "test-token" };
  const res = await app.request(`https://events.example${path}`, {
    method,
    headers: { "content-type": "application/json", ...HEADERS[who] },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const id = () => crypto.randomUUID();

async function newEvent(overrides: Record<string, unknown> = {}) {
  const r = await call("POST", "/api/events", {
    name: "Founders Summit 2026", portal_url: "https://portal.example/community", icp: "Agency founders",
    max_research: 3, ...overrides,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}

/** A run as an agent asked in chat would start it; the button path is tested separately. */
async function newRun(eventId: string, kind: "shortlist" | "send" | "inbox") {
  const r = await call("POST", `/api/events/${eventId}/runs`, { id: id(), kind }, "agent");
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.run.id as string;
}

const person = (name: string, extra: Record<string, unknown> = {}) => ({
  name, company: `${name} Co`, domain: `${name.toLowerCase().replace(/\s+/g, "")}.example`, fit: "strong",
  why_fit: "Runs an agency", evidence: [{ url: "https://site.example", quote: "We are an agency" }],
  draft: `Hi ${name}, saw your work. Can I send something over?`, ...extra,
});

async function shortlist(runId: string, people: unknown[]) {
  const r = await call("POST", `/api/runs/${runId}/attendees`, { attendees: people }, "agent");
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.results as { status: string; attendee_id?: string; reason?: string; event_name?: string; draft?: string }[];
}

async function drafts(eventId: string) {
  const r = await call("GET", `/api/events/${eventId}/messages?status=draft`);
  return r.body.messages as { id: string; body: string; attendee_id: string }[];
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

describe("shortlist", () => {
  it("records fits with drafts, refuses repeats, and stops at the research limit", async () => {
    const eventId = await newEvent();
    const runId = await newRun(eventId, "shortlist");
    const results = await shortlist(runId, [
      person("Maya Lindqvist"),
      person("Not A Fit", { fit: "no", draft: "should be ignored" }),
      person("Tomás Ferreira"),
      person("Maya Lindqvist"),
      person("Priya Raman"),
      person("Noor Haddad"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["created", "created", "created", "duplicate", "created", "limit_reached"]);
    expect(results[3].reason).toBe("already_listed");
    expect(results[1].draft).toBe("none");
    expect(await drafts(eventId)).toHaveLength(3);

    const people = await call("GET", `/api/events/${eventId}/attendees`);
    expect(people.body.total).toBe(3); // fit no is kept out of the default view
    const all = await call("GET", `/api/events/${eventId}/attendees?view=all`);
    expect(all.body.total).toBe(4);
  });

  it("flags a draft longer than the portal allows and refuses to approve it", async () => {
    const eventId = await newEvent({ message_max_chars: 100 });
    const runId = await newRun(eventId, "shortlist");
    const [r] = await shortlist(runId, [person("Sam Whitfield", { draft: "x".repeat(150) })]);
    expect(r.draft).toBe("too_long");
    const [d] = await drafts(eventId);
    const approve = await call("PATCH", `/api/messages/${d.id}`, { status: "approved" });
    expect(approve.status).toBe(400);
    expect(approve.body.code).toBe("too_long");
    const fixed = await call("PATCH", `/api/messages/${d.id}`, { body: "Short and fine.", status: "approved" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.status).toBe("approved");
    expect(fixed.body.approved_by).toBe("Jordan Lee");
  });

  it("never drafts again for someone already contacted at another event", async () => {
    const first = await newEvent();
    const run1 = await newRun(first, "shortlist");
    await shortlist(run1, [person("Maya Lindqvist", { linkedin_url: "https://www.linkedin.com/in/maya-l/" })]);
    const [d] = await drafts(first);
    await call("PATCH", `/api/messages/${d.id}`, { status: "approved" });
    await call("PATCH", `/api/messages/${d.id}`, { status: "sent" }, "agent");

    const second = await newEvent({ name: "Growth Week 2026" });
    const run2 = await newRun(second, "shortlist");
    // Same LinkedIn profile, different URL shape.
    const [byLinkedin] = await shortlist(run2, [person("Maya L.", { linkedin_url: "https://linkedin.com/in/maya-l?utm=x", domain: "other.example" })]);
    expect(byLinkedin).toMatchObject({ status: "duplicate", reason: "contacted", event_name: "Founders Summit 2026" });
    // No LinkedIn this time: the name and domain still recognise her.
    const [byName] = await shortlist(run2, [person("Maya Lindqvist")]);
    expect(byName).toMatchObject({ status: "duplicate", reason: "contacted" });
    expect(await drafts(second)).toHaveLength(0);
  });

  it("lists someone met but never contacted at another event again", async () => {
    const first = await newEvent();
    await shortlist(await newRun(first, "shortlist"), [person("Lena Vogel")]);
    const second = await newEvent({ name: "Growth Week 2026" });
    const [r] = await shortlist(await newRun(second, "shortlist"), [person("Lena Vogel")]);
    expect(r.status).toBe("created");
    const detail = await call("GET", `/api/attendees/${r.attendee_id}`);
    expect(detail.body.other_events).toHaveLength(1);
  });
});

describe("approval", () => {
  it("only a person approves or edits; an agent only reports on approved messages", async () => {
    const eventId = await newEvent();
    await shortlist(await newRun(eventId, "shortlist"), [person("Tomás Ferreira")]);
    const [d] = await drafts(eventId);

    for (const who of ["agent", "agent-browser"] as const) {
      const approve = await call("PATCH", `/api/messages/${d.id}`, { status: "approved" }, who);
      expect(approve.status, who).toBe(403);
      expect(approve.body.code).toBe("approval_required");
      const edit = await call("PATCH", `/api/messages/${d.id}`, { body: "Changed by an agent" }, who);
      expect(edit.status, who).toBe(403);
    }
    expect((await call("PATCH", `/api/messages/${d.id}`, { status: "sent" }, "agent")).status).toBe(409);

    expect((await call("PATCH", `/api/messages/${d.id}`, { status: "approved" })).status).toBe(200);
    expect((await call("PATCH", `/api/messages/${d.id}`, { status: "held" }, "agent")).status).toBe(400); // needs an error
    const sent = await call("PATCH", `/api/messages/${d.id}`, { status: "sent" }, "agent");
    expect(sent.body.status).toBe("sent");
    expect(sent.body.sent_at).toBeTruthy();
    const attendee = await call("GET", `/api/attendees/${d.attendee_id}`);
    expect(attendee.body.status).toBe("contacted");
  });

  it("treats the person at the keyboard as the approver when running outside Clawnify", async () => {
    const eventId = await newEvent();
    await shortlist(await newRun(eventId, "shortlist"), [person("Noor Haddad")]);
    const [d] = await drafts(eventId);
    const r = await call("PATCH", `/api/messages/${d.id}`, { status: "approved" }, "local");
    expect(r.status).toBe(200);
    expect(r.body.approved_by).toBe("Local");
  });

  it("skipping someone discards what was waiting to go out", async () => {
    const eventId = await newEvent();
    await shortlist(await newRun(eventId, "shortlist"), [person("Lena Vogel")]);
    const [d] = await drafts(eventId);
    expect((await call("PATCH", `/api/attendees/${d.attendee_id}`, { status: "skipped" }, "agent")).status).toBe(403);
    await call("PATCH", `/api/attendees/${d.attendee_id}`, { status: "skipped" });
    expect((await call("GET", `/api/events/${eventId}/messages?status=discarded`)).body.total).toBe(1);
  });
});

describe("inbox", () => {
  it("records each message once, makes unknown senders attendees, and clears when you reply", async () => {
    const eventId = await newEvent();
    const runId = await newRun(eventId, "inbox");
    const msg = { name: "Alex Moreau", portal_profile_url: "https://portal.example/people/alex", body: "Hi Jordan, it'd be good to meet you at the summit", received_at: "2026-10-09T18:00:00Z" };
    const first = await call("POST", `/api/runs/${runId}/inbound`, { messages: [msg] }, "agent");
    expect(first.body.results[0].status).toBe("recorded");
    const again = await call("POST", `/api/runs/${runId}/inbound`, { messages: [{ ...msg, body: `  ${msg.body} ` }] }, "agent");
    expect(again.body.results[0].status).toBe("duplicate");

    const event = await call("GET", `/api/events/${eventId}`);
    expect(event.body.counts.waiting).toBe(1);
    const waiting = await call("GET", `/api/events/${eventId}/attendees?view=waiting`);
    expect(waiting.body.attendees[0]).toMatchObject({ name: "Alex Moreau", source: "inbound", waiting: true });

    const attendeeId = first.body.results[0].attendee_id;
    expect((await call("POST", `/api/attendees/${attendeeId}/messages`, { body: "Happy to. Tuesday?" }, "agent")).status).toBe(403);
    const reply = await call("POST", `/api/attendees/${attendeeId}/messages`, { body: "Happy to. Tuesday?" });
    expect(reply.body.status).toBe("approved");
    expect((await call("GET", `/api/events/${eventId}`)).body.counts.waiting).toBe(0);
  });

  it("records a meeting once and marks the person", async () => {
    const eventId = await newEvent();
    const runId = await newRun(eventId, "inbox");
    const meeting = { name: "Kenji Mori", starts_at: "2026-10-14T10:00:00Z", location: "Networking lounge" };
    expect((await call("POST", `/api/runs/${runId}/meetings`, { meetings: [meeting] }, "agent")).body.results[0].status).toBe("recorded");
    expect((await call("POST", `/api/runs/${runId}/meetings`, { meetings: [meeting] }, "agent")).body.results[0].status).toBe("duplicate");
    const list = await call("GET", `/api/events/${eventId}/meetings`);
    expect(list.body.total).toBe(1);
    expect(list.body.meetings[0].attendee.name).toBe("Kenji Mori");
  });
});

describe("runs", () => {
  it("closes a finished run to writes and keeps each kind to its own job", async () => {
    const eventId = await newEvent();
    const shortlistRun = await newRun(eventId, "shortlist");
    const wrong = await call("POST", `/api/runs/${shortlistRun}/inbound`, { messages: [{ name: "X", body: "hi" }] }, "agent");
    expect(wrong.status).toBe(409);
    expect((await call("PATCH", `/api/runs/${shortlistRun}`, { status: "blocked" }, "agent")).status).toBe(400);
    const done = await call("PATCH", `/api/runs/${shortlistRun}`, { status: "done", coverage: "Opened 40 profiles" }, "agent");
    expect(done.body).toMatchObject({ status: "done", coverage: "Opened 40 profiles" });
    const late = await call("POST", `/api/runs/${shortlistRun}/attendees`, { attendees: [person("Late")] }, "agent");
    expect(late.status).toBe(410);
  });

  it("dispatches from the button: one at a time per kind, a brief within the agent's limit", async () => {
    const eventId = await newEvent();
    expect((await call("POST", `/api/events/${eventId}/dispatch`, { id: id(), kind: "shortlist" }, "agent")).status).toBe(403);
    expect((await call("POST", `/api/events/${eventId}/dispatch`, { id: id(), kind: "send" }, "local")).status).toBe(400);

    const runId = id();
    const first = await call("POST", `/api/events/${eventId}/dispatch`, { id: runId, kind: "shortlist" }, "local");
    expect(first.status).toBe(200);
    expect(first.body.dispatched).toBe(false); // no platform locally: the brief is handed over by hand
    expect(first.body.brief).toContain(runId);
    expect(first.body.brief.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);

    expect((await call("POST", `/api/events/${eventId}/dispatch`, { id: runId, kind: "shortlist" }, "local")).status).toBe(200); // retried click
    const second = await call("POST", `/api/events/${eventId}/dispatch`, { id: id(), kind: "shortlist" }, "local");
    expect(second.status).toBe(409);
    expect((await call("POST", `/api/events/${eventId}/dispatch`, { id: id(), kind: "inbox" }, "local")).status).toBe(200);
  });

  it("keeps the control routes out of the agent's API discovery", async () => {
    const r = await call("GET", "/api/openapi.json");
    const paths = Object.keys(r.body.paths);
    expect(paths).toContain("/api/runs/{id}/attendees");
    expect(paths.some((p) => p.includes("dispatch") || p.includes("settings") || p.includes("agents"))).toBe(false);
  });
});
