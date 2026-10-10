import { useCallback, useEffect, useMemo, useState } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppNav, reportLocation, useHostChanges, useHostNavigate, type AppNavItem } from "@clawnify/app/client";
import { api, type EventItem } from "./api";
import { EventsPage } from "./routes/events";
import { EventPage } from "./routes/event";
import { AttendeePage } from "./routes/attendee";
import { SettingsPage } from "./routes/settings";

/** What still needs a person at an event: drafts to approve and replies waiting. */
export const needsYou = (e: EventItem) => e.counts.to_approve + e.counts.waiting + e.counts.needs_attention;

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadEvents = useCallback(async () => {
    try {
      setEvents((await api.events()).events);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);
  useHostNavigate((path) => navigate(path));
  useHostChanges(() => void loadEvents());
  useEffect(() => reportLocation(location.pathname + location.search), [location.pathname, location.search]);

  // One navigation, drawn by the app standalone and by the dashboard when
  // embedded. Each current event is its own row, with what waits on you as its count.
  const groups = useMemo(() => {
    const top: AppNavItem[] = [
      { id: "home", label: "Events", href: "/", home: true },
      { id: "events", label: "All events", href: "/", icon: "calendar-days", color: "sky" },
      { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    ];
    const current: AppNavItem[] = events.slice(0, 8).map((e) => ({
      id: `event:${e.id}`,
      label: e.name,
      href: `/events/${e.id}`,
      icon: "calendar",
      color: "sky",
      ...(needsYou(e) ? { count: needsYou(e) } : {}),
    }));
    return current.length ? [{ items: top }, { label: "Events", items: current }] : [{ items: top }];
  }, [events]);

  const eventMatch = location.pathname.match(/^\/events\/([^/]+)/);
  const active = eventMatch ? `event:${eventMatch[1]}` : location.pathname.startsWith("/settings") ? "settings" : "events";

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <AppNav
        title="OpenEvents"
        icon="calendar-days"
        groups={groups}
        active={active}
        onNavigate={(item) => item.href && navigate(item.href)}
      />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<EventsPage events={events} loaded={loaded} onChanged={loadEvents} />} />
          <Route path="/events/:id" element={<EventPage onChanged={loadEvents} />} />
          <Route path="/events/:eventId/people/:id" element={<AttendeePage onChanged={loadEvents} />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
