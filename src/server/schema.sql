-- OpenEvents. One database per installed app, so there is no tenant column.

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT,                          -- the agent that works the portals
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  portal_url TEXT NOT NULL,
  starts_on TEXT,                          -- YYYY-MM-DD
  ends_on TEXT,
  location TEXT NOT NULL DEFAULT '',
  icp TEXT NOT NULL DEFAULT '',            -- who to look for
  offer TEXT NOT NULL DEFAULT '',          -- empty: the org's pinned Company Knowledge offering
  language TEXT NOT NULL DEFAULT 'English',
  message_max_chars INTEGER NOT NULL DEFAULT 400,
  max_profiles INTEGER NOT NULL DEFAULT 60,
  max_research INTEGER NOT NULL DEFAULT 15,
  max_sends INTEGER NOT NULL DEFAULT 20,
  platform_notes TEXT NOT NULL DEFAULT '[]', -- JSON array of strings the agent learned about the portal
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A person across events, so nobody is contacted twice from two events.
-- One person can be sighted under several keys (a LinkedIn URL at one event, only
-- a name and domain at the next), so every key seen points at the same person.
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS person_keys (
  key TEXT PRIMARY KEY,                    -- li:<profile path> | nd:<name>|<domain> | portal:<url> | ne:<name>|<event id>
  person_id TEXT NOT NULL REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  kind TEXT NOT NULL CHECK (kind IN ('shortlist', 'send', 'inbox')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'blocked')),
  coverage TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  skill_version TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  dispatched INTEGER NOT NULL DEFAULT 0,   -- 0: handed over by hand (no platform), or not yet
  heartbeat_at TEXT,
  finished_at TEXT,
  stopped_by_name TEXT,                    -- the person who pressed Stop; null when the run ended itself
  stopped_by_avatar TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS runs_event ON runs(event_id, created_at);

CREATE TABLE IF NOT EXISTS attendees (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  person_id TEXT NOT NULL REFERENCES people(id),
  run_id TEXT,
  source TEXT NOT NULL DEFAULT 'shortlist' CHECK (source IN ('shortlist', 'inbound')),
  name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  portal_profile_url TEXT NOT NULL DEFAULT '',
  linkedin_url TEXT NOT NULL DEFAULT '',
  fit TEXT CHECK (fit IN ('strong', 'maybe', 'no')),
  why_fit TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '[]',     -- JSON [{url, quote}]
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'replied', 'meeting', 'skipped', 'declined')),
  inbox_cleared_at TEXT,                   -- the user dealt with everything before this
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, person_id)
);
CREATE INDEX IF NOT EXISTS attendees_event ON attendees(event_id, status);
CREATE INDEX IF NOT EXISTS attendees_person ON attendees(person_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  direction TEXT NOT NULL CHECK (direction IN ('out', 'in')),
  body TEXT NOT NULL,
  -- out: draft -> approved -> sent | failed | held, or discarded. in: received.
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'sent', 'failed', 'held', 'discarded', 'received')),
  error TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'agent' CHECK (author IN ('agent', 'user', 'them')),
  approved_by TEXT,
  approved_at TEXT,
  sent_at TEXT,
  received_at TEXT,
  thread_url TEXT NOT NULL DEFAULT '',
  fingerprint TEXT UNIQUE,                 -- inbound only: drops the same message seen twice
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_event ON messages(event_id, status);
CREATE INDEX IF NOT EXISTS messages_attendee ON messages(attendee_id, created_at);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  starts_at TEXT,
  location TEXT NOT NULL DEFAULT '',
  portal_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (attendee_id, starts_at)
);
