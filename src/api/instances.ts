import { call, type Instance } from "../ipc";

/** Both bounds are epoch milliseconds; `toUtc` is exclusive. */
export const instancesRange = (fromUtc: number, toUtc: number) =>
  call<Instance[]>("instances_range", { fromUtc, toUtc });
