import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronLeft, ExternalLink, Send } from "lucide-react";
import { useChatContext, useHostChanges } from "@clawnify/app/client";
import { api, type AttendeeDetail, type AttendeeStatus, type EventDetail } from "../api";
import { Button, Card, CardTitle, Favicon, Picker } from "../components/ui";
import { Notice } from "../components/layout";
import { FitBadge, MessageBadge, attendeeStatusLabel, formatDateTime } from "../components/status";
import { MessageEditor } from "../components/message-editor";
import { TableSkeleton } from "./events";

const STATUSES: AttendeeStatus[] = ["new", "contacted", "replied", "meeting", "skipped", "declined"];

/** One person at one event: who they are, why they fit, and the whole conversation. */
export function AttendeePage({ onChanged }: { onChanged: () => Promise<void> }) {
  const { eventId = "", id = "" } = useParams();
  const [a, setA] = useState<AttendeeDetail | null>(null);
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [person, ev] = await Promise.all([api.attendee(id), api.event(eventId)]);
      setA(person);
      setEvent(ev);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, eventId]);
  useEffect(() => void load(), [load]);
  useHostChanges(() => void load());
  useChatContext({ label: "Person at an event", record: a ? { type: "attendee", id: a.id, label: a.name } : undefined });

  const changed = async () => {
    await Promise.all([load(), onChanged()]);
  };

  if (!a || !event) return error ? <div className="p-6"><Notice tone="danger">{error}</Notice></div> : <TableSkeleton />;
  const over = text.trim().length > event.message_max_chars;

  async function act(fn: () => Promise<unknown>, clear = false) {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (clear) setText("");
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-14 items-center gap-2 border-b border-border px-4 md:px-6">
        <Link to={`/events/${event.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft size={16} /> {event.name}
        </Link>
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="space-y-4 border-border p-4 md:p-6 lg:w-[26rem] lg:shrink-0 lg:border-r">
          <div>
            <h1 className="text-[1.375rem] font-semibold leading-tight">{a.name}</h1>
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Favicon domain={a.domain} size={14} />
              {[a.title, a.company].filter(Boolean).join(" · ") || "No title or company"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FitBadge fit={a.fit} />
            <Picker
              kind="view"
              label="Status"
              value={a.status}
              options={STATUSES.map((s) => ({ value: s, label: attendeeStatusLabel(s) }))}
              onChange={(s) => act(() => api.setAttendeeStatus(a.id, s as AttendeeStatus))}
            />
          </div>
          <dl className="space-y-2 text-sm">
            {a.domain ? <Row label="Website"><a className="hover:underline" href={`https://${a.domain}`} target="_blank" rel="noreferrer">{a.domain}</a></Row> : null}
            {a.portal_profile_url ? <Row label="Portal"><a className="inline-flex items-center gap-1 hover:underline" href={a.portal_profile_url} target="_blank" rel="noreferrer">Profile <ExternalLink size={13} /></a></Row> : null}
            {a.linkedin_url ? <Row label="LinkedIn"><a className="inline-flex items-center gap-1 hover:underline" href={a.linkedin_url} target="_blank" rel="noreferrer">Profile <ExternalLink size={13} /></a></Row> : null}
          </dl>
          {a.why_fit ? (
            <div>
              <h2 className="text-[0.8125rem] font-medium text-muted-foreground">Why they fit</h2>
              <p className="mt-1 text-sm">{a.why_fit}</p>
            </div>
          ) : null}
          {a.evidence.length ? (
            <div>
              <h2 className="text-[0.8125rem] font-medium text-muted-foreground">What your agent read</h2>
              <ul className="mt-1 space-y-2">
                {a.evidence.map((ev) => (
                  <li key={ev.url + ev.quote} className="text-sm">
                    “{ev.quote}”
                    <a href={ev.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-muted-foreground underline">{ev.url}</a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {a.other_events.length ? (
            <div>
              <h2 className="text-[0.8125rem] font-medium text-muted-foreground">Also met at</h2>
              <ul className="mt-1 space-y-1 text-sm">
                {a.other_events.map((o) => (
                  <li key={o.attendee_id}>
                    <Link to={`/events/${o.event_id}/people/${o.attendee_id}`} className="hover:underline">{o.event_name}</Link>
                    <span className="text-muted-foreground"> · {attendeeStatusLabel(o.status)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        <section className="min-w-0 flex-1 space-y-4 p-4 md:p-6">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Card className="space-y-3 p-4">
            <CardTitle right={a.messages.length}>Conversation</CardTitle>
            {a.messages.length === 0 ? <p className="text-sm text-muted-foreground">No messages yet.</p> : null}
            <ol className="space-y-3">
              {a.messages.map((m) => (
                <li key={m.id} className={`rounded-sm px-3 py-2 ${m.direction === "in" ? "bg-muted" : "shadow-edge"}`}>
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{m.direction === "in" ? a.name : m.author === "user" ? "You" : "Drafted by your agent"}</span>
                    {m.direction === "out" ? <MessageBadge status={m.status} /> : null}
                    <span>{formatDateTime(m.sent_at ?? m.received_at ?? m.created_at)}</span>
                  </div>
                  {m.direction === "out" && ["draft", "approved", "held", "failed"].includes(m.status) ? (
                    <MessageEditor message={m} maxChars={event.message_max_chars} onChange={() => void changed()} onError={setError} />
                  ) : (
                    <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                  )}
                </li>
              ))}
            </ol>
            <div className="space-y-2 border-t border-border pt-3">
              <textarea className="textarea text-sm" rows={3} placeholder="Write a message…" value={text} onChange={(e) => setText(e.target.value)} aria-label={`Message to ${a.name}`} />
              <div className="flex items-center gap-2">
                <span className={`data text-xs ${over ? "text-destructive" : "text-muted-foreground"}`}>{text.trim().length} / {event.message_max_chars}</span>
                <span className="text-xs text-muted-foreground">Goes out with the next Send approved.</span>
                <span className="flex-1" />
                <Button variant="primary" disabled={busy || over || !text.trim()} onClick={() => act(() => api.writeMessage(a.id, text), true)}>
                  <Send size={16} /> Queue message
                </Button>
              </div>
            </div>
          </Card>
          <Card className="space-y-2 p-4">
            <CardTitle right={a.meetings.length}>Meetings</CardTitle>
            {a.meetings.length ? (
              <ul className="divide-y divide-border text-sm">
                {a.meetings.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 py-2">
                    <span className="data">{m.starts_at ? formatDateTime(m.starts_at) : "No time given"}</span>
                    <span className="text-muted-foreground">{m.location}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">None booked in the portal yet.</p>
            )}
          </Card>
        </section>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </div>
  );
}
