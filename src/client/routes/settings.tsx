import { useEffect, useState } from "react";
import { TileIcon } from "@clawnify/app/client";
import { api, type AgentServer } from "../api";
import { Button, Card, CardTitle, Picker } from "../components/ui";
import { Notice, Toolbar } from "../components/layout";

export function SettingsPage() {
  const [state, setState] = useState<{ available: boolean; servers: AgentServer[]; selected: string | null } | null>(null);
  const [choice, setChoice] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  useEffect(() => {
    api.agents().then(
      (s) => {
        setState(s);
        setChoice(s.selected ?? "");
      },
      (e) => setNotice({ tone: "danger", text: (e as Error).message }),
    );
  }, []);

  return (
    <>
      <Toolbar icon={<TileIcon icon="settings" size={20} />} title="Settings" />
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        <Card className="space-y-3 p-4">
          <CardTitle>Agent</CardTitle>
          <p className="text-sm text-muted-foreground">
            The agent that works the event portals. It uses its own browser, so sign in to each portal there once.
          </p>
          {!state ? (
            <div className="h-8 animate-pulse rounded-sm bg-muted" />
          ) : !state.available ? (
            <Notice tone="info">
              This copy of the app is not connected to Clawnify, so each run gives you an instruction to paste into your agent's chat.
            </Notice>
          ) : (
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Picker
                  label="Agent"
                  value={choice}
                  placeholder={state.servers.length === 1 ? "Your only agent" : "Choose an agent"}
                  options={state.servers.map((s) => ({ value: s.id, label: s.name ?? "Unnamed agent", hint: s.status ?? undefined }))}
                  onChange={setChoice}
                  empty="No agents in this workspace yet"
                />
              </div>
              <Button
                variant="primary"
                disabled={choice === (state.selected ?? "")}
                onClick={async () => {
                  try {
                    await api.saveAgent(choice || null);
                    setState({ ...state, selected: choice || null });
                    setNotice({ tone: "success", text: "Saved" });
                  } catch (e) {
                    setNotice({ tone: "danger", text: (e as Error).message });
                  }
                }}
              >
                Save
              </Button>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
