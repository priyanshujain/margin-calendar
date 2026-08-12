// One event, created or edited. Summary, calendar, when, where and the description are writable;
// attendees and the conference link are not, deliberately, because v1 has no RSVP flow and no
// scheduling anything.
//
// The one genuinely subtle thing here is scope. Saving or deleting an occurrence of a recurring
// series does something different to the server depending on whether you meant this one, this one
// and everything after it, or the whole series, so the panel stops and asks. There is no default,
// because a default is exactly what gets missed.

import { useMemo, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { eventCreate, eventDelete, eventUpdate } from "../api/events";
import { useEscapeLayer } from "../escape";
import type { Calendar, EventDraft, EventPatch, Instance, InstanceKey, Scope } from "../ipc";
import { useAccounts } from "../store/useAccounts";
import { useCalendarView } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { notify } from "../store/useToast";
import { parseDateOnly, toDateOnly, toOffsetIso } from "../time";
import "../styles/create.css";
import { ColorPicker } from "./ColorPicker";
import { parseDescription } from "./EventDetailsHtml";
import { Icon } from "./Icon";
import { RichText } from "./RichText";
import {
  allDayEndInput,
  allDayEndWire,
  attendeeTally,
  canWrite,
  defaultRange,
  fromDateTime,
  responseLabel,
  toTimeOnly,
  whenText,
} from "./overlayModel";
import { Confirm, Sheet } from "./overlayShell";
import { calSlot, eventTitle } from "./GridModel";
import { useEditor, type EditorSeed, type EditorTarget } from "./useEditor";

const FORM_ID = "event-editor-form";

const LINK = "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2";
const REPEAT = "M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3";
const LOCK = "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4";

interface Form {
  summary: string;
  calendarId: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
  /** Google's per-event colour id. Empty means the event takes its calendar's colour. */
  colorId: string;
}

interface Times {
  startMs: number;
  endMs: number;
  start: string;
  end: string;
  valid: boolean;
}

function formFor(instance: Instance | null, seed: EditorSeed, anchor: number, fallback: string): Form {
  if (instance) {
    return {
      summary: instance.summary,
      calendarId: instance.calendarId,
      allDay: instance.allDay,
      startDate: toDateOnly(instance.startMs),
      startTime: toTimeOnly(instance.startMs),
      endDate: instance.allDay ? allDayEndInput(instance.endMs) : toDateOnly(instance.endMs),
      endTime: toTimeOnly(instance.endMs),
      location: instance.location ?? "",
      description: instance.description ?? "",
      colorId: instance.colorId ?? "",
    };
  }
  const range = defaultRange(anchor);
  const startMs = seed.startMs ?? range.startMs;
  const endMs = seed.endMs ?? startMs + (range.endMs - range.startMs);
  const allDay = seed.allDay ?? false;
  return {
    summary: seed.summary ?? "",
    calendarId: seed.calendarId ?? fallback,
    allDay,
    startDate: toDateOnly(startMs),
    startTime: toTimeOnly(startMs),
    endDate: allDay ? allDayEndInput(endMs) : toDateOnly(endMs),
    endTime: toTimeOnly(endMs),
    location: seed.location ?? "",
    description: seed.description ?? "",
    colorId: seed.colorId ?? "",
  };
}

/** What the form means in wire terms, and whether it means anything at all. */
function timesOf(form: Form): Times {
  if (form.allDay) {
    const startMs = parseDateOnly(form.startDate);
    const endMs = parseDateOnly(form.endDate);
    const valid = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs;
    return { startMs, endMs, start: form.startDate, end: valid ? allDayEndWire(form.endDate) : "", valid };
  }
  const startMs = fromDateTime(form.startDate, form.startTime);
  const endMs = fromDateTime(form.endDate, form.endTime);
  const valid = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs;
  return {
    startMs,
    endMs,
    start: valid ? toOffsetIso(startMs) : "",
    end: valid ? toOffsetIso(endMs) : "",
    valid,
  };
}

/** Only what moved. An absent field means unchanged; an empty string clears the two that allow it. */
function patchOf(form: Form, times: Times, instance: Instance): EventPatch {
  const patch: EventPatch = {};
  if (form.summary !== instance.summary) patch.summary = form.summary;
  if (form.location !== (instance.location ?? "")) patch.location = form.location;
  if (form.description !== (instance.description ?? "")) patch.description = form.description;
  if (form.calendarId !== instance.calendarId) patch.calendarId = form.calendarId;
  // The empty string is meaningful here: it is how the event is put back on its calendar's colour.
  if (form.colorId !== (instance.colorId ?? "")) patch.colorId = form.colorId;

  // The panel holds the inclusive last day of an all-day event, so compare like with like.
  const wasEnd = instance.allDay ? parseDateOnly(allDayEndInput(instance.endMs)) : instance.endMs;
  if (form.allDay !== instance.allDay || times.startMs !== instance.startMs || times.endMs !== wasEnd) {
    patch.allDay = form.allDay;
    patch.start = times.start;
    patch.end = times.end;
  }
  return patch;
}

const targetId = (target: EditorTarget): string =>
  target.mode === "create" ? "create" : `edit ${target.key.eventId} ${target.key.originalStart ?? ""}`;

export interface EventEditorProps {
  /** Where a new event lands when nothing seeded a calendar. */
  defaultCalendarId?: string;
}

/**
 * Nothing is resident: the panel below only exists while the overlay is open, which is what keeps
 * its form state from surviving into the next event you open.
 */
export function EventEditor({ defaultCalendarId }: EventEditorProps) {
  const open = useOverlays((s) => s.open);
  const target = useEditor((s) => s.target);
  if (open !== "editor") return null;
  const resolved: EditorTarget = target ?? { mode: "create", seed: {} };
  return (
    <EditorPanel
      key={targetId(resolved)}
      target={resolved}
      defaultCalendarId={defaultCalendarId}
    />
  );
}

interface EditorPanelProps {
  target: EditorTarget;
  defaultCalendarId?: string;
}

function EditorPanel({ target, defaultCalendarId }: EditorPanelProps) {
  const dismiss = useEditor((s) => s.close);
  const calendars = useAccounts((s) => s.calendars);
  const instances = useCalendarView((s) => s.instances);
  const anchor = useCalendarView((s) => s.anchor);

  const key: InstanceKey | null = target.mode === "edit" ? target.key : null;

  const instance = useMemo(
    () =>
      key
        ? (instances.find((i) => i.eventId === key.eventId && i.originalStart === key.originalStart) ?? null)
        : null,
    [instances, key],
  );

  const writable = useMemo(
    () => calendars.filter((c) => canWrite(c.accessRole) || c.id === instance?.calendarId),
    [calendars, instance],
  );

  const fallback = defaultCalendarId ?? writable.find((c) => c.primary)?.id ?? writable[0]?.id ?? "";

  const [form, setForm] = useState<Form>(() =>
    formFor(instance, target.mode === "create" ? target.seed : {}, anchor, fallback),
  );
  const [ask, setAsk] = useState<{ action: "save" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);

  // The swatch for "same as calendar" previews the calendar it would follow, drawn in the slot
  // that calendar's dot is drawn in everywhere else rather than in the hex Google stores.
  const chosen = calendars.find((c) => c.id === form.calendarId) ?? null;
  const calendarColor = chosen
    ? `var(--cal-${calSlot(chosen.colorHex, chosen.id)})`
    : "var(--line-strong)";

  const recurring = instance?.recurring ?? false;
  const readOnly = instance?.readOnly ?? false;
  const times = timesOf(form);
  const scopeStep = ask !== null && recurring;

  useEscapeLayer(scopeStep, () => setAsk(null));

  const set = <K extends keyof Form>(field: K, value: Form[K]) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const close = () => {
    setAsk(null);
    dismiss();
  };

  async function run(action: "save" | "delete", scope: Scope) {
    setBusy(true);
    try {
      if (action === "delete") {
        if (!key) {
          close();
          return;
        }
        await eventDelete(key, scope);
        notify("Event deleted");
      } else if (key && instance) {
        const patch = patchOf(form, times, instance);
        if (Object.keys(patch).length > 0) await eventUpdate(key, patch, scope);
      } else {
        const draft: EventDraft = {
          calendarId: form.calendarId,
          summary: form.summary.trim() || "Untitled",
          description: form.description || null,
          location: form.location || null,
          start: times.start,
          end: times.end,
          allDay: form.allDay,
          // Absent rather than empty when it follows the calendar, which is what the wire reads
          // as no override.
          ...(form.colorId ? { colorId: form.colorId } : {}),
        };
        await eventCreate(draft);
      }
      void useCalendarView.getState().load();
      close();
    } catch (e) {
      notify(action === "delete" ? `Could not delete the event: ${e}` : `Could not save the event: ${e}`);
      setAsk(null);
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!times.valid || !form.calendarId || busy) return;
    if (recurring) setAsk({ action: "save" });
    else void run("save", "this");
  };

  if (scopeStep && ask) {
    const action = ask.action;
    return (
      <Sheet
        open
        title={action === "delete" ? "Delete which?" : "Save which?"}
        size="wide"
        onClose={close}
        foot={
          <button type="button" className="panel-button" onClick={() => setAsk(null)}>
            Back
          </button>
        }
      >
        <p className="panel-note">
          {instance?.summary || "This event"} repeats. Choose what this{" "}
          {action === "delete" ? "deletion" : "change"} applies to.
        </p>
        <div className="scope-list">
          {SCOPES.map(([scope, name, note]) => (
            <button
              key={scope}
              type="button"
              className="scope-option"
              data-variant={action === "delete" ? "danger" : undefined}
              disabled={busy}
              onClick={() => void run(action, scope)}
            >
              <span className="scope-name">{name}</span>
              <span className="scope-note">{note}</span>
            </button>
          ))}
        </div>
      </Sheet>
    );
  }

  if (ask) {
    return (
      <Sheet open title="Delete event" onClose={close}>
        <Confirm
          title={`Delete ${instance?.summary || "this event"}?`}
          body={<p>It goes from this calendar for everyone it was shared with.</p>}
          confirmLabel="Delete"
          busy={busy}
          onConfirm={() => void run("delete", "this")}
          onCancel={() => setAsk(null)}
        />
      </Sheet>
    );
  }

  if (target.mode === "edit" && !instance) {
    return (
      <Sheet
        open
        title="Event"
        onClose={close}
        foot={
          <button type="button" className="panel-button" data-autofocus="" onClick={close}>
            Close
          </button>
        }
      >
        <p className="panel-note">That event is no longer in the range you are looking at.</p>
      </Sheet>
    );
  }

  if (readOnly && instance) {
    return (
      <Sheet
        open
        title="Event"
        size="wide"
        onClose={close}
        foot={
          <button type="button" className="panel-button" data-autofocus="" onClick={close}>
            Close
          </button>
        }
      >
        <ReadOnlyEvent instance={instance} calendars={calendars} />
      </Sheet>
    );
  }

  return (
    <Sheet
      open
      title={target.mode === "create" ? "New event" : "Edit event"}
      size="wide"
      onClose={close}
      foot={
        <>
          {target.mode === "edit" && (
            <button
              type="button"
              className="panel-button"
              data-variant="danger"
              data-side="lead"
              disabled={busy}
              onClick={() => setAsk({ action: "delete" })}
            >
              Delete
            </button>
          )}
          <button type="button" className="panel-button" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            form={FORM_ID}
            className="panel-button"
            data-variant="primary"
            disabled={busy || !times.valid || !form.calendarId}
          >
            {target.mode === "create" ? "Create" : "Save"}
          </button>
        </>
      }
    >
      <form id={FORM_ID} className="editor" onSubmit={onSubmit} onKeyDown={(e) => e.stopPropagation()}>
        <label className="field">
          <span className="field-label">Summary</span>
          <input
            className="field-input"
            value={form.summary}
            placeholder="Untitled"
            data-autofocus=""
            onChange={(e) => set("summary", e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Calendar</span>
          <select
            className="field-select"
            value={form.calendarId}
            onChange={(e) => set("calendarId", e.target.value)}
          >
            {writable.length === 0 && <option value="">Nothing you can write to</option>}
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.summary || "Untitled"}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span className="field-label">Colour</span>
          <ColorPicker
            value={form.colorId || null}
            onChange={(colorId) => set("colorId", colorId ?? "")}
            calendarColor={calendarColor}
          />
        </div>

        <div className="field">
          <span className="field-label">When</span>
          <div className="field-row">
            <input
              type="date"
              className="field-input"
              value={form.startDate}
              onChange={(e) => set("startDate", e.target.value)}
            />
            {!form.allDay && (
              <input
                type="time"
                className="field-input"
                value={form.startTime}
                onChange={(e) => set("startTime", e.target.value)}
              />
            )}
            <span className="field-to">to</span>
            <input
              type="date"
              className="field-input"
              value={form.endDate}
              onChange={(e) => set("endDate", e.target.value)}
            />
            {!form.allDay && (
              <input
                type="time"
                className="field-input"
                value={form.endTime}
                onChange={(e) => set("endTime", e.target.value)}
              />
            )}
          </div>
          <label className="field-check">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => set("allDay", e.target.checked)}
            />
            All day
          </label>
          {!times.valid && (
            <span className="field-hint" data-error="">
              That ends before it starts.
            </span>
          )}
          {recurring && (
            <span className="field-hint">
              <Icon d={REPEAT} size={13} />
              Repeats, so saving will ask what the change applies to.
            </span>
          )}
        </div>

        <label className="field">
          <span className="field-label">Location</span>
          <input
            className="field-input"
            value={form.location}
            placeholder="Somewhere"
            onChange={(e) => set("location", e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Description</span>
          <textarea
            className="field-textarea"
            rows={3}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>

        {instance && <Guests instance={instance} />}
      </form>
    </Sheet>
  );
}

const SCOPES: [Scope, string, string][] = [
  ["this", "This event", "Only the occurrence you opened."],
  ["following", "This and following", "This one and every later occurrence. Earlier ones keep what they had."],
  ["all", "All events", "The whole series, including the occurrences already past."],
];

const nameOf = (calendars: readonly Calendar[], id: string): string =>
  calendars.find((c) => c.id === id)?.summary || "Unknown calendar";

/** Read-only on purpose: no RSVP, no availability finder and no scheduling links in v1. */
function Guests({ instance }: { instance: Instance }) {
  const tally = attendeeTally(instance.attendees);
  const uri = instance.conference?.uri ?? null;
  const label = instance.conference?.label || instance.conference?.kind || "Join";
  if (!tally && !uri) return null;
  return (
    <>
      {uri && (
        <div className="field">
          <span className="field-label">Conference</span>
          <button
            type="button"
            className="panel-button"
            data-variant="ghost"
            data-align="lead"
            onClick={() => openUrl(uri).catch(() => {})}
          >
            <Icon d={LINK} size={14} />
            {label}
          </button>
        </div>
      )}
      {tally && (
        <div className="field">
          <span className="field-label">Attendees</span>
          <span className="field-hint">{tally}</span>
          <ul className="guest-list">
            {instance.attendees.map((a) => (
              <li className="guest" key={a.email} data-response={a.responseStatus}>
                <span className="guest-dot" />
                <span className="guest-name">{a.displayName || a.email}</span>
                {a.organizer && <span className="guest-tag">organiser</span>}
                {a.optional && <span className="guest-tag">optional</span>}
                <span className="guest-response">{responseLabel(a.responseStatus)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ReadOnlyEvent({ instance, calendars }: { instance: Instance; calendars: readonly Calendar[] }) {
  // Google's description field is HTML, so printing it as text shows the reader the markup. The
  // editable path below keeps the raw string in its textarea on purpose: rendering it there and
  // patching it back would rewrite formatting nobody touched.
  const description = useMemo(() => parseDescription(instance.description), [instance.description]);
  return (
    <>
      <p className="panel-note" data-icon="">
        <Icon d={LOCK} size={13} />
        This calendar is read only, so nothing here can be changed.
      </p>
      <div className="field">
        <span className="field-label">Summary</span>
        <span className="field-static">{eventTitle(instance)}</span>
      </div>
      <div className="field">
        <span className="field-label">When</span>
        <span className="field-static">{whenText(instance)}</span>
      </div>
      <div className="field">
        <span className="field-label">Calendar</span>
        <span className="field-static">{nameOf(calendars, instance.calendarId)}</span>
      </div>
      {instance.location && (
        <div className="field">
          <span className="field-label">Location</span>
          <span className="field-static">{instance.location}</span>
        </div>
      )}
      {description.nodes.length > 0 && (
        <div className="field">
          <span className="field-label">Description</span>
          <div className="rich" data-plain={description.plain ? "" : undefined}>
            <RichText nodes={description.nodes} />
          </div>
        </div>
      )}
      <Guests instance={instance} />
    </>
  );
}

export default EventEditor;
