import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Send } from "lucide-react";
import { api, type Attendee, type EventDetail } from "../api";
import { Button, Card } from "../components/ui";
import { Notice } from "../components/layout";
import { FitBadge, ago } from "../components/status";
import { TableSkeleton } from "./events";

/** Who wrote to you and is waiting for an answer. Replies go out with the next send. */
export function InboxTab({ event, version, onChanged }: { event: EventDetail; version: number; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<Attendee[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      setRows((await api.attendees(event.id, { view: "waiting" })).attendees);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, version]);

  const changed = async () => {
    await Promise.all([load(), onChanged()]);
  };

  if (!rows) return <TableSkeleton />;
  return (
    <section className="mx-auto max-w-3xl space-y-3 px-4 py-4 md:px-6">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {rows.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-medium">Nobody is waiting on you</p>
          <p className="mt-1 text-sm text-muted-foreground">Press Check inbox and your agent records new messages from the portal here.</p>
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Replies you write here are approved as written and go out the next time you press Send approved.</p>
          {rows.map((a) => <Conversation key={a.id} attendee={a} event={event} onChanged={changed} onError={setError} />)}
        </>
      )}
    </section>
  );
}

function Conversation({ attendee: a, event, onChanged, onError }: { attendee: Attendee; event: EventDetail; onChanged: () => Promise<void>; onError: (t: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const over = text.trim().length > event.message_max_chars;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      setText("");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link to={`/events/${event.id}/people/${a.id}`} className="font-medium hover:underline">{a.name}</Link>
          <p className="truncate text-sm text-muted-foreground">{[a.title, a.company].filter(Boolean).join(" · ")}</p>
        </div>
        <FitBadge fit={a.fit} />
      </div>
      {a.last_message?.direction === "in" ? (
        <blockquote className="rounded-sm bg-muted px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap">{a.last_message.body}</p>
          <p className="mt-1 text-xs text-muted-foreground">{ago(a.last_message.created_at)}</p>
        </blockquote>
      ) : null}
      <textarea className="textarea text-sm" rows={3} placeholder={`Reply to ${a.name.split(" ")[0]}…`} value={text} onChange={(e) => setText(e.target.value)} aria-label={`Reply to ${a.name}`} />
      <div className="flex flex-wrap items-center gap-2">
        <span className={`data text-xs ${over ? "text-destructive" : "text-muted-foreground"}`}>{text.trim().length} / {event.message_max_chars}</span>
        <span className="flex-1" />
        <Button variant="ghost" disabled={busy} onClick={() => act(() => api.clearInbox(a.id))}>
          <Check size={16} /> Dealt with
        </Button>
        <Button variant="secondary" disabled={busy || over || !text.trim()} onClick={() => act(() => api.writeMessage(a.id, text))}>
          <Send size={16} /> Queue reply
        </Button>
      </div>
    </Card>
  );
}
