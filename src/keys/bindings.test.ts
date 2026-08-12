// The table's own invariants. Two bindings on one combo in one context would silently shadow each
// other, and a group the sheet does not render would silently hide a key, so both are asserted
// here rather than discovered later.
//
// This imports the table alone. `commands.ts` reaches for localStorage and Tauri the moment it is
// loaded, which is why `bindingLabel` takes the lookup as an argument.

import { describe, expect, it } from "vitest";
import { BINDINGS, GROUPS, bindingLabel, keyLabel, normalizeCombo } from "./bindings";

describe("the binding table", () => {
  it("never binds one combo twice in the same context", () => {
    const seen = new Set<string>();
    for (const binding of BINDINGS) {
      for (const key of binding.keys) {
        const slot = `${binding.context}:${normalizeCombo(key)}`;
        expect(seen.has(slot), `${slot} is bound twice`).toBe(false);
        seen.add(slot);
      }
    }
  });

  it("puts every binding in a group the sheet renders", () => {
    for (const binding of BINDINGS) expect(GROUPS).toContain(binding.group);
  });

  it("can name every binding, including the ones it does not own", () => {
    for (const binding of BINDINGS) {
      expect(bindingLabel(binding, (id) => `command ${id}`)).not.toBe("");
    }
  });

  it("documents Escape without claiming to handle it", () => {
    const escape = BINDINGS.find((b) => b.keys.includes("Escape"));
    expect(escape?.command).toBeNull();
  });

  it("reads a combo the same way the dispatcher builds one", () => {
    expect(normalizeCombo("Cmd+K")).toBe("cmd+k");
    expect(normalizeCombo("cmd+k")).toBe("cmd+k");
    expect(normalizeCombo("H")).toBe("H");
    expect(normalizeCombo("/")).toBe("/");
  });

  it("prints a shifted letter as a shifted letter", () => {
    expect(keyLabel("H")).toBe("⇧H");
    expect(keyLabel("h")).toBe("h");
    expect(keyLabel("Enter")).toBe("↩");
    expect(keyLabel("Escape")).toBe("⎋");
  });
});
