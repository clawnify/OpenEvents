import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, UserX } from "lucide-react";
import { api, type EventDetail, type Message } from "../api";
import { Button, Card, Favicon } from "../components/ui";
import { Notice } from "../components/layout";
import { FitBadge } from "../components/status";
import { MessageEditor } from "../components/message-editor";
import { TableSkeleton } from "./events";

/**
 * The approval queue. Every message your agent drafted waits here; nothing goes
 * out until you approve it, and what you approve is sent word for word.
 */
export function ApproveTab({ event, version, onChanged }: { event: EventDetail; version: number; onChanged: () => Promise<void> }) {
  const [groups, setGroups] = useState<{ attention: Message[]; drafts: Message[]; approved: Message[] } | null>(null);
  const [error, setError] = useState("");

  async function load() {
    try {
      const [held, failed, drafts, approved] = await Promise.all([
        api.messages(event.id, { status: "held" }),
        api.messages(event.id, { status: "failed" }),
        api.messages(event.id, { status: "draft" }),
        api.messages(event.id, { status: "approved" }),
      ]);
      setGroups({ attention: [...held.messages, ...failed.messages], drafts: drafts.messages, approved: approved.messages });
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

  if (!groups) return <TableSkeleton />;
  const empty = !groups.attention.length && !groups.drafts.length && !groups.approved.length;

  return (
    <section className="mx-auto max-w-3xl space-y-6 px-4 py-4 md:px-6">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {empty ? (
        <div className="py-16 text-center">
          <p className="font-medium">Nothing to approve</p>
          <p className="mt-1 text-sm text-muted-foreground">Drafts appear here after Find people. Your agent never sends one you have not approved.</p>
        </div>
      ) : null}
      <Group title="Needs attention" hint="Your agent held these back or could not send them." items={groups.attention} event={event} onChanged={changed} onError={setError} />
      <Group title="To approve" items={groups.drafts} event={event} onChanged={changed} onError={setError} />
      <Group title="Approved, not sent yet" hint="These go out, word for word, the next time you press Send approved." items={groups.approved} event={event} onChanged={changed} onError={setError} />
    </section>
  );
}

function Group({ title, hint, items, event, onChanged, onError }: {
  title: string; hint?: string; items: Message[]; event: EventDetail; onChanged: () => Promise<void>; onError: (t: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-[0.8125rem] font-medium text-muted-foreground">
          {title} <span className="data">· {items.length}</span>
        </h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {items.map((m) => (
        <DraftCard key={m.id} message={m} event={event} onChanged={onChanged} onError={onError} />
      ))}
    </div>
  );
}

function DraftCard({ message, event, onChanged, onError }: { message: Message; event: EventDetail; onChanged: () => Promise<void>; onError: (t: string) => void }) {
  const a = message.attendee!;
  const [busy, setBusy] = useState(false);

  async function skip() {
    setBusy(true);
    try {
      await api.setAttendeeStatus(message.attendee_id, "skipped");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <Link to={`/events/${event.id}/people/${message.attendee_id}`} className="font-medium hover:underline">{a.name}</Link>
          <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
            <Favicon domain={a.domain} size={14} />
            {[a.title, a.company].filter(Boolean).join(" · ") || "No title or company"}
            {a.portal_profile_url ? (
              <a href={a.portal_profile_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 hover:text-foreground" aria-label={`${a.name} in the portal`}>
                <ExternalLink size={13} />
              </a>
            ) : null}
          </p>
        </div>
        <FitBadge fit={a.fit} />
        <Button variant="ghost" disabled={busy} onClick={skip} aria-label={`Skip ${a.name}`}>
          <UserX size={16} /> Skip
        </Button>
      </div>
      {a.why_fit ? <p className="text-sm">{a.why_fit}</p> : null}
      {a.evidence.length ? (
        <ul className="space-y-1">
          {a.evidence.slice(0, 3).map((ev) => (
            <li key={ev.url + ev.quote} className="text-xs text-muted-foreground">
              “{ev.quote}”{" "}
              <a href={ev.url} target="_blank" rel="noreferrer" className="underline hover:text-foreground">{hostOf(ev.url)}</a>
            </li>
          ))}
        </ul>
      ) : null}
      <MessageEditor message={message} maxChars={event.message_max_chars} onChange={() => void onChanged()} onError={onError} />
    </Card>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
