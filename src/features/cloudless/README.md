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
  - `testing/fakeIndexedDb.ts`: a small in-memory IndexedDB for unit tests.
