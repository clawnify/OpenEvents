import { SKILLS } from "./skills.gen.js";
import type { RunKind } from "./domain.js";

/** The agent accepts at most this many characters per instruction. */
export const INSTRUCTION_LIMIT = 4000;

/**
 * The instruction a run carries: the full, versioned skill for its kind plus the
 * ids it works on. One text with two audiences: what the platform delivers to the
 * agent, and what a person pastes into their agent's chat when the app cannot
 * reach it. Nothing is installed on the agent; each run brings its own procedure.
 */
export function runBrief(kind: RunKind, appUrl: string, eventId: string, runId: string): string {
  const url = new URL(appUrl);
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !local)) throw new Error("The app URL must be an HTTPS origin");
  for (const id of [eventId, runId]) if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid event or run id");
  const skill = SKILLS[kind];
  const task = JSON.stringify({ app: "OpenEvents", app_url: url.origin, event_id: eventId, run_id: runId });
  const text = `${skill.content}\nSkill: ${skill.name} v${skill.version}, sha256 ${skill.hash}\nTask data: ${task}`;
  if (text.length > INSTRUCTION_LIMIT) throw new Error(`The ${skill.name} instruction exceeds ${INSTRUCTION_LIMIT} characters.`);
  return text;
}
