import { call, type EventDraft, type EventPatch, type Instance, type InstanceKey, type Scope } from "../ipc";

export const eventCreate = (draft: EventDraft) => call<Instance>("event_create", { draft });

export const eventUpdate = (key: InstanceKey, patch: EventPatch, scope: Scope) =>
  call<void>("event_update", { key, patch, scope });

export const eventDelete = (key: InstanceKey, scope: Scope) =>
  call<void>("event_delete", { key, scope });
