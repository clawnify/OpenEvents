// Thin typed wrapper over the app's own API. Every list is paginated; the server
// caps a page at 100, so there is no call that returns a whole table.

export type RunKind = "shortlist" | "send" | "inbox";
export type Fit = "strong" | "maybe" | "no";
export type AttendeeStatus = "new" | "contacted" | "replied" | "meeting" | "skipped" | "declined";
export type MessageStatus = "draft" | "approved" | "sent" | "failed" | "held" | "discarded" | "received";

export interface Counts {
  people: number;
  to_approve: number;
  to_send: number;
  needs_attention: number;
  sent: number;
  waiting: number;
  meetings: number;
}

export interface EventItem {
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
  platform_notes: string[];
  archived: boolean;
  created_at: string;
  updated_at: string;
  counts: Counts;
}

export interface EventDetail extends EventItem {
  resolved_offer: string;
  offer_source: { title: string; version: number; url: string } | null;
}

export type EventInput = Partial<Omit<EventItem, "id" | "counts" | "created_at" | "updated_at">>;

export interface Run {
  id: string;
  event_id: string;
  kind: RunKind;
  status: "running" | "done" | "failed" | "blocked";
  stale: boolean;
  coverage: string;
  error: string;
  dispatched: boolean;
  heartbeat_at: string | null;
  finished_at: string | null;
  stopped_by_name: string | null;
  stopped_by_avatar: string | null;
  created_at: string;
}

export interface Attendee {
  id: string;
  event_id: string;
  source: "shortlist" | "inbound";
  name: string;
  title: string;
  company: string;
  domain: string;
  portal_profile_url: string;
  linkedin_url: string;
  fit: Fit | null;
  why_fit: string;
  evidence: { url: string; quote: string }[];
  status: AttendeeStatus;
  waiting: boolean;
  last_message: { direction: "out" | "in"; status: MessageStatus; body: string; created_at: string } | null;
  created_at: string;
}

export interface Message {
  id: string;
  event_id: string;
  attendee_id: string;
  direction: "out" | "in";
  body: string;
  status: MessageStatus;
  error: string;
  author: "agent" | "user" | "them";
  approved_by: string | null;
  sent_at: string | null;
  received_at: string | null;
  created_at: string;
  attendee?: {
    name: string; title: string; company: string; domain: string; portal_profile_url: string;
    fit: Fit | null; why_fit: string; evidence: { url: string; quote: string }[];
  };
}

export interface Meeting {
  id: string;
  attendee_id: string;
  starts_at: string | null;
  location: string;
  portal_url: string;
  attendee?: { name: string; company: string };
}

export interface AttendeeDetail extends Attendee {
  messages: Message[];
  meetings: Meeting[];
  other_events: { attendee_id: string; event_id: string; event_name: string; status: AttendeeStatus }[];
}

export interface AgentServer {
  id: string;
  name: string | null;
  status: string | null;
}

export interface Dispatch {
  run: Run;
  brief: string;
  dispatched: boolean;
  error?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError(text.slice(0, 200) || res.statusText, res.status);
  }
  if (!res.ok) {
    const body = data as { error?: string; code?: string } | null;
    throw new ApiError(body?.error ?? res.statusText, res.status, body?.code);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

type Paged<K extends string, T> = { [P in K]: T[] } & { total: number; page: number; limit: number };

export const api = {
  events: (p: { page?: number; search?: string; archived?: boolean } = {}) =>
    request<Paged<"events", EventItem>>(`/api/events${qs({ page: p.page, search: p.search, archived: p.archived ? "true" : undefined, limit: 50 })}`),
  event: (id: string) => request<EventDetail>(`/api/events/${id}`),
  createEvent: (input: EventInput & { id: string; name: string; portal_url: string }) =>
    request<EventItem>("/api/events", { method: "POST", body: JSON.stringify(input) }),
  updateEvent: (id: string, input: EventInput) => request<EventItem>(`/api/events/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  attendees: (eventId: string, p: { page?: number; search?: string; view?: "people" | "waiting" | "all"; status?: AttendeeStatus; fit?: Fit } = {}) =>
    request<Paged<"attendees", Attendee>>(`/api/events/${eventId}/attendees${qs({ ...p, limit: 50 })}`),
  attendee: (id: string) => request<AttendeeDetail>(`/api/attendees/${id}`),
  setAttendeeStatus: (id: string, status: AttendeeStatus) =>
    request<Attendee>(`/api/attendees/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  writeMessage: (attendeeId: string, body: string) =>
    request<Message>(`/api/attendees/${attendeeId}/messages`, { method: "POST", body: JSON.stringify({ body }) }),
  clearInbox: (attendeeId: string) => request<Attendee>(`/api/attendees/${attendeeId}/clear`, { method: "POST" }),

  messages: (eventId: string, p: { page?: number; status?: MessageStatus; direction?: "out" | "in" } = {}) =>
    request<Paged<"messages", Message>>(`/api/events/${eventId}/messages${qs({ ...p, limit: 50 })}`),
  updateMessage: (id: string, patch: { body?: string; status?: MessageStatus }) =>
    request<Message>(`/api/messages/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  meetings: (eventId: string, page = 1) => request<Paged<"meetings", Meeting>>(`/api/events/${eventId}/meetings${qs({ page, limit: 50 })}`),

  runs: (eventId: string, page = 1) => request<Paged<"runs", Run>>(`/api/events/${eventId}/runs${qs({ page, limit: 25 })}`),
  dispatch: (eventId: string, kind: RunKind, id: string) =>
    request<Dispatch>(`/api/events/${eventId}/dispatch`, { method: "POST", body: JSON.stringify({ id, kind }) }),
  stopRun: (id: string) => request<Run>(`/api/runs/${id}/stop`, { method: "POST" }),

  agents: () => request<{ available: boolean; servers: AgentServer[]; selected: string | null }>("/api/agents"),
  saveAgent: (server_id: string | null) => request<{ server_id: string | null }>("/api/settings", { method: "PUT", body: JSON.stringify({ server_id }) }),
};
