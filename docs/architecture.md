# Architecture

Tauri 2, React 19, Vite, TypeScript and zustand on the front, Rust behind. Same stack as
margin, which means the OAuth flow, the token handling and the build and bundle setup carry
over rather than being invented again.

The split is strict. Rust owns authentication, all HTTP to Google, the local store, the sync
loop, recurrence expansion and timezone arithmetic. TypeScript owns rendering and interaction
and nothing else. The frontend never talks to Google, which keeps the content security policy
locked to `ipc:` exactly as margin has it.

## Authentication

Lifted from `margin/src-tauri/src/gdrive.rs`, then split in two when mobile arrived. Both halves
build the same consent URL with PKCE S256 and a CSRF state parameter and open it in the system
browser through the opener plugin, never an in-app webview: Google blocks the embedded-webview
flow, and it deserves to be blocked, because a webview the app controls can read the password
typed into it. They differ only in how the answer comes back.

Desktop binds a listener on `127.0.0.1:0` and catches the redirect on the loopback socket. The
verifier lives on that listener's stack for the two minutes it is alive.

Mobile cannot do that. iOS will not keep a background listener alive dependably, and Google
rejects loopback redirects for Android and iOS client types outright, so the redirect is a custom
URI scheme the OS routes back to the app through `tauri-plugin-deep-link`. There is no listener to
hold the verifier, the browser is a separate app and this process may be backgrounded while the
user consents, so the verifier waits in `AuthState.pending` and `handle_redirect` picks it up
whenever the link lands. It is taken rather than read, so a replayed link cannot start a second
exchange.

That split forces one more difference. A desktop client is confidential and has a secret; an
Android or iOS client is public and has none, so `google-credentials.json` carries up to three
clients and the build embeds the one for the platform it is compiling for. Details and the
console steps are in [mobile.md](mobile.md).

The scope is `https://www.googleapis.com/auth/calendar` plus `openid email`. Calendar is a
sensitive scope, so an unverified client shows the unverified-app interstitial and caps at 100
users. Irrelevant for personal use, relevant the moment this ships the way margin ships.

Refresh tokens never go to disk in plaintext and never into SQLite. They are sealed with
XChaCha20-Poly1305 in the app data directory, the same way on all five platforms.

There is no `keyring` here, and its absence is deliberate rather than an omission. It has no
Android backend at all; on macOS it ties an item to the code signature, so an ad-hoc signed build
gets a new identity on every compile and macOS re-asks for authorization every time; and on Linux
it is missing on exactly the minimal window managers that run no Secret Service daemon. That left
one real implementation behind four ways of reaching it. `src-tauri/src/google/secrets.rs` states
plainly what the file is worth on each platform, which is more on the mobile sandboxes than on a
desktop home directory.

## Store

SQLite through `rusqlite` with the bundled feature, so there is no system SQLite dependency on
either platform.

Accounts hold an email and a reference naming the sealed token, never the token itself. The
column is still called `keychain_ref` from when there was a keychain; renaming it would cost a
migration and buy nothing. Calendars hold their account, summary,
colour, selection state, access role, default timezone and their own sync token. Events hold
the raw Google shape flattened: identity and etag, summary, description, location, start and
end with their separate timezones, an all-day flag, the recurrence rule set, the pointer back
to a master plus original start for exception instances, status, and attendees and conference
data as JSON blobs. An outbox table holds pending writes.

Events are stored as Google returns them with `singleEvents=false`, meaning recurring series
are one row carrying an RRULE rather than thousands of rows. Expansion happens on read.

## Sync

Incremental sync through `events.list` with a stored `syncToken`, one cursor per calendar,
`singleEvents=false`, `showDeleted=true`, `maxResults=2500`. The parameter set has to be
byte-identical across every call in a chain, including the initial one.

The constraint that shapes everything: `timeMin` and `timeMax` cannot be used with
`syncToken`, along with `q`, `orderBy`, `updatedMin`, `iCalUID` and the extended property
filters. There is no way to sync a window. The initial full sync pulls the entire calendar
history, which for an old personal calendar is a few thousand rows and a one-time cost of
seconds, and is only tolerable because recurring series collapse to single rows.

`nextSyncToken` appears only on the final page, so pages must be walked to exhaustion with
`pageToken` before anything is persisted. A 410 means the token is dead: drop that calendar's
rows and its cursor and full-resync it alone, without touching the others. `calendarList.list`
carries its own sync token for the set of calendars itself.

Polling, not webhooks. Push notifications need a publicly verified HTTPS callback and channels
that expire every few days, neither of which a desktop app has. Sixty seconds while the window
is focused, five minutes when it is not. An incremental poll with no changes is a single small
request against a million-a-day quota.

## Writes

Optimistic. A write lands in SQLite, is marked dirty, is enqueued in the outbox and renders
immediately; the push to Google happens behind it. Requests carry `If-Match` with the stored
etag, and a 412 means someone else changed it first, so refetch and surface the conflict
rather than clobbering. Offline writes queue and drain on reconnect. The outbox is the reason
the app works on a plane and the reason it never spins.

## Recurrence

The `rrule` crate, which is built on `chrono-tz`. Expansion takes a window and a set of
masters, generates occurrences, drops any occurrence whose original start matches a cancelled
or overridden instance, then merges the override events back in at their moved times. The
frontend asks for a range and receives a flat array of instances; it has no concept of a
recurrence rule.

Editing a series is three distinct operations. Editing one instance resolves the real instance
through `events.instances` and patches that, rather than constructing the instance id by hand.
Editing this and all following truncates the master's rule with an UNTIL and creates a new
master from the split point. Editing the whole series patches the master. All three are worth
tests before they are worth UI.

## Time

Every event keeps its own timezone; the grid renders in the local zone. All-day events are
date-only and must never be shifted into a zone, which is the single most common bug in this
category of app and deserves a test that runs in a non-UTC zone. DST transitions mean a day is
sometimes 23 or 25 hours long, which the vertical fit calculation has to accept rather than
assume away.

## Platforms

macOS uses the overlay title bar with the header row padded for the traffic lights, as margin
does. Linux has no traffic lights, so that padding is conditional. Linux builds need
`libwebkit2gtk-4.1-dev` and ship as AppImage and deb.

## Order of work

The sync engine and the grid are the two hard things and neither is proven by the other, so
the first milestone is authentication, sync and a read-only grid with correct vertical fit.
Recurrence and timezone correctness come second, with tests, because everything after depends
on the instance stream being right. Create, edit and delete with the outbox come third.
Multiple accounts, the command palette and natural language parsing come last, since they are
the parts that are pleasant rather than load-bearing.
