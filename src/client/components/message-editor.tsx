import { useEffect, useState } from "react";
import { Check, RotateCcw, Trash2 } from "lucide-react";
import { api, type Message } from "../api";
import { Button, Tooltip } from "./ui";
import { MessageBadge } from "./status";

/**
 * A message on its way out, edited in place. The text is the control: change it
 * and approve, and what you approved is exactly what the agent sends. Over the
 * portal's limit the counter turns red and approval waits until it fits.
 */
export function MessageEditor({
  message,
  maxChars,
  onChange,
  onError,
}: {
  message: Message;
  maxChars: number;
  onChange: (m: Message) => void;
  onError: (text: string) => void;
}) {
  const [text, setText] = useState(message.body);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(message.body), [message.id, message.body]);

  const editable = ["draft", "approved", "held", "failed"].includes(message.status);
  const over = text.trim().length > maxChars;
  const changed = text.trim() !== message.body;

  async function act(patch: Parameters<typeof api.updateMessage>[1]) {
    setBusy(true);
    try {
      onChange(await api.updateMessage(message.id, patch));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!editable) {
    return <p className="whitespace-pre-wrap text-sm">{message.body}</p>;
  }

  return (
    <div className="space-y-2">
      <textarea
        className="textarea text-sm"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Message text"
        rows={4}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className={`data text-xs ${over ? "text-destructive" : "text-muted-foreground"}`}>
          {text.trim().length} / {maxChars}
        </span>
        <MessageBadge status={message.status} />
        {message.error ? <span className="text-xs text-destructive">{message.error}</span> : null}
        <span className="flex-1" />
        <Tooltip label="Discard this message">
          <Button variant="ghost" size="icon" aria-label="Discard this message" disabled={busy} onClick={() => act({ status: "discarded" })}>
            <Trash2 size={16} />
          </Button>
        </Tooltip>
        {message.status === "approved" && !changed ? (
          <Button variant="ghost" disabled={busy} onClick={() => act({ status: "draft" })}>
            <RotateCcw size={16} /> Back to draft
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy || over || !text.trim()}
            onClick={() => act(changed ? { body: text, status: "approved" } : { status: "approved" })}
          >
            <Check size={16} /> {message.status === "approved" ? "Save" : "Approve"}
          </Button>
        )}
      </div>
    </div>
  );
}
