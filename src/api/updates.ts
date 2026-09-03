import { call } from "../ipc";

/** The package manager that owns this install, or null when the app updates itself. */
export const packagedBy = () => call<string | null>("packaged_by");
