# Cloudless Sky

Code that belongs to the Cloudless Sky fork and not to upstream Bluesky. All
fork features live in this folder. Upstream files change only where a feature
must hook in, and each such file is listed in
[`docs/cloudless-sky.md`](../../../docs/cloudless-sky.md#upstream-files-the-fork-changes).

- `appName.ts`: the product name used in page titles.
- `metrics.ts`: turns off usage metrics unless a metrics host is configured.
- `safeArea.ts`: keeps the web bottom bar clear of the iPhone home indicator.
- `seen/`: hides Following posts the user has already seen.
  - `recorder.ts`: notices which Following posts have been on screen, using
    the list's existing seen events (well on screen for about half a second).
    A reply unit counts once its last post has been seen; it then records
    every displayed post in the unit by post URI.
  - `constants.ts`: the 100,000-post limit (`SEEN_LIST_LIMIT`, shared with the
    sync service), the IndexedDB schema names and the record types.
  - `db.ts`: the IndexedDB layer. Database `cloudless_seen`, store `seen`
    keyed by `[did, uri]` with `seenAt` and `dirty` (`1` until synced), the
    indexes `did_seenAt` and `did_dirty`, and store `meta` keyed by `did` for
    `lastSyncServerTime`. A write keeps the later `seenAt` and then drops the
    oldest records past the limit. A write of pulled entries (`dirty: 0`)
    leaves a later local record dirty and marks one with the same `seenAt`
    synced. `readDirtySeen` reads unsent records through `did_dirty`, and
    `markSeenSynced` clears `dirty` only where `seenAt` is unchanged.
  - `seenList.ts`: each account's seen list in memory, as `uri -> {seenAt,
    knownAt}`. `knownAt` is when this device learned of the entry (load time,
    sighting time, or when another tab announced it) and is never stored.
    Sightings are written every 2 seconds and when the page is hidden or
    unloaded. Each written batch is announced on the `cloudless_seen`
    BroadcastChannel so other tabs update their lists. Without IndexedDB, or
    when it fails, the list keeps working in memory for the session. For
    sync it also keeps this tab's unsent sightings in memory
    (`peekUnsynced`), reads and marks unsent entries, keeps the sync
    position, and merges pulled entries (`applySynced`) with `knownAt` set
    to now, announcing them to other tabs.
  - `feedState.ts`: the hiding state outside React: the per-account
    snapshot time and the device-wide `hideSeen` flag (default on). A post
    is hidden only if this device knew it was seen (`knownAt`) at or before
    the snapshot time. The snapshot moves only when the Following query
    fetches its first page (open or refresh) and when the toggle switches
    (`switchHideSeen()`), so posts seen while scrolling stay on screen, and
    gain no badge, until the next refresh or toggle.
  - `hideSeenSetting.ts`: remembers `hideSeen` per device, in the fork's own
    `cloudless_device` store (`localStorage` on web), apart from upstream's
    device store. If storage fails, the choice lasts for the session and
    the default is to hide.
  - `context.tsx`: `SeenFeedProvider`, mounted around legacy Home, exposes
    `{did, snapshotTime, hideSeen, anchorRows}`, and `useHideSeenTuner()`
    builds the tuner from it. After each switch it scrolls the recorded
    anchor back into place, before paint and again on the next frame.
    Without the provider, nothing is hidden and the toggle is not shown.
  - `useToggleHideSeen.ts`: the show/hide switch. It records the anchor
    post, moves the snapshot to now, puts the wrapper's
    `savedCursor` back on the last cached Following page when switching to
    showing (`setQueriesData`), and flips `hideSeen`. The cached pages are
    re-tuned; nothing is fetched.
  - `SeenToggle.tsx`: the eye button in the Home header, shown only while
    the Following tab is selected. Its label names its action ("Show seen
    posts" / "Hide seen posts"). It is positioned beside the feeds button
    without taking layout space.
  - `anchor.ts` and `SeenAnchorRow.tsx`: keeping the reader's place. Each
    Following post row registers its DOM node. The anchor is the first row
    at or below the header (or a row under the header that fills at least
    half the screen); after the switch the page scrolls so it, or the
    nearest remaining row below it, then above it, is back where it was.
    The browser's own scroll anchoring is paused meanwhile, and the page
    scrolls with `window.scrollTo`, which the shell treats as programmatic,
    so the phone-width header stays put.
  - `tuner.ts`: the Following feed tuner. It drops a unit when its last item
    (the newest post: the reply in a reply unit, the original in a repost)
    is seen as of the snapshot, or when the unit entered the timeline before
    the look-back limit. Fetched pages keep every post; hiding happens
    only when the query tunes them, so seen posts can be shown again in place.
  - `SeenFilteringFeedAPI.ts`: wraps the Following feed API. It waits for the
    seen list before the first page, sets the snapshot time when that page
    arrives, and answers the "new posts" check with nothing when the newest
    post is already seen. While seen posts are hidden, each `fetch()` asks for
    100 posts at a time and keeps going (up to 10 requests) until it has a
    post the feed would show that was not known seen at the snapshot (the
    tuner's rule), so a long run of seen posts does not stall the feed. It ends the feed at the look-back limit by
    returning no cursor, and keeps the real cursor in `savedCursor` (reset on
    every fetch, so it always belongs to the latest page). It never drops
    posts from what it returns, except Home's fallback marker and the
    Discover posts after it, which it holds back for showing seen posts
    (`HELD_BACK_CURSOR`). While seen posts are shown it passes requests
    through and notes which cursors lead past the look-back limit; back in
    hiding, a request from one of them returns an empty page with no cursor
    and no network request. If seen posts are shown while a hiding request
    is in flight, that page keeps its cursor.
  - `lookBack.ts`: a feed item's timeline time (repost time for reposts) for
    the look-back limit. The limit is the earliest `seenAt` among entries
    known at the snapshot, so the first session on an empty list has no
    limit, and the limit moves forward as the list rolls past 100,000.
  - `SeenBadge.tsx`: the "Seen" pill shown after the author and time on
    seen posts while seen posts are shown. `useSeenBadgeFor()` gives
    `PostFeed` a badge for a unit when its last post was known seen at or
    before the snapshot (`isSliceSeenAsOf`, the tuner's rule), so the badged
    posts are exactly the ones hiding would hide, and every post in a unit
    gets the same answer. Only Following badges, and never while seen posts
    are hidden. One shared badge element keeps memoized rows stable.
  - `PostMetaRow.tsx`: the slot `PostFeedItem` uses for the badge. Without an
    accessory it renders the top line as upstream does.
  - `CaughtUp.tsx`: "You're all caught up", shown in place of Following's
    official empty and end-of-feed messages while seen posts are hidden and
    the account has seen something. Its "Show seen posts" button uses the
    same switch as the header button.
  - `home.ts`: pins Home to the legacy version, which these hooks use.
  - `testing/fakeIndexedDb.ts`: a small in-memory IndexedDB for unit tests.
- `sync/`: shares each account's seen list between devices through the
  sync service in `cloudless-sync/` (Story 4.2).
  - `config.ts`: the service's address. Production web builds use `/sync` on
    the app's own origin; `EXPO_PUBLIC_CLOUDLESS_SYNC_URL` overrides it.
    Development builds sync only when that variable is set, and native
    builds never do.
  - `client.ts`: `GET /seen` pages and `POST /seen` batches, each request
    abandoned after 30 seconds, plus a `keepalive` push whose body is kept
    under 60 KB (browsers allow 64 KiB of keepalive bodies in flight).
  - `SeenSyncer.ts`: one account's sync. A full sync pulls every change
    since `lastSyncServerTime`, following the cursor, merges each page, then
    saves the new position, and then pushes unsent entries in batches of
    1,000. It runs once the list has loaded, every 30 seconds while the page
    is visible (a hidden page waits), and when the page becomes visible or
    the network comes back. A push alone runs 5 seconds after posts are
    seen and leaves the next pull's timer alone. Hiding or leaving the page
    sends one keepalive batch of the newest unsent sightings from memory.
    Failures retry after 5 seconds, doubling up to 5 minutes. Tabs take
    turns through a Web Lock per account. Dev builds log every sync, push
    on hide and failure.
  - `index.ts`: `startSeenSync(did)`, called by `SeenFeedProvider` for the
    signed-in account. It stops the previous account's sync and wires up the
    page's visibility, `pagehide` and `online` events.
  - `testing/fakeSyncService.ts`: an in-memory stand-in for the service.
  - Merged entries are known only from when they arrive, so, like a
    sighting while scrolling, they change nothing on screen (nor the
    look-back limit) until the next refresh or toggle. While searching past
    seen posts, the Following feed counts them as unseen for the same
    reason: the hiding tuner will show them.
  - `__tests__/integration.test.ts` syncs two devices through a real copy
    of the service, started from `cloudless-sync/src` in dev mode. It is
    skipped unless `cloudless-sync` has its dependencies installed.
