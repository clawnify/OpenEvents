import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Check, Copy, ExternalLink, Inbox, Search, Send } from "lucide-react";
import { TileIcon, useChatContext, useHostChanges } from "@clawnify/app/client";
import { api, type EventDetail, type Run, type RunKind } from "../api";
import { Button, Tooltip } from "../components/ui";
import { Notice, Toolbar } from "../components/layout";
import { dateRange, RUN_LABEL } from "../components/status";
import { TableSkeleton } from "./events";
import { PeopleTab } from "./event-people";
import { ApproveTab } from "./event-approve";
import { InboxTab } from "./event-inbox";
import { MeetingsTab, RunsTab } from "./event-activity";
import { EventSettingsTab } from "./event-settings";

const TABS = [
  { id: "people", label: "People" },
  { id: "approve", label: "To approve" },
  { id: "inbox", label: "Inbox" },
  { id: "meetings", label: "Meetings" },
  { id: "runs", label: "Runs" },
  { id: "settings", label: "Settings" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function EventPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "people") as Tab;
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState("");
  const [handoff, setHandoff] = useState<{ kind: RunKind; brief: string; reason: string } | null>(null);
  const [starting, setStarting] = useState<RunKind | null>(null);
  // Bumped whenever something may have changed, so the open tab refetches.
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const [e, r] = await Promise.all([api.event(id), api.runs(id)]);
      setEvent(e);
      setRuns(r.runs);
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    setEvent(null);
    setHandoff(null);
    void load();
  }, [load]);
  useHostChanges(() => void load());
  useChatContext({ label: "Event", record: event ? { type: "event", id: event.id, label: event.name } : undefined });

  // Poll only while the agent is working: a finished or stalled run will not
  // change on its own, and this page may sit open in the dashboard all day.
  const live = runs.some((r) => r.status === "running" && !r.stale);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [live, load]);

  const changed = useCallback(async () => {
    await Promise.all([load(), onChanged()]);
  }, [load, onChanged]);

  async function start(kind: RunKind) {
    if (!event) return;
    setStarting(kind);
    setError("");
    try {
      const d = await api.dispatch(event.id, kind, crypto.randomUUID());
      if (!d.dispatched) {
        setHandoff({
          kind,
          brief: d.brief,
          reason: d.error
            ? `Your agent did not confirm it received this (${d.error}). Paste it into your agent's chat to be sure.`
            : "This copy of the app is not connected to an agent. Paste this into your agent's chat to start.",
        });
      } else {
        setHandoff(null);
      }
      await changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(null);
    }
  }

  if (!event) {
    return error ? <div className="p-6"><Notice tone="danger">{error}</Notice></div> : <TableSkeleton />;
  }

  const running = (kind: RunKind) => runs.some((r) => r.kind === kind && r.status === "running" && !r.stale);
  const counts: Partial<Record<Tab, number>> = {
    people: event.counts.people,
    approve: event.counts.to_approve + event.counts.needs_attention,
    inbox: event.counts.waiting,
    meetings: event.counts.meetings,
  };

  return (
    <>
      <Toolbar
        icon={<TileIcon icon="calendar" color="sky" size={20} />}
        title={event.name}
        meta={
          <span className="flex items-center gap-2">
            {dateRange(event.starts_on, event.ends_on)}
            <a href={event.portal_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              Portal <ExternalLink size={14} />
            </a>
          </span>
        }
        actions={
          <>
            <RunButton kind="inbox" icon={<Inbox size={16} />} busy={starting === "inbox"} running={running("inbox")} onClick={() => start("inbox")}
              hint="Your agent reads the portal's messages and meetings and records anything new. It never replies." />
            <RunButton kind="send" icon={<Send size={16} />} busy={starting === "send"} running={running("send")} onClick={() => start("send")}
              label={event.counts.to_send ? `Send ${event.counts.to_send} approved` : "Send approved"}
              disabledReason={event.counts.to_send ? undefined : "Nothing approved to send"}
              hint="Your agent sends exactly the messages you approved, through the portal's chat." />
            <RunButton kind="shortlist" primary icon={<Search size={16} />} busy={starting === "shortlist"} running={running("shortlist")} onClick={() => start("shortlist")}
              disabledReason={event.icp.trim() ? undefined : "Say who you want to meet in Settings first"}
              hint="Your agent shortlists people worth meeting and drafts a message for each, for you to approve." />
          </>
        }
      />
      <nav className="flex h-12 items-end gap-1 overflow-x-auto border-b border-border px-4 md:px-6" aria-label="Event sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setParams(t.id === "people" ? {} : { tab: t.id })}
            aria-current={tab === t.id ? "page" : undefined}
            className={`flex h-12 shrink-0 items-center gap-1.5 border-b-2 px-2 text-sm font-medium ${
              tab === t.id ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {counts[t.id] ? <span className="data rounded-xs bg-muted px-1.5 text-xs text-muted-foreground">{counts[t.id]}</span> : null}
          </button>
        ))}
      </nav>

      <div className="space-y-3 px-4 pt-4 md:px-6 empty:hidden">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {handoff ? <Handoff {...handoff} onClose={() => setHandoff(null)} /> : null}
        <LiveRuns runs={runs} />
      </div>

      {tab === "people" && <PeopleTab event={event} version={version} />}
      {tab === "approve" && <ApproveTab event={event} version={version} onChanged={changed} />}
      {tab === "inbox" && <InboxTab event={event} version={version} onChanged={changed} />}
      {tab === "meetings" && <MeetingsTab event={event} version={version} />}
      {tab === "runs" && <RunsTab runs={runs} onChanged={changed} />}
      {tab === "settings" && <EventSettingsTab event={event} onChanged={changed} />}
    </>
  );
}

function RunButton({
  kind, icon, label, hint, primary, busy, running, disabledReason, onClick,
}: {
  kind: RunKind; icon: ReactNode; label?: string; hint: string; primary?: boolean; busy: boolean; running: boolean;
  disabledReason?: string; onClick: () => void;
}) {
  const reason = running ? "Already running" : disabledReason;
  const button = (
    <Button variant={primary ? "primary" : "secondary"} disabled={busy || Boolean(reason)} onClick={onClick} aria-label={`${label ?? RUN_LABEL[kind]}. ${reason ?? hint}`}>
      {icon} {running ? `${RUN_LABEL[kind]}…` : label ?? RUN_LABEL[kind]}
    </Button>
  );
  // A disabled button shows no tooltip, so its reason sits next to it instead.
  return reason && !running ? (
    <span className="inline-flex items-center gap-2">
      {button}
      <span className="hidden text-xs text-muted-foreground lg:inline">{reason}</span>
    </span>
  ) : (
    <Tooltip label={hint}><span className="inline-flex">{button}</span></Tooltip>
  );
}

function Handoff({ kind, brief, reason, onClose }: { kind: RunKind; brief: string; reason: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Notice
      tone="warning"
      action={
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(brief);
              setCopied(true);
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy instruction"}
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      }
    >
      <p className="font-medium">{RUN_LABEL[kind]}: hand it to your agent</p>
      <p className="mt-0.5">{reason}</p>
    </Notice>
  );
}

function LiveRuns({ runs }: { runs: Run[] }) {
  const live = runs.filter((r) => r.status === "running");
  if (!live.length) return null;
  return (
    <>
      {live.map((r) => (
        <Notice key={r.id} tone={r.stale ? "warning" : "info"} action={<Link to="?tab=runs" className="shrink-0 text-sm underline">Runs</Link>}>
          {r.stale
            ? `${RUN_LABEL[r.kind]}: no word from your agent for 20 minutes. You can start it again.`
            : !r.dispatched
              ? `${RUN_LABEL[r.kind]}: waiting for you to hand the instruction to your agent.`
              : <span className="thinking">{RUN_LABEL[r.kind]}: your agent is working{r.coverage ? ` · ${r.coverage}` : ""}</span>}
        </Notice>
      ))}
    </>
  );
}
