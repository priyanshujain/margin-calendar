// The quick create card: everything a dragged range needs to become an event, and a door out to
// the full editor for everything else.
//
// The title field is the palette's parser, imported rather than copied, so `standup at cafe #work`
// means here exactly what it means behind Cmd-K. When the text says a time it wins over the drag
// and the fields follow it, because the text is the more recent thing the user said. When it says
// nothing about time the drag still holds, which is the common case and must stay silent.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import { eventCreate } from "../api/events";
import { PRIMARY_LABEL, primaryHeld } from "../keys/bindings";
import {
  defaultCalendar,
  formatDuration,
  matchCalendar,
  parseEventInput,
  shortDate,
  writable,
} from "../palette/parse";
import { useAccounts } from "../store/useAccounts";
import { useCalendarView } from "../store/useCalendarView";
import { notify } from "../store/useToast";
import { startOfDay, toDateOnly } from "../time";
import { ColorPicker, type ColorChoice } from "./ColorPicker";
import { MIN_EVENT_MINUTES, calSlot, vars } from "./GridModel";
import { useGrid } from "./GridStore";
import { fromDateTime, toTimeOnly } from "./overlayModel";
import {
  allDaySlot,
  draftOf,
  minutesOf,
  sentenceFor,
  slotFromParse,
  timedSlot,
  withEnd,
  withStart,
  type Side,
  type Slot,
} from "./QuickCreateModel";
import { useEditor } from "./useEditor";

export interface QuickCreateCardProps {
  ref?: Ref<HTMLFormElement>;
  /** Where the anchor decided the card goes, relative to the range box it hangs off. */
  style?: CSSProperties;
  side: Side;
  /** False until the card has been measured, so it never flashes at the wrong corner. */
  placed: boolean;
  /** Local midnight of the column the range was dragged on. */
  dayStart: number;
  slot: Slot;
  onSlot: (slot: Slot) => void;
  /** The range as dragged. The fields fall back to it when the text stops describing a time. */
  dragged: Slot;
  onClose: () => void;
}

export function QuickCreateCard({
  ref,
  style,
  side,
  placed,
  dayStart,
  slot,
  onSlot,
  dragged,
  onClose,
}: QuickCreateCardProps) {
  const calendars = useAccounts((s) => s.calendars);
  const saving = useGrid((s) => s.saving);

  const [text, setText] = useState("");
  const [where, setWhere] = useState("");
  const [note, setNote] = useState("");
  const [color, setColor] = useState<ColorChoice>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const title = useRef<HTMLInputElement | null>(null);

  // What the fields say on their own, before the text is taken into account. Held in a ref because
  // it is the base a new parse is applied to, not something a render reads.
  const base = useRef<Slot>(dragged);

  useEffect(() => {
    title.current?.focus();
  }, []);

  const parsed = useMemo(
    () => parseEventInput(text, Date.now(), dragged.startMs),
    [text, dragged.startMs],
  );

  const options = useMemo(() => calendars.filter(writable), [calendars]);
  const matched = useMemo(
    () => matchCalendar(parsed.calendarHint, calendars),
    [parsed.calendarHint, calendars],
  );
  // Resolved by id and looked up again, because the parser's calendar helpers only promise the
  // fields they compare on and the dot needs the colour.
  const wanted = matched?.id ?? picked ?? defaultCalendar(calendars)?.id ?? null;
  const target = options.find((c) => c.id === wanted) ?? null;

  const summary = parsed.title;
  const location = where.trim() || parsed.location || null;
  const description = note.trim() || null;
  const calendarColor = target
    ? `var(--cal-${calSlot(target.colorHex, target.id)})`
    : "var(--line-strong)";
  const minutes = minutesOf(slot);
  const elsewhere = startOfDay(slot.startMs) !== dayStart;
  const ready = target !== null && summary.length > 0 && !saving;

  const warning = !target
    ? "No calendar here can be written to."
    : parsed.calendarHint && !matched
      ? `No calendar matches #${parsed.calendarHint}, so this goes to ${target.summary}.`
      : parsed.ambiguous
        ? `Not sure: ${parsed.ambiguous}.`
        : null;

  /** The parser took something out of the text, so the card owes the user a sentence about it. */
  const understood = parsed.dated || parsed.location !== null || parsed.calendarHint !== null;

  // The slot is applied here rather than in an effect on `parsed`: it is derived from the text but
  // overridable by the fields, and an effect would win that argument every time a key is pressed.
  function retext(next: string) {
    setText(next);
    const read = parseEventInput(next, Date.now(), dragged.startMs);
    onSlot(slotFromParse(read, base.current) ?? base.current);
  }

  function retime(next: Slot) {
    base.current = next;
    onSlot(next);
  }

  function toggleAllDay() {
    retime(slot.allDay ? timedSlot(slot, dragged) : allDaySlot(slot));
  }

  async function create() {
    if (!target || !ready) return;
    useGrid.getState().setSaving(true);
    try {
      await eventCreate(
        draftOf(slot, {
          calendarId: target.id,
          summary,
          location,
          description,
          colorId: color,
        }),
      );
      onClose();
      void useCalendarView.getState().load();
    } catch (e) {
      // Nothing was written optimistically, so the revert is simply that the card stays as it was,
      // with the text still in it, rather than being torn down over a failure.
      notify(`Could not create “${summary}”: ${e}`);
      title.current?.focus();
    } finally {
      useGrid.getState().setSaving(false);
    }
  }

  /**
   * Anything the card does not do lives in the editor, seeded with what has been said so far.
   */
  function expand() {
    onClose();
    useEditor.getState().create({
      startMs: slot.startMs,
      endMs: slot.endMs,
      allDay: slot.allDay,
      calendarId: target?.id,
      summary,
      location: location ?? undefined,
      description: description || undefined,
      colorId: color ?? undefined,
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    e.stopPropagation();
    if (e.key !== "Enter") return;
    if (primaryHeld(e)) {
      e.preventDefault();
      expand();
      return;
    }
    // A swatch is a button, so Enter on one would pick the colour it has already picked and the
    // card would sit there. Enter means create here, as it does from every field but the
    // description, where a new line is the only thing it can sensibly mean.
    if ((e.target as HTMLElement).getAttribute("role") === "radio") {
      e.preventDefault();
      void create();
    }
  }

  return (
    <form
      ref={ref}
      className="quick-create-card"
      data-no-drag=""
      data-side={side}
      data-placed={placed ? "" : undefined}
      style={style}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <input
        ref={title}
        className="quick-create-title"
        value={text}
        placeholder="New event"
        aria-label="Title"
        autoComplete="off"
        spellCheck={false}
        disabled={saving}
        onChange={(e) => retext(e.target.value)}
      />

      <div className="quick-create-when">
        {slot.allDay ? (
          <span className="quick-create-day" data-moved={elsewhere ? "" : undefined}>
            {shortDate(slot.startMs)}
          </span>
        ) : (
          <>
            <input
              type="time"
              className="quick-create-time"
              value={toTimeOnly(slot.startMs)}
              step={300}
              aria-label="Starts"
              disabled={saving}
              onChange={(e) =>
                retime(
                  withStart(
                    slot,
                    fromDateTime(toDateOnly(slot.startMs), e.target.value),
                    MIN_EVENT_MINUTES,
                  ),
                )
              }
            />
            <span className="quick-create-to">to</span>
            <input
              type="time"
              className="quick-create-time"
              value={toTimeOnly(slot.endMs)}
              step={300}
              aria-label="Ends"
              disabled={saving}
              onChange={(e) =>
                retime(
                  withEnd(
                    slot,
                    fromDateTime(toDateOnly(slot.startMs), e.target.value),
                    MIN_EVENT_MINUTES,
                  ),
                )
              }
            />
            <span className="quick-create-length">{formatDuration(minutes)}</span>
            {elsewhere && <span className="quick-create-day" data-moved="">{shortDate(slot.startMs)}</span>}
          </>
        )}
        <button
          type="button"
          className="quick-create-toggle"
          data-on={slot.allDay ? "" : undefined}
          aria-pressed={slot.allDay}
          disabled={saving}
          onClick={toggleAllDay}
        >
          All day
        </button>
      </div>

      <div className="quick-create-where">
        <span className="quick-create-dot" style={vars({ "--cal": calendarColor })} />
        <select
          className="quick-create-calendar"
          value={target?.id ?? ""}
          aria-label="Calendar"
          disabled={saving || options.length === 0}
          onChange={(e) => setPicked(e.target.value)}
        >
          {options.length === 0 && <option value="">Nothing you can write to</option>}
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.summary || "Untitled"}
            </option>
          ))}
        </select>
        <input
          className="quick-create-place"
          value={where}
          placeholder={parsed.location ?? "Where"}
          aria-label="Location"
          autoComplete="off"
          disabled={saving}
          onChange={(e) => setWhere(e.target.value)}
        />
      </div>

      <div className="quick-create-colour">
        <span className="quick-create-label">Colour</span>
        <ColorPicker
          value={color}
          onChange={setColor}
          calendarColor={calendarColor}
          disabled={saving}
        />
      </div>

      <textarea
        className="quick-create-note"
        value={note}
        rows={3}
        placeholder="Description"
        aria-label="Description"
        disabled={saving}
        onChange={(e) => setNote(e.target.value)}
      />

      {text.trim().length === 0 ? (
        <p className="quick-create-hint">
          Title it, or say it: <code>1pm 45m</code>, <code>at the cafe</code>, <code>#calendar</code>.
        </p>
      ) : (
        understood && (
          <p className="quick-create-hint">
            {sentenceFor(parsed, slot, summary || "Untitled", location, target?.summary ?? null)}
          </p>
        )
      )}
      {warning && <p className="quick-create-warning">{warning}</p>}

      <div className="quick-create-foot">
        <button type="button" className="quick-create-link" disabled={saving} onClick={expand}>
          More
          <kbd className="quick-create-key">{PRIMARY_LABEL}↩</kbd>
        </button>
        <button type="button" className="quick-create-button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="quick-create-button" data-variant="primary" disabled={!ready}>
          {saving ? "Creating" : "Create"}
          <kbd className="quick-create-key">↩</kbd>
        </button>
      </div>
    </form>
  );
}

export default QuickCreateCard;
