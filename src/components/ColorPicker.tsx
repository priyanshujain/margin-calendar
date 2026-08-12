// The eleven colours Google keeps against an event, plus the one that is not a colour: follow the
// calendar. Shared by the quick create card and the full editor so the choice reads the same in
// both, which is the whole point of it being a component rather than two rows of buttons.
//
// The swatches are painted in Google's own hex, because that is what `colorId` means to every
// other client this account is signed into. The grid mutes those hues onto its own eight when it
// paints the block (`calSlot` and `calHue` in GridModel), so a block is the nearest warm cousin of
// the swatch rather than the swatch itself. Showing the muted eight here instead would put three
// pairs of identical dots in the row and paint Graphite, which is grey, some arbitrary colour.
//
// One radio group, one tab stop: the arrow keys move between swatches. Twelve tab stops in a card
// this small would bury the buttons under them.

import { useRef, type KeyboardEvent } from "react";
import { EVENT_COLORS } from "../ipc";
import { vars } from "./GridModel";

/** `null` is "same as calendar", and is always one of the options. */
export type ColorChoice = string | null;

export interface ColorPickerProps {
  value: ColorChoice;
  onChange: (colorId: ColorChoice) => void;
  /**
   * A CSS colour for the "same as calendar" swatch, so it previews what following the calendar
   * would look like. The callers pass the same expression their calendar dot uses.
   */
  calendarColor?: string;
  disabled?: boolean;
  /** Names the group for a screen reader. The visible label is the caller's business. */
  label?: string;
}

const OPTIONS: ColorChoice[] = [null, ...EVENT_COLORS.map((c) => c.id)];

const nameOf = (id: ColorChoice): string =>
  id === null ? "Same as calendar" : (EVENT_COLORS.find((c) => c.id === id)?.name ?? "Colour");

export function ColorPicker({
  value,
  onChange,
  calendarColor = "var(--line-strong)",
  disabled,
  label = "Colour",
}: ColorPickerProps) {
  const row = useRef<HTMLDivElement | null>(null);

  const at = OPTIONS.indexOf(OPTIONS.includes(value) ? value : null);

  function move(delta: number) {
    const next = OPTIONS[(at + delta + OPTIONS.length) % OPTIONS.length];
    onChange(next);
    // Focus follows the selection, which is what a radio group does and what makes holding an
    // arrow key feel like scrubbing through the palette rather than tabbing through it.
    const buttons = row.current?.querySelectorAll<HTMLButtonElement>(".swatch");
    buttons?.[OPTIONS.indexOf(next)]?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") move(-1);
    else return;
    e.preventDefault();
  }

  return (
    <div className="swatches" role="radiogroup" aria-label={label} ref={row} onKeyDown={onKeyDown}>
      {OPTIONS.map((id) => {
        const on = id === OPTIONS[at];
        return (
          <button
            key={id ?? "calendar"}
            type="button"
            role="radio"
            className="swatch"
            aria-checked={on}
            aria-label={nameOf(id)}
            title={nameOf(id)}
            tabIndex={on ? 0 : -1}
            data-on={on ? "" : undefined}
            data-default={id === null ? "" : undefined}
            disabled={disabled}
            style={vars({
              "--swatch": id === null ? calendarColor : EVENT_COLORS.find((c) => c.id === id)?.hex,
            })}
            onClick={() => onChange(id)}
          />
        );
      })}
    </div>
  );
}

export default ColorPicker;
