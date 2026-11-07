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
    `{did, snapshotTime, hideSeen}`. Without it, nothing is hidden.
  - `tuner.ts`: the Following feed tuner. It drops a unit when its last item
    (the newest post: the reply in a reply unit, the original in a repost)
    is seen as of the snapshot. Fetched pages keep every post; hiding happens
    only when the query tunes them, so seen posts can be shown again in place.
  - `SeenFilteringFeedAPI.ts`: wraps the Following feed API. It waits for the
    seen list before the first page, sets the snapshot time when that page
    arrives, and answers the "new posts" check with nothing when the newest
    post is already seen.
  - `home.ts`: pins Home to the legacy version, which these hooks use.
  - `testing/fakeIndexedDb.ts`: a small in-memory IndexedDB for unit tests.
