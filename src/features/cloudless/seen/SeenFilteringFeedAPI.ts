import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {FeedTuner, type FeedTunerFn} from '#/lib/api/feed-manip'
import {type app} from '#/lexicons'
import {
  getHideSeen,
  getSeenSnapshotTime,
  setSeenSnapshotTime,
} from './feedState'
import {isBeforeLookBack, isFallbackMarker} from './lookBack'
import {getSeenLists, type SeenList, type SeenListRegistry} from './seenList'
import {isHideSeenTuner} from './tuner'

type FetchParams = Parameters<FeedAPI['fetch']>[0]

/**
 * Posts asked for per underlying request while searching past seen posts:
 * the most `app.bsky.feed.getTimeline` allows.
 */
export const SEARCH_PAGE_SIZE = 100
/**
 * Underlying requests per `fetch()` while searching past seen posts. When
 * they run out, the page returns with a cursor and the next page carries on.
 */
export const MAX_SEARCH_REQUESTS = 10

/**
 * Wraps the Following feed's API. It never hides posts itself: what it
 * returns goes into the query cache, and the hiding tuner removes seen posts
 * when the feed is tuned, so seen posts can be shown again in place. The
 * wrapper
 *
 * - waits for the account's seen list before the first page, then sets the
 *   snapshot time once the page has arrived;
 * - while seen posts are hidden, keeps requesting until it has a post that is
 *   not seen, reaches the look-back limit, or runs out of timeline, so a long
 *   run of seen posts does not stall the feed;
 * - ends the feed at the look-back limit (the moment the oldest remembered
 *   post was seen) by returning no cursor, and keeps the real cursor in
 *   {@link savedCursor};
 * - answers the "new posts" check with nothing when the newest post is
 *   already seen.
 *
 * While seen posts are shown, it passes requests through unchanged.
 */
export class SeenFilteringFeedAPI implements FeedAPI {
  /**
   * The cursor the timeline would continue from where hiding ended the feed
   * (at the look-back limit, or where Home would fall back to Discover).
   * Showing seen posts can put it back to keep loading.
   */
  savedCursor: string | undefined

  private feedTuners: FeedTunerFn[]
  private lists: SeenListRegistry
  private now: () => number

  constructor(
    readonly inner: FeedAPI,
    readonly did: string,
    {
      feedTuners = [],
      lists = getSeenLists(),
      now = Date.now,
    }: {
      /**
       * The feed's other tuners. A post they would drop does not end the
       * search for an unseen post.
       */
      feedTuners?: FeedTunerFn[]
      lists?: SeenListRegistry
      now?: () => number
    } = {},
  ) {
    this.feedTuners = feedTuners
    this.lists = lists
    this.now = now
  }

  /**
   * `FeedAPI` promises a post, but `pollLatest` checks for one, so returning
   * `undefined` reads as "nothing new".
   */
  async peekLatest(): Promise<app.bsky.feed.defs.FeedViewPost> {
    const latest = await this.inner.peekLatest()
    if (
      latest &&
      getHideSeen() &&
      this.lists.get(this.did).get(latest.post.uri)
    ) {
      return undefined as unknown as app.bsky.feed.defs.FeedViewPost
    }
    return latest
  }

  async fetch(params: FetchParams): Promise<FeedAPIResponse> {
    const isFirstPage = !params.cursor
    const list = this.lists.get(this.did)
    if (isFirstPage) {
      await list.ready
    }
    /*
     * The look-back limit counts only entries known at the snapshot, as
     * hiding does. The first page sets a new snapshot when it arrives, so it
     * counts everything known now.
     */
    const asOf = isFirstPage
      ? this.now()
      : (getSeenSnapshotTime(this.did) ?? this.now())
    const res = getHideSeen()
      ? await this.fetchHiding(params, list, list.oldestSeenAt(asOf))
      : await this.inner.fetch(params)
    if (isFirstPage) {
      setSeenSnapshotTime(this.did, this.now())
    }
    return res
  }

  private async fetchHiding(
    {cursor, signal}: FetchParams,
    list: SeenList,
    lookBack: number | undefined,
  ): Promise<FeedAPIResponse> {
    const feed: app.bsky.feed.defs.FeedViewPost[] = []
    let next = cursor
    for (let request = 0; request < MAX_SEARCH_REQUESTS; request++) {
      let res: FeedAPIResponse
      try {
        res = await this.inner.fetch({
          cursor: next,
          limit: SEARCH_PAGE_SIZE,
          signal,
        })
      } catch (e) {
        // Keep what was found; the next page retries from here.
        if (request === 0) throw e
        break
      }
      const previous = next
      next = res.cursor

      if (lookBack !== undefined) {
        /*
         * Older posts in this page stay in the cache for showing later; the
         * tuner hides them. A fallback marker means the timeline ran out, and
         * the Discover posts after it are not Following.
         */
        const marker = res.feed.findIndex(isFallbackMarker)
        if (marker !== -1) {
          feed.push(...res.feed.slice(0, marker))
          this.savedCursor = next
          return {feed}
        }
        if (res.feed.some(item => isBeforeLookBack(item, lookBack))) {
          feed.push(...res.feed)
          this.savedCursor = next
          return {feed}
        }
      }

      feed.push(...res.feed)
      if (!next || next === previous) break
      if (this.hasUnseen(res.feed, list)) break
    }
    return {feed, cursor: next}
  }

  /**
   * Whether the page has a unit the feed would show: one its other tuners
   * keep and whose newest post is not seen.
   */
  private hasUnseen(
    feed: app.bsky.feed.defs.FeedViewPost[],
    list: SeenList,
  ): boolean {
    const slices = new FeedTuner(this.feedTuners).tune(feed, {dryRun: true})
    return slices.some(slice => {
      const last = slice.items[slice.items.length - 1]
      return !!last && !list.get(last.post.uri)
    })
  }
}

/**
 * Creates the feed API with `create` and wraps it when it serves the
 * signed-in user's Following feed. Every other feed's API is returned
 * unchanged.
 *
 * The hiding tuner is left out of the tuners the API receives: the merged
 * "lab" Following feed pre-tunes timeline pages with them, which would drop
 * seen posts before they reach the query cache.
 */
export function withSeenFiltering<
  Args extends {
    feedDesc: string
    client: {did?: string}
    feedTuners: FeedTunerFn[]
  },
>(args: Args, create: (args: Args) => FeedAPI): FeedAPI {
  const did = args.client.did
  if (args.feedDesc !== 'following' || !did) return create(args)
  const feedTuners = args.feedTuners.filter(fn => !isHideSeenTuner(fn))
  return new SeenFilteringFeedAPI(create({...args, feedTuners}), did, {
    feedTuners,
  })
}
