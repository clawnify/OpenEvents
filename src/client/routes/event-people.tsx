import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { api, type Attendee, type EventDetail } from "../api";
import { Favicon } from "../components/ui";
import { Notice, Pager } from "../components/layout";
import { AttendeeStatusLabel, FitBadge, MessageBadge, ago } from "../components/status";
import { TableSkeleton } from "./events";

export function PeopleTab({ event, version }: { event: EventDetail; version: number }) {
  const [rows, setRows] = useState<Attendee[] | null>(null);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [all, setAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.attendees(event.id, { page, search, view: all ? "all" : "people" });
        if (cancelled) return;
        setRows(r.attendees);
        setTotal(r.total);
        setLimit(r.limit);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }, search ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [event.id, page, search, all, version]);

  return (
    <section className="pt-3">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 md:px-6">
        <button
          onClick={() => { setAll(!all); setPage(1); }}
          className="inline-flex h-7 items-center rounded-sm px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-pressed={all}
        >
          {all ? "Showing everyone looked at" : "Showing fits and people who wrote"}
        </button>
        <span className="data text-sm text-muted-foreground">{total}</span>
        <div className="relative ml-auto w-full sm:w-64">
          <Search size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            className="input pl-8 text-sm"
            placeholder="Search name, company, title"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            aria-label="Search people"
          />
        </div>
      </div>
      {error ? <div className="px-4 md:px-6"><Notice tone="danger">{error}</Notice></div> : null}
      {rows === null ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        search ? (
          <div className="px-6 py-16 text-center text-sm">
            <p className="font-medium">Nobody matches "{search}"</p>
            <button className="mt-2 text-muted-foreground underline" onClick={() => setSearch("")}>Clear the search</button>
          </div>
        ) : (
          <div className="mx-auto max-w-md px-6 py-16 text-center">
            <p className="font-medium">Nobody shortlisted yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {event.icp.trim()
                ? "Press Find people and your agent works through the attendee portal for people who match who you want to meet."
                : "Say who you want to meet in Settings, then press Find people."}
            </p>
          </div>
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[0.8125rem]">
              <thead>
                <tr className="border-y border-border text-left text-muted-foreground">
                  <th className="h-8 px-4 font-medium md:pl-6">Person</th>
                  <th className="h-8 px-4 font-medium">Company</th>
                  <th className="h-8 px-4 font-medium">Fit</th>
                  <th className="h-8 px-4 font-medium">Status</th>
                  <th className="h-8 px-4 font-medium">Latest message</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b border-border/60 hover:bg-muted">
                    <td className="h-11 max-w-64 px-4 md:pl-6">
                      <Link to={`/events/${event.id}/people/${a.id}`} className="block truncate font-medium hover:underline">{a.name}</Link>
                      {a.title ? <span className="block truncate text-xs text-muted-foreground">{a.title}</span> : null}
                    </td>
                    <td className="max-w-48 px-4">
                      <span className="flex items-center gap-1.5 truncate">
                        <Favicon domain={a.domain} size={14} />
                        {a.company || <span className="text-faint">Unknown</span>}
                      </span>
                    </td>
                    <td className="px-4"><FitBadge fit={a.fit} /></td>
                    <td className="px-4">
                      <span className="flex items-center gap-1.5">
                        <AttendeeStatusLabel status={a.status} />
                        {a.waiting ? <span className="text-xs font-medium text-info">Waiting on you</span> : null}
                      </span>
                    </td>
                    <td className="max-w-80 px-4">
                      {a.last_message ? (
                        <span className="flex items-center gap-2">
                          {a.last_message.direction === "out" ? <MessageBadge status={a.last_message.status} /> : null}
                          <span className="min-w-0 truncate text-muted-foreground">
                            {a.last_message.direction === "in" ? `${a.name.split(" ")[0]}: ` : ""}
                            {a.last_message.body}
                          </span>
                          <span className="shrink-0 text-xs text-faint">{ago(a.last_message.created_at)}</span>
                        </span>
                      ) : (
                        <span className="text-faint">None</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} limit={limit} total={total} onPage={setPage} />
        </>
      )}
    </section>
  );
}
