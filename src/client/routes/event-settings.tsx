import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, X } from "lucide-react";
import { api, type EventDetail, type EventInput } from "../api";
import { Button, Card, CardTitle, Dialog, Tooltip } from "../components/ui";
import { Field, Notice } from "../components/layout";

export function EventSettingsTab({ event, onChanged }: { event: EventDetail; onChanged: () => Promise<void> }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(() => toForm(event));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  useEffect(() => setForm(toForm(event)), [event]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(event));

  async function save(patch: EventInput = fromForm(form)) {
    setSaving(true);
    setNotice(null);
    try {
      await api.updateEvent(event.id, patch);
      await onChanged();
      setNotice({ tone: "success", text: "Saved" });
    } catch (e) {
      setNotice({ tone: "danger", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto max-w-3xl space-y-4 px-4 py-4 md:px-6">
      <Card className="space-y-4 p-4">
        <CardTitle>Event</CardTitle>
        <Field label="Name"><input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Attendee portal" hint="Your agent opens this in its own browser. Sign in there once, through the agent's live browser view.">
          <input className="input" type="url" value={form.portal_url} onChange={(e) => set("portal_url", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Starts"><input className="input" type="date" value={form.starts_on} onChange={(e) => set("starts_on", e.target.value)} /></Field>
          <Field label="Ends"><input className="input" type="date" value={form.ends_on} onChange={(e) => set("ends_on", e.target.value)} /></Field>
          <Field label="Location"><input className="input" value={form.location} onChange={(e) => set("location", e.target.value)} /></Field>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <CardTitle>Who to meet and what to say</CardTitle>
        <Field label="Who you want to meet">
          <textarea className="textarea text-sm" rows={4} value={form.icp} onChange={(e) => set("icp", e.target.value)} placeholder="Founders of agencies with 5 to 50 people…" />
        </Field>
        <Field
          label="What you offer them"
          hint={
            form.offer.trim()
              ? "Used for this event instead of your Company Knowledge."
              : event.offer_source
                ? `Empty, so your agent uses ${event.offer_source.title} v${event.offer_source.version} from Company Knowledge.`
                : "Empty, and nothing is pinned as your offering in Company Knowledge. Say it here."
          }
        >
          <textarea className="textarea text-sm" rows={4} value={form.offer} onChange={(e) => set("offer", e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Message language"><input className="input" value={form.language} onChange={(e) => set("language", e.target.value)} /></Field>
          <Field label="Longest message the portal accepts" hint="Characters. Approval waits until a message fits.">
            <input className="input data" type="number" min={80} max={5000} value={form.message_max_chars} onChange={(e) => set("message_max_chars", Number(e.target.value))} />
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <CardTitle>Limits per run</CardTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Profiles to open"><input className="input data" type="number" min={1} max={500} value={form.max_profiles} onChange={(e) => set("max_profiles", Number(e.target.value))} /></Field>
          <Field label="People to research"><input className="input data" type="number" min={1} max={100} value={form.max_research} onChange={(e) => set("max_research", Number(e.target.value))} /></Field>
          <Field label="Messages to send"><input className="input data" type="number" min={1} max={200} value={form.max_sends} onChange={(e) => set("max_sends", Number(e.target.value))} /></Field>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        <span className="flex-1" />
        <Button variant="primary" disabled={!dirty || saving} onClick={() => save()}>Save changes</Button>
      </div>

      <Card className="space-y-2 p-4">
        <CardTitle right={event.platform_notes.length}>What your agent learned about this portal</CardTitle>
        {event.platform_notes.length ? (
          <ul className="divide-y divide-border">
            {event.platform_notes.map((n, i) => (
              <li key={n + i} className="flex items-center gap-2 py-2 text-sm">
                <span className="flex-1">{n}</span>
                <Tooltip label="Remove this note">
                  <Button variant="ghost" size="icon" aria-label={`Remove note: ${n}`} onClick={() => save({ platform_notes: event.platform_notes.filter((_, j) => j !== i) })}>
                    <X size={14} />
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing yet. Quirks like a message length limit or a search that does not filter are noted here, so the next run starts knowing them.</p>
        )}
      </Card>

      <div className="flex justify-end">
        <Button variant="danger" onClick={() => setArchiveOpen(true)}><Archive size={16} /> Archive event</Button>
      </div>
      <Dialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${event.name}?`}
        description="It leaves the sidebar and no new runs can start. People, messages and meetings stay, and people contacted here are still recognised at other events."
        submitLabel="Archive"
        danger
        submitting={saving}
        onSubmit={async () => {
          await save({ archived: true });
          setArchiveOpen(false);
          navigate("/");
        }}
      />
    </section>
  );
}

function toForm(e: EventDetail) {
  return {
    name: e.name, portal_url: e.portal_url, starts_on: e.starts_on ?? "", ends_on: e.ends_on ?? "", location: e.location,
    icp: e.icp, offer: e.offer, language: e.language, message_max_chars: e.message_max_chars,
    max_profiles: e.max_profiles, max_research: e.max_research, max_sends: e.max_sends,
  };
}

function fromForm(f: ReturnType<typeof toForm>): EventInput {
  return { ...f, starts_on: f.starts_on || null, ends_on: f.ends_on || null };
}
