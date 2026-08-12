// The command palette, which is also where events are created. Both halves are one list: a row is
// either a command or the event the text describes, and Enter runs whichever is highlighted.
//
// The parse is shown as a sentence under the input while you type, and when it is not certain it
// says so instead of quietly picking a reading. That warning is the difference between natural
// language input you can trust and a party trick.

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useEscapeLayer } from "../escape";
import { keyLabel, keysFor } from "../keys/bindings";
import { COMMANDS, commandMatches, runCommand, type CommandId } from "../keys/commands";
import { useAccounts } from "../store/useAccounts";
import { useCalendarView } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import "../styles/palette.css";
import { createFromInput } from "./create";
import {
  defaultCalendar,
  defaultStart,
  matchCalendar,
  parseEventInput,
  previewText,
} from "./parse";
import { usePalette } from "./usePalette";

type Row = { kind: "create" } | { kind: "command"; id: CommandId; label: string };

export function CommandPalette() {
  const open = useOverlays((s) => s.open) === "palette";
  const close = useOverlays((s) => s.close);
  const anchor = useCalendarView((s) => s.anchor);
  const calendars = useAccounts((s) => s.calendars);
  const query = usePalette((s) => s.query);
  const index = usePalette((s) => s.index);
  const setQuery = usePalette((s) => s.setQuery);
  const setIndex = usePalette((s) => s.setIndex);
  const move = usePalette((s) => s.move);
  const reset = usePalette((s) => s.reset);

  const input = useRef<HTMLInputElement | null>(null);

  useEscapeLayer(open, close);

  useEffect(() => {
    if (!open) return;
    reset();
    input.current?.focus();
  }, [open, reset]);

  const parsed = useMemo(() => {
    const now = Date.now();
    return parseEventInput(query, now, defaultStart(anchor, now));
  }, [query, anchor]);

  const matched = useMemo(
    () => matchCalendar(parsed.calendarHint, calendars),
    [parsed.calendarHint, calendars],
  );
  const target = useMemo(() => matched ?? defaultCalendar(calendars), [matched, calendars]);

  const commands = useMemo(
    () => COMMANDS.filter((c) => c.palette && commandMatches(c.label, query)),
    [query],
  );

  const canCreate = query.trim().length > 0 && parsed.title.length > 0 && target !== null;

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = commands.map((c) => ({ kind: "command", id: c.id, label: c.label }));
    if (!canCreate) return list;
    // A dated phrase is almost certainly an event, so it leads. A bare word is probably a command.
    return parsed.dated || list.length === 0
      ? [{ kind: "create" }, ...list]
      : [...list, { kind: "create" }];
  }, [commands, canCreate, parsed.dated]);

  const active = rows.length === 0 ? -1 : Math.min(Math.max(index, 0), rows.length - 1);

  const warning = !target
    ? "Connect a Google account before creating events."
    : parsed.calendarHint && !matched
      ? `No calendar matches #${parsed.calendarHint}, so this goes to ${target.summary}.`
      : parsed.ambiguous
        ? `Not sure: ${parsed.ambiguous}.`
        : null;

  const showPreview =
    query.trim().length > 0 &&
    (parsed.dated || commands.length === 0 || rows[active]?.kind === "create");

  function run(row: Row | undefined) {
    if (!row) return;
    close();
    reset();
    if (row.kind === "command") runCommand(row.id);
    else if (target) void createFromInput(parsed, target.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      move(1, rows.length);
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      move(-1, rows.length);
    } else if (e.key === "Tab") {
      e.preventDefault();
      move(e.shiftKey ? -1 : 1, rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[active]);
    }
  }

  if (!open) return null;

  return (
    <div
      className="overlay"
      data-align="top"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="panel palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input
          ref={input}
          className="palette-input"
          type="text"
          value={query}
          placeholder="Type a command, or an event: lunch with sam tue 1pm 45m"
          autoComplete="off"
          spellCheck={false}
          aria-label="Command or event"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {showPreview && (
          <div className="palette-preview">
            <p className="palette-sentence">
              {parsed.title
                ? previewText(parsed, target?.summary ?? null)
                : "Give it a title and it will be created here."}
            </p>
            {warning && <p className="palette-warning">{warning}</p>}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="palette-empty">Nothing matches that.</p>
        ) : (
          <ul className="palette-list" role="listbox">
            {rows.map((row, at) => {
              const keys = row.kind === "command" ? keysFor(row.id) : ["Enter"];
              return (
                <li
                  key={row.kind === "command" ? row.id : "create"}
                  className="palette-row"
                  role="option"
                  aria-selected={at === active}
                  data-active={at === active ? "" : undefined}
                  data-kind={row.kind}
                  onPointerMove={() => setIndex(at)}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    run(row);
                  }}
                >
                  <span className="palette-label">
                    {row.kind === "command" ? row.label : `Create “${parsed.title}”`}
                  </span>
                  <span className="palette-keys">
                    {keys.slice(0, 1).map((key) => (
                      <kbd className="key" key={key}>
                        {keyLabel(key)}
                      </kbd>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default CommandPalette;
