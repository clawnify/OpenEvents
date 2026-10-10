import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CalendarDays, Plus } from "lucide-react";
import { TileIcon } from "@clawnify/app/client";
import { api, type EventItem } from "../api";
import { Button, Dialog } from "../components/ui";
import { dateRange } from "../components/status";
import { Toolbar, Field, Notice } from "../components/layout";

export function EventsPage({ events, loaded, onChanged }: { events: EventItem[]; loaded: boolean; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Toolbar
        icon={<TileIcon icon="calendar-days" color="sky" size={20} />}
        title="Events"
        actions={
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> Add event
          </Button>
        }
      />
      {!loaded ? (
        <TableSkeleton />
      ) : events.length === 0 ? (
        <div className="mx-auto max-w-md px-6 py-20 text-center">
          <CalendarDays size={40} strokeWidth={1.25} className="mx-auto text-faint" />
          <h2 className="mt-4 text-[1.0625rem] font-semibold">Work your next event with your agent</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Add the event's attendee portal and who you want to meet. Your agent shortlists people and drafts a message for each;
            nothing goes out until you approve it.
          </p>
          <div className="mt-5">
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus size={16} /> Add event
            </Button>
          </div>
        </div>
      ) : (
        <EventsTable events={events} />
      )}
      <NewEventDialog open={open} onOpenChange={setOpen} onCreated={onChanged} />
    </>
  );
}

function EventsTable({ events }: { events: EventItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[0.8125rem]">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="h-8 px-4 font-medium">Event</th>
            <th className="h-8 px-4 font-medium">Dates</th>
            <th className="h-8 px-4 text-right font-medium">People</th>
            <th className="h-8 px-4 text-right font-medium">To approve</th>
            <th className="h-8 px-4 text-right font-medium">Sent</th>
            <th className="h-8 px-4 text-right font-medium">Waiting on you</th>
            <th className="h-8 px-4 text-right font-medium">Meetings</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b border-border/60 hover:bg-muted">
              <td className="h-11 px-4">
                <Link to={`/events/${e.id}`} className="flex items-center gap-2 font-medium hover:underline">
                  <TileIcon icon="calendar" color="sky" size={18} />
                  {e.name}
                </Link>
              </td>
              <td className="px-4 text-muted-foreground">{dateRange(e.starts_on, e.ends_on) || "No dates"}</td>
              <td className="data px-4 text-right">{e.counts.people}</td>
              <td className={`data px-4 text-right ${e.counts.to_approve ? "font-medium" : "text-muted-foreground"}`}>{e.counts.to_approve}</td>
              <td className="data px-4 text-right text-muted-foreground">{e.counts.sent}</td>
              <td className={`data px-4 text-right ${e.counts.waiting ? "font-medium text-info" : "text-muted-foreground"}`}>{e.counts.waiting}</td>
              <td className="data px-4 text-right text-muted-foreground">{e.counts.meetings}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-sm bg-muted" />
      ))}
    </div>
  );
}

function NewEventDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => Promise<void> }) {
  const navigate = useNavigate();
  const [draftId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [portal, setPortal] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [icp, setIcp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const e = await api.createEvent({
        id: draftId, name: name.trim(), portal_url: portal.trim(),
        starts_on: starts || null, ends_on: ends || starts || null, icp: icp.trim(),
      });
      await onCreated();
      onOpenChange(false);
      navigate(`/events/${e.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add an event" submitLabel="Add event" submitting={busy || !name.trim() || !portal.trim()} onSubmit={submit}>
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Founders Summit 2026" autoFocus />
      </Field>
      <Field label="Attendee portal" hint="The page where the event's networking and chat live, once you are logged in.">
        <input className="input" type="url" value={portal} onChange={(e) => setPortal(e.target.value)} placeholder="https://…/community" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts">
          <input className="input" type="date" value={starts} onChange={(e) => setStarts(e.target.value)} />
        </Field>
        <Field label="Ends">
          <input className="input" type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
        </Field>
      </div>
      <Field label="Who you want to meet">
        <textarea className="textarea text-sm" rows={3} value={icp} onChange={(e) => setIcp(e.target.value)} placeholder="Founders of agencies with 5 to 50 people…" />
      </Field>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Dialog>
  );
}
