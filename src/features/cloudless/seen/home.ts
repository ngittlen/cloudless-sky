/**
 * Whether the Home route may render the Following v2 fork of Home when
 * Bluesky's remote `following_v2:enable` flag selects it. Cloudless Sky
 * always renders the legacy Home, because hiding seen posts hooks into the
 * legacy Following data path (`src/state/queries/post-feed.ts`) and the v2
 * fork loads Following its own way.
 */
export const FOLLOWING_V2_HOME_ALLOWED: boolean = false
