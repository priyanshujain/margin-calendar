import { call, type Calendar } from "../ipc";

export const calendarsList = () => call<Calendar[]>("calendars_list");

export const calendarSetSelected = (calendarId: string, selected: boolean) =>
  call<void>("calendar_set_selected", { calendarId, selected });
