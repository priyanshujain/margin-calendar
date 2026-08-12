// A dev-only dataset that reproduces what a real Google account actually returns, because the
// bugs that shipped were all in cases a hand-made three-event fixture does not contain.
//
// Modelled on a real sync of 12,067 events: 90% of them came from a calendar the user only has
// freeBusyReader access to, so Google returns them with no summary at all. That single fact is
// what made the grid look like a wall of "Untitled".
//
// Anchored to the current week at call time, so `pnpm dev` always has something on screen.

import { EVENT_COLORS, type Account, type Calendar, type Instance } from "../ipc";

const DAY = 86_400_000;

export const devAccounts: Account[] = [
  { id: "acct-1", email: "you@example.com", connected: true },
  { id: "acct-2", email: "work@example.com", connected: true },
];

export const devCalendars: Calendar[] = [
  {
    id: "cal-personal",
    accountId: "acct-1",
    summary: "you@example.com",
    description: null,
    colorHex: "#6f6194",
    selected: true,
    accessRole: "owner",
    timeZone: "Asia/Kolkata",
    primary: true,
  },
  {
    id: "cal-work",
    accountId: "acct-2",
    summary: "work@example.com",
    description: "Free/busy only",
    colorHex: "#4e6484",
    selected: true,
    // The one that matters: no summaries come back for this calendar at all.
    accessRole: "freeBusyReader",
    timeZone: "Asia/Kolkata",
    primary: false,
  },
  {
    id: "cal-meetup",
    accountId: "acct-1",
    summary: "Antithesis x Bengaluru Systems Meetup",
    description: null,
    colorHex: "#47705f",
    selected: true,
    accessRole: "reader",
    timeZone: "Asia/Kolkata",
    primary: false,
  },
];

function startOfDayLocal(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function at(day: number, hour: number, minute = 0): number {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function iso(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function dateOnly(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

interface Seed {
  cal: string;
  summary: string;
  day: number;
  from: [number, number];
  minutes: number;
  location?: string;
  description?: string;
  status?: Instance["status"];
  colorId?: string;
  attendees?: number;
  conference?: boolean;
  recurring?: boolean;
  pending?: boolean;
}

function timed(seed: Seed, index: number): Instance {
  const calendar = devCalendars.find((c) => c.id === seed.cal)!;
  const start = at(seed.day, seed.from[0], seed.from[1]);
  const end = start + seed.minutes * 60_000;
  return {
    eventId: `ev-${index}`,
    calendarId: calendar.id,
    accountId: calendar.accountId,
    originalStart: seed.recurring ? iso(start) : null,
    start: iso(start),
    end: iso(end),
    startMs: start,
    endMs: end,
    allDay: false,
    summary: seed.summary,
    description: seed.description ?? null,
    location: seed.location ?? null,
    status: seed.status ?? "confirmed",
    recurring: seed.recurring ?? false,
    // An event colour overrides its calendar's, which is what Google does.
    colorHex: EVENT_COLORS.find((c) => c.id === seed.colorId)?.hex ?? calendar.colorHex,
    colorId: seed.colorId ?? null,
    etag: `"etag-${index}"`,
    organizer: seed.attendees ? "someone@example.com" : null,
    attendees: Array.from({ length: seed.attendees ?? 0 }, (_, i) => ({
      email: `person${i + 1}@example.com`,
      displayName: ["Sam Patel", "Riya Shah", "Dev Kumar", "Ana Rao", "Jo Mehta"][i % 5],
      // Index 1 is "you". Keep it accepted: making yourself the declined one struck through
      // every multi-attendee block and made a normal week look abandoned.
      responseStatus:
        i === 1 ? "accepted" : (["accepted", "tentative", "needsAction", "declined"] as const)[i % 4],
      organizer: i === 0,
      self: i === 1,
      optional: i === 3,
    })),
    conference: seed.conference
      ? { kind: "hangoutsMeet", uri: "https://meet.google.com/abc-defg-hij", label: "meet.google.com/abc-defg-hij" }
      : null,
    readOnly: calendar.accessRole !== "owner" && calendar.accessRole !== "writer",
    pending: seed.pending ?? false,
  };
}

function allDay(cal: string, summary: string, day: number, days: number, index: number): Instance {
  const calendar = devCalendars.find((c) => c.id === cal)!;
  const start = startOfDayLocal(day);
  const end = start + days * DAY;
  return {
    eventId: `ad-${index}`,
    calendarId: calendar.id,
    accountId: calendar.accountId,
    originalStart: null,
    start: dateOnly(start),
    end: dateOnly(end),
    startMs: start,
    endMs: end,
    allDay: true,
    summary,
    description: null,
    location: null,
    status: "confirmed",
    recurring: false,
    colorHex: calendar.colorHex,
    colorId: null,
    etag: `"etag-ad-${index}"`,
    organizer: null,
    attendees: [],
    conference: null,
    readOnly: calendar.accessRole !== "owner" && calendar.accessRole !== "writer",
    pending: false,
  };
}

/** Every instance overlapping [from, to). Generated per call so "today" is always populated. */
export function devInstances(from: number, to: number): Instance[] {
  const week = startOfDayLocal(Date.now());
  const out: Instance[] = [];
  let n = 0;

  for (let offset = -21; offset <= 28; offset += 1) {
    const day = startOfDayLocal(week + offset * DAY);
    const weekday = new Date(day).getDay();
    const workday = weekday !== 0 && weekday !== 6;

    // The daily recurring habit, which is what a real calendar is mostly made of.
    out.push(timed({ cal: "cal-personal", summary: "Solve 2 DSA questions", day, from: [9, 0], minutes: 30, recurring: true }, n++));
    out.push(timed({ cal: "cal-personal", summary: "Apply to 1 job", day, from: [18, 0], minutes: 30, recurring: true }, n++));

    if (!workday) continue;

    // Free/busy blocks: no summary at all, which is what freeBusyReader access returns.
    out.push(timed({ cal: "cal-work", summary: "", day, from: [10, 0], minutes: 60 }, n++));
    out.push(timed({ cal: "cal-work", summary: "", day, from: [14, 30], minutes: 90 }, n++));
    out.push(timed({ cal: "cal-work", summary: "", day, from: [16, 0], minutes: 15 }, n++));

    // Short events, the ones that collapse into an unreadable sliver.
    out.push(timed({ cal: "cal-personal", summary: "Stand-up", day, from: [9, 45], minutes: 10, attendees: 5, conference: true }, n++));
    out.push(timed({ cal: "cal-personal", summary: "Meds", day, from: [8, 15], minutes: 5 }, n++));

    if (offset % 3 === 0) {
      // An overlapping cluster three deep, plus a briefly-colliding long one.
      out.push(timed({ cal: "cal-personal", summary: "Design review with the platform team", day, from: [11, 0], minutes: 60, attendees: 4, conference: true, location: "Meeting room 3", colorId: "11" }, n++));
      out.push(timed({ cal: "cal-personal", summary: "1:1 with Sam", day, from: [11, 15], minutes: 30, attendees: 2, colorId: "5" }, n++));
      out.push(timed({ cal: "cal-meetup", summary: "Antithesis x Bengaluru Systems Meetup: deterministic simulation testing in practice", day, from: [11, 30], minutes: 150, location: "Church Street, Bengaluru" }, n++));
    }
    if (offset % 5 === 0) {
      out.push(timed({ cal: "cal-personal", summary: "Tentative: coffee", day, from: [15, 0], minutes: 45, status: "tentative" }, n++));
    }
    if (offset === 1) {
      out.push(timed({ cal: "cal-personal", summary: "Just created, not pushed yet", day, from: [13, 0], minutes: 30, pending: true }, n++));
    }
  }

  out.push(allDay("cal-personal", "Trip to Goa", week + DAY, 4, 0));
  out.push(allDay("cal-personal", "Credit Card Bill ICICI", week + 2 * DAY, 1, 1));
  out.push(allDay("cal-meetup", "Conference", week + 2 * DAY, 1, 2));
  out.push(allDay("cal-personal", "Dentist", week + 2 * DAY, 1, 3));

  const selected = new Set(devCalendars.filter((c) => c.selected).map((c) => c.id));
  return out.filter((i) => selected.has(i.calendarId) && i.endMs > from && i.startMs < to);
}
