import { call, type Account } from "../ipc";

export const accountsList = () => call<Account[]>("accounts_list");

/** Returns the consent URL. Completion arrives as the `auth` event. */
export const accountConnect = () => call<string>("account_connect");

export const accountDisconnect = (accountId: string) =>
  call<void>("account_disconnect", { accountId });
