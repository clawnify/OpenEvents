// One place that says what each state is called and how loud it is: badges for
// states that want attention, chips for plain facts.

import type { AttendeeStatus, Fit, MessageStatus, Run } from "../api";
import { Badge, Chip, type Tone } from "./ui";

const FIT: Record<Fit, { label: string; tone: Tone }> = {
  strong: { label: "Strong fit", tone: "success" },
  maybe: { label: "Maybe", tone: "warning" },
  no: { label: "Not a fit", tone: "neutral" },
};

export function FitBadge({ fit }: { fit: Fit | null }) {
  if (!fit) return <Chip>Wrote to you</Chip>;
  return fit === "no" ? <Chip>{FIT.no.label}</Chip> : <Badge tone={FIT[fit].tone}>{FIT[fit].label}</Badge>;
}

const ATTENDEE: Record<AttendeeStatus, string> = {
  new: "Not contacted",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting booked",
  skipped: "Skipped",
  declined: "Declined",
};

export function AttendeeStatusLabel({ status }: { status: AttendeeStatus }) {
  if (status === "replied") return <Badge tone="info">{ATTENDEE.replied}</Badge>;
  if (status === "meeting") return <Badge tone="success">{ATTENDEE.meeting}</Badge>;
  return <Chip>{ATTENDEE[status]}</Chip>;
}

export const attendeeStatusLabel = (s: AttendeeStatus) => ATTENDEE[s];

const MESSAGE: Record<MessageStatus, { label: string; tone: Tone }> = {
  draft: { label: "Needs approval", tone: "warning" },
  approved: { label: "Approved, not sent yet", tone: "info" },
  sent: { label: "Sent", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  held: { label: "Held back", tone: "warning" },
  discarded: { label: "Discarded", tone: "neutral" },
  received: { label: "Received", tone: "info" },
};

export function MessageBadge({ status }: { status: MessageStatus }) {
  return <Badge tone={MESSAGE[status].tone}>{MESSAGE[status].label}</Badge>;
}

export const RUN_LABEL = { shortlist: "Find people", send: "Send approved", inbox: "Check inbox" } as const;

export function RunBadge({ run }: { run: Run }) {
  if (run.status === "running") {
    if (run.stale) return <Badge tone="warning">Stalled</Badge>;
    if (!run.dispatched) return <Badge tone="warning">Waiting for hand-over</Badge>;
    return <Badge tone="info">Running</Badge>;
  }
  if (run.status === "done") return <Badge tone="success">Done</Badge>;
  if (run.status === "blocked") return <Badge tone="warning">Blocked</Badge>;
  return <Badge tone="danger">Failed</Badge>;
}

export function formatDate(d: string | null): string {
  if (!d) return "";
  const date = new Date(d.length === 10 ? `${d}T00:00:00` : d.replace(" ", "T") + (d.includes("T") || d.endsWith("Z") ? "" : "Z"));
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(d: string | null): string {
  if (!d) return "";
  const date = new Date(d.includes("T") ? d : d.replace(" ", "T") + "Z");
  if (Number.isNaN(date.getTime())) return d;
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "3h ago" for the database's UTC timestamps. */
export function ago(d: string | null): string {
  if (!d) return "";
  const date = new Date(d.includes("T") ? d : d.replace(" ", "T") + "Z");
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dateRange(start: string | null, end: string | null): string {
  if (!start) return "";
  if (!end || end === start) return formatDate(start);
  return `${formatDate(start)} to ${formatDate(end)}`;
}
