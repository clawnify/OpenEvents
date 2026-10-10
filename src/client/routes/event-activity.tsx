import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, Square } from "lucide-react";
import { api, type EventDetail, type Meeting, type Run } from "../api";
import { Avatar, Button, Tooltip } from "../components/ui";
import { Notice } from "../components/layout";
import { RUN_LABEL, RunBadge, ago, formatDateTime } from "../components/status";
import { TableSkeleton } from "./events";

export function MeetingsTab({ event, version }: { event: EventDetail; version: number }) {
  const [rows, setRows] = useState<Meeting[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.meetings(event.id).then((r) => setRows(r.meetings), (e) => setError((e as Error).message));
  }, [event.id, version]);

  if (error) return <div className="p-6"><Notice tone="danger">{error}</Notice></div>;
  if (!rows) return <TableSkeleton />;
  if (!rows.length) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="font-medium">No meetings yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Meetings booked in the portal show up here after Check inbox.</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto pt-3">
      <table className="w-full text-[0.8125rem]">
        <thead>
          <tr className="border-y border-border text-left text-muted-foreground">
            <th className="h-8 px-4 font-medium md:pl-6">When</th>
            <th className="h-8 px-4 font-medium">With</th>
            <th className="h-8 px-4 font-medium">Where</th>
            <th className="h-8 px-4 font-medium"><span className="sr-only">Portal</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className="border-b border-border/60 hover:bg-muted">
              <td className="data h-11 px-4 md:pl-6">{m.starts_at ? formatDateTime(m.starts_at) : <span className="text-faint">No time given</span>}</td>
              <td className="px-4">
                <Link to={`/events/${event.id}/people/${m.attendee_id}`} className="font-medium hover:underline">{m.attendee?.name}</Link>
                {m.attendee?.company ? <span className="text-muted-foreground"> · {m.attendee.company}</span> : null}
              </td>
              <td className="px-4 text-muted-foreground">{m.location}</td>
              <td className="px-4 text-right">
                {m.portal_url ? (
                  <a href={m.portal_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                    Portal <ExternalLink size={13} />
                  </a>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunsTab({ runs, onChanged }: { runs: Run[]; onChanged: () => Promise<void> }) {
  const [error, setError] = useState("");
  if (!runs.length) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="font-medium">No runs yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Each time you press Find people, Send approved or Check inbox, the run and what your agent reported show up here.</p>
      </div>
    );
  }
  return (
    <div className="pt-3">
      {error ? <div className="px-4 pb-3 md:px-6"><Notice tone="danger">{error}</Notice></div> : null}
      <div className="overflow-x-auto">
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="border-y border-border text-left text-muted-foreground">
              <th className="h-8 px-4 font-medium md:pl-6">Run</th>
              <th className="h-8 px-4 font-medium">Status</th>
              <th className="h-8 px-4 font-medium">Started</th>
              <th className="h-8 px-4 font-medium">What the agent reported</th>
              <th className="h-8 px-4 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-border/60 align-top hover:bg-muted">
                <td className="h-11 px-4 py-3 font-medium md:pl-6">{RUN_LABEL[r.kind]}</td>
                <td className="px-4 py-3"><RunBadge run={r} /></td>
                <td className="px-4 py-3 text-muted-foreground">{ago(r.created_at)}</td>
                <td className="max-w-xl px-4 py-3">
                  {r.coverage ? <p>{r.coverage}</p> : null}
                  {r.stopped_by_name ? (
                    <p className="flex items-center gap-1.5 text-muted-foreground">
                      <span>Stopped by</span>
                      <Avatar name={r.stopped_by_name} src={r.stopped_by_avatar} size={18} />
                      <span className="font-medium text-foreground">{r.stopped_by_name}</span>
                    </p>
                  ) : r.error ? <p className="text-destructive">{r.error}</p> : null}
                  {!r.coverage && !r.error ? <span className="text-faint">Nothing yet</span> : null}
                </td>
                <td className="px-4 py-3 text-right">
                  {r.status === "running" ? (
                    <Tooltip label="Stop this run. Your agent's later writes to it are refused.">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Stop ${RUN_LABEL[r.kind]}`}
                        onClick={async () => {
                          try {
                            await api.stopRun(r.id);
                            await onChanged();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        <Square size={14} />
                      </Button>
                    </Tooltip>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
