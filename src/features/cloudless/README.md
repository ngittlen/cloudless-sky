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
    oldest records past the limit.
  - `seenList.ts`: each account's seen list in memory, as `uri -> {seenAt,
    knownAt}`. `knownAt` is when this device learned of the entry (load time,
    sighting time, or when another tab announced it) and is never stored.
    Sightings are written every 2 seconds and when the page is hidden or
    unloaded. Each written batch is announced on the `cloudless_seen`
    BroadcastChannel so other tabs update their lists. Without IndexedDB, or
    when it fails, the list keeps working in memory for the session.
  - `feedState.ts`: the hiding state outside React: the per-account
    snapshot time and the device-wide `hideSeen` flag (default on). A post
    is hidden only if this device knew it was seen (`knownAt`) at or before
    the snapshot time. The snapshot moves only when the Following query
    fetches its first page (open or refresh), so posts seen while scrolling
    stay on screen until the next refresh.
  - `context.tsx`: `SeenFeedProvider`, mounted around legacy Home, exposes
    `{did, snapshotTime, hideSeen}`, and `useHideSeenTuner()` builds the
    tuner from it. Without the provider, nothing is hidden.
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
    post the feed would show that is not seen, so a long run of seen posts
    does not stall the feed. It ends the feed at the look-back limit by
    returning no cursor, and keeps the real cursor in `savedCursor`. It never
    drops posts from what it returns, except Discover posts after Home's
    fallback marker.
  - `lookBack.ts`: a feed item's timeline time (repost time for reposts) for
    the look-back limit. The limit is the earliest `seenAt` among entries
    known at the snapshot, so the first session on an empty list has no
    limit, and the limit moves forward as the list rolls past 100,000.
  - `CaughtUp.tsx`: "You're all caught up", shown in place of Following's
    official empty and end-of-feed messages while seen posts are hidden and
    the account has seen something.
  - `home.ts`: pins Home to the legacy version, which these hooks use.
  - `testing/fakeIndexedDb.ts`: a small in-memory IndexedDB for unit tests.
