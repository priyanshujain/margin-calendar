// What clicking an event gets you: a card pinned to the block you clicked, not a modal in the
// middle of the window. Clicking an event is a local gesture and the answer should arrive in the
// same place your eye already is.
//
// Everything here is read-only except the three buttons at the bottom. Attendees and the
// conference link are shown and never touched: there is no RSVP flow, no availability finder and
// no scheduling links in v1, which is a deliberate cut in docs/design.md rather than an oversight.
//
// The card is not an `.overlay`. It has no backdrop, because a backdrop would swallow the click
// that opens the next event and make switching between two blocks take two clicks instead of one.
// A click outside closes it through one capture-phase pointer listener, and the keyboard is left
// to the keymap: pushing the `overlay` frame shadows the view's keys for as long as the card is up.

import "../styles/details.css";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { eventDelete } from "../api/events";
import { useEscapeLayer } from "../escape";
import type { Attendee, Calendar, Instance, InstanceKey, Scope } from "../ipc";
import { useKeyContext } from "../keys/keymap";
import { useAccounts } from "../store/useAccounts";
import { useCalendarView } from "../store/useCalendarView";
import { notify } from "../store/useToast";
import { parseDescription } from "./EventDetailsHtml";
import { RichText, openLink } from "./RichText";
import {
  badgesOf,
  conferenceLabel,
  orderGuests,
  place,
  type Bounds,
  type Placement,
} from "./EventDetailsModel";
// The title is the grid's, so a free/busy block reads "Busy" in both places or in neither.
import { calSlot, eventTitle, keyId } from "./GridModel";
import { Icon } from "./Icon";

const CLOSE = "M18 6L6 18M6 6l12 12";
import { attendeeTally, responseLabel, whenText } from "./overlayModel";
import { Confirm } from "./overlayShell";
import { useDetails, type AnchorRect } from "./useDetails";
import { useEditor } from "./useEditor";

const CLOCK = "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2";
const PIN = "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0M15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0";
const LINK = "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2";
const TEXT = "M4 6h16M4 12h12M4 18h9";
const USERS =
  "M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M12.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75";

/** Clear of the window edges, and clear of the one row of chrome that is always resident. */
const EDGE = 8;

function viewBounds(): Bounds {
  const bar = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--titlebar-h"),
  );
  return {
    top: (Number.isFinite(bar) ? bar : 0) + EDGE,
    left: EDGE,
    right: window.innerWidth - EDGE,
    bottom: window.innerHeight - EDGE,
  };
}

/**
 * Mounted unconditionally and renders nothing until something is open. The inner card is keyed on
 * the instance, so opening a second event mounts a fresh one rather than carrying the first one's
 * half-finished delete over to it.
 */
export function EventDetails() {
  const key = useDetails((s) => s.key);
  const anchor = useDetails((s) => s.anchor);
  if (!key) return null;
  return <DetailsCard key={keyId(key)} target={key} anchor={anchor} />;
}

interface DetailsCardProps {
  target: InstanceKey;
  anchor: AnchorRect | null;
}

function DetailsCard({ target, anchor }: DetailsCardProps) {
  const close = useDetails((s) => s.close);
  const instances = useCalendarView((s) => s.instances);
  const calendars = useAccounts((s) => s.calendars);

  const card = useRef<HTMLDivElement | null>(null);
  const [spot, setSpot] = useState<Placement | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const instance = useMemo(
    () =>
      instances.find((i) => i.eventId === target.eventId && i.originalStart === target.originalStart) ??
      null,
    [instances, target],
  );

  const recurring = instance?.recurring ?? false;
  const readOnly = instance?.readOnly ?? true;

  useEscapeLayer(true, close);
  // The scope step is not a `Confirm`, so it brings its own layer. Pushed after the card's, which
  // is what makes Escape unwind the question first and the card second.
  useEscapeLayer(asking && recurring, () => setAsking(false));
  useKeyContext("overlay");

  // Measured, then placed, before the browser paints. The card also grows and shrinks as the
  // delete question replaces its body, so the observer keeps it against its block either way.
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      setSpot(place(anchor, { width: box.width, height: box.height }, viewBounds()));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [anchor]);

  // Focus has to leave the grid or the first keystroke goes to whatever the click left focused.
  // Only once it has been placed: React flushes this before the placement commit, and the frame
  // before that the card is still invisible at the origin.
  const placed = spot !== null;
  useEffect(() => {
    if (placed) card.current?.focus({ preventScroll: true });
  }, [placed]);

  // A pointer anywhere else closes it, including on the header, which the card does not cover.
  // Capture phase, so the block you clicked instead can open its own card in the same gesture.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = card.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [close]);

  // The row heights are derived from the window, so after a resize the anchor describes somewhere
  // the block no longer is. Repositioning against a stale rectangle is worse than getting out of
  // the way. Scrolling is the agenda's list, and means the same thing.
  useEffect(() => {
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [close]);

  const edit = () => {
    close();
    useEditor.getState().edit(target);
  };

  async function remove(scope: Scope) {
    setBusy(true);
    try {
      await eventDelete(target, scope);
      notify("Event deleted");
      void useCalendarView.getState().load();
      close();
    } catch (e) {
      notify(`Could not delete the event: ${e}`);
      setAsking(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="details-card"
      ref={card}
      tabIndex={-1}
      role="dialog"
      aria-label={instance ? eventTitle(instance) : "Event"}
      data-side={spot?.side}
      data-placed={spot ? "" : undefined}
      style={{
        top: `${spot?.top ?? 0}px`,
        left: `${spot?.left ?? 0}px`,
        ["--cal" as string]: instance
          ? `var(--cal-${calSlot(instance.colorHex, instance.calendarId)})`
          : "var(--line-strong)",
      }}
    >
      <button
        type="button"
        className="details-close"
        title="Close (\u238B)"
        aria-label="Close"
        onClick={() => close()}
      >
        <Icon d={CLOSE} />
      </button>
      {!instance ? (
        <Missing onClose={close} />
      ) : asking ? (
        recurring ? (
          <Scopes instance={instance} busy={busy} onPick={(s) => void remove(s)} onBack={() => setAsking(false)} />
        ) : (
          <div className="details-body">
            <Confirm
              title={`Delete ${eventTitle(instance)}?`}
              body={<p>It goes from this calendar for everyone it was shared with.</p>}
              confirmLabel="Delete"
              busy={busy}
              onConfirm={() => void remove("this")}
              onCancel={() => setAsking(false)}
            />
          </div>
        )
      ) : (
        <>
          <Body instance={instance} calendars={calendars} />
          <div className="details-foot">
            {!readOnly && (
              <>
                <button type="button" className="panel-button" onClick={edit}>
                  Edit
                </button>
                <button
                  type="button"
                  className="panel-button"
                  data-variant="danger"
                  onClick={() => setAsking(true)}
                >
                  Delete
                </button>
              </>
            )}
            <button type="button" className="panel-button" data-side="trail" onClick={close}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Missing({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="details-body">
        <p className="details-note">That event is no longer in the range you are looking at.</p>
      </div>
      <div className="details-foot">
        <button type="button" className="panel-button" data-side="trail" onClick={onClose}>
          Close
        </button>
      </div>
    </>
  );
}

const SCOPES: [Scope, string, string][] = [
  ["this", "This event", "Only the occurrence you opened."],
  ["following", "This and following", "This one and every later occurrence."],
  ["all", "All events", "The whole series, including the ones already past."],
];

/** Deleting an occurrence of a series means three different things, so the card stops and asks. */
function Scopes({
  instance,
  busy,
  onPick,
  onBack,
}: {
  instance: Instance;
  busy: boolean;
  onPick: (scope: Scope) => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="details-body">
        <p className="details-note">{eventTitle(instance)} repeats. Delete which of it?</p>
        <div className="scope-list">
          {SCOPES.map(([scope, name, note]) => (
            <button
              key={scope}
              type="button"
              className="scope-option"
              data-variant="danger"
              disabled={busy}
              onClick={() => onPick(scope)}
            >
              <span className="scope-name">{name}</span>
              <span className="scope-note">{note}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="details-foot">
        <button type="button" className="panel-button" data-side="trail" onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}

function Body({ instance, calendars }: { instance: Instance; calendars: readonly Calendar[] }) {
  const badges = badgesOf(instance);
  // Parsed, never interpolated. `EventDetailsHtml` explains why at length; the short version is
  // that this string is written by whoever put the event on the calendar.
  const description = useMemo(() => parseDescription(instance.description), [instance.description]);
  const calendar = calendars.find((c) => c.id === instance.calendarId) ?? null;
  const name = calendar?.summary || "Unknown calendar";
  const uri = instance.conference?.uri ?? null;
  const tally = attendeeTally(instance.attendees);
  const organizer = instance.organizer;

  return (
    <div className="details-body">
      <div className="details-head">
        <h2 className="details-title">{eventTitle(instance)}</h2>
        {badges.length > 0 && (
          <div className="details-badges">
            {badges.map((badge) => (
              <span className="details-badge" key={badge}>
                {badge}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="details-row">
        <Icon d={CLOCK} size={14} />
        <span className="details-text">{whenText(instance)}</span>
      </div>

      <div className="details-row">
        <span className="details-dot" />
        <span className="details-text">{name}</span>
      </div>

      {instance.location && (
        <div className="details-row">
          <Icon d={PIN} size={14} />
          <span className="details-text">{instance.location}</span>
        </div>
      )}

      {uri && (
        <div className="details-row">
          <Icon d={LINK} size={14} />
          <button type="button" className="details-link" onClick={() => openLink(uri)}>
            {conferenceLabel(instance)}
          </button>
        </div>
      )}

      {description.nodes.length > 0 && (
        <div className="details-row" data-block="">
          <Icon d={TEXT} size={14} />
          <div className="details-desc" data-plain={description.plain ? "" : undefined}>
            <RichText nodes={description.nodes} />
          </div>
        </div>
      )}

      {(tally || organizer) && (
        <div className="details-row" data-block="">
          <Icon d={USERS} size={14} />
          <div className="details-guests">
            <span className="details-text" data-soft="">
              {tally ?? `Organised by ${organizer}`}
            </span>
            {instance.attendees.length > 0 && (
              <ul className="guest-list">
                {orderGuests(instance.attendees).map((a) => (
                  <li className="guest" key={a.email} data-response={a.responseStatus}>
                    <span className="guest-dot" />
                    <span className="guest-name">{nameOf(a)}</span>
                    {a.organizer && <span className="guest-tag">organiser</span>}
                    {a.self && <span className="guest-tag">you</span>}
                    {a.optional && <span className="guest-tag">optional</span>}
                    <span className="guest-response">{responseLabel(a.responseStatus)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const nameOf = (a: Attendee): string => a.displayName || a.email;

/** The parser's vocabulary, and the only elements a description can put on screen. */

export default EventDetails;
