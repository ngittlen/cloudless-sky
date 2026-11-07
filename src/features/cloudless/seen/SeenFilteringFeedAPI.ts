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
 * The saved cursor where hiding cut off Home's fallback to Discover. It
 * stands for the page that was held back and never reaches the inner API.
 */
export const HELD_BACK_CURSOR = 'cloudless:held-back'

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
 *   {@link savedCursor}, which the show/hide toggle puts back to keep
 *   loading while seen posts are shown;
 * - answers a request that starts past the look-back limit with an empty
 *   page and no cursor, without a network request, so switching back to
 *   hiding ends the feed at the limit again;
 * - answers the "new posts" check with nothing when the newest post is
 *   already seen.
 *
 * While seen posts are shown, it passes requests through unchanged, noting
 * which cursors lead past the look-back limit.
 */
export class SeenFilteringFeedAPI implements FeedAPI {
  /**
   * The cursor the timeline would continue from where hiding ended the
   * latest page (at the look-back limit, or {@link HELD_BACK_CURSOR} where
   * Home falls back to Discover), or `undefined` when the latest page was
   * not ended by hiding. Showing seen posts can put it back to keep loading.
   */
  savedCursor: string | undefined

  /**
   * Cursors whose following posts all entered the timeline before a
   * look-back limit, each with that limit. A cursor still leads past any
   * limit at or after the one it was measured against.
   */
  private pastLookBack = new Map<string, number>()

  /**
   * The Discover fallback that hiding cut off: Home's marker and the posts
   * after it, with the cursor that follows them. Showing seen posts gets it
   * from {@link HELD_BACK_CURSOR}.
   */
  private heldBack:
    | {feed: app.bsky.feed.defs.FeedViewPost[]; cursor: string | undefined}
    | undefined

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
    this.savedCursor = undefined
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
    const lookBack = list.oldestSeenAt(asOf)
    let res: FeedAPIResponse
    if (getHideSeen()) {
      res = await this.fetchHiding(params, list, lookBack)
      if (!res.cursor && this.savedCursor !== undefined && !getHideSeen()) {
        /*
         * Seen posts were shown while this page loaded. The toggle found no
         * cursor to restore then, so carry on past the limit here.
         */
        res = {...res, cursor: this.savedCursor}
        this.savedCursor = undefined
      }
    } else if (params.cursor === HELD_BACK_CURSOR && this.heldBack) {
      res = this.heldBack
      this.notePastLookBack(params.cursor, res, lookBack)
    } else {
      res = await this.inner.fetch(params)
      this.notePastLookBack(params.cursor, res, lookBack)
    }
    if (isFirstPage) {
      setSeenSnapshotTime(this.did, this.now())
    }
    return res
  }

  /**
   * Whether every post after `cursor` entered the timeline before
   * `lookBack`, or comes from Home's fallback to Discover.
   */
  private startsPastLookBack(
    cursor: string | undefined,
    lookBack: number | undefined,
  ): boolean {
    if (cursor === undefined || lookBack === undefined) return false
    const measured = this.pastLookBack.get(cursor)
    return measured !== undefined && measured <= lookBack
  }

  private notePastLookBack(
    cursor: string | undefined,
    res: FeedAPIResponse,
    lookBack: number | undefined,
  ) {
    if (!res.cursor || lookBack === undefined) return
    if (this.startsPastLookBack(cursor, lookBack)) {
      this.pastLookBack.set(res.cursor, this.pastLookBack.get(cursor!)!)
    } else if (res.feed.some(isFallbackMarker)) {
      this.pastLookBack.set(res.cursor, -Infinity)
    } else if (res.feed.some(item => isBeforeLookBack(item, lookBack))) {
      this.pastLookBack.set(res.cursor, lookBack)
    }
  }

  private async fetchHiding(
    {cursor, signal}: FetchParams,
    list: SeenList,
    lookBack: number | undefined,
  ): Promise<FeedAPIResponse> {
    if (this.startsPastLookBack(cursor, lookBack)) {
      this.savedCursor = cursor
      return {feed: []}
    }
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
          this.heldBack = {feed: res.feed.slice(marker), cursor: next}
          this.savedCursor = HELD_BACK_CURSOR
          this.pastLookBack.set(HELD_BACK_CURSOR, -Infinity)
          return {feed}
        }
        if (res.feed.some(item => isBeforeLookBack(item, lookBack))) {
          feed.push(...res.feed)
          this.savedCursor = next
          if (next) this.pastLookBack.set(next, lookBack)
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

type CachedFeedPage = {
  api: FeedAPI
  cursor: string | undefined
}

/**
 * Puts the saved cursor back on the last cached page of a Following feed
 * that hiding ended, so that showing seen posts keeps loading past the
 * look-back limit. Returns `data` itself when there is nothing to restore,
 * which leaves the cache untouched.
 */
export function restoreSavedCursor<
  Data extends {pages: CachedFeedPage[]} | undefined,
>(data: Data): Data {
  const pages = data?.pages
  const last = pages?.[pages.length - 1]
  if (
    !data ||
    !pages ||
    !last ||
    last.cursor ||
    !(last.api instanceof SeenFilteringFeedAPI) ||
    last.api.savedCursor === undefined
  ) {
    return data
  }
  return {
    ...data,
    pages: [...pages.slice(0, -1), {...last, cursor: last.api.savedCursor}],
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
