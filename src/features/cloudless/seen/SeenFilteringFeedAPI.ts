import {type FeedAPI, type FeedAPIResponse} from '#/lib/api/feed/types'
import {type FeedTunerFn} from '#/lib/api/feed-manip'
import {type app} from '#/lexicons'
import {getHideSeen, setSeenSnapshotTime} from './feedState'
import {getSeenLists, type SeenListRegistry} from './seenList'
import {isHideSeenTuner} from './tuner'

type FetchParams = Parameters<FeedAPI['fetch']>[0]

/**
 * Wraps the Following feed's API. It never drops posts: every fetched post
 * stays in the query cache, and the hiding tuner removes seen ones when the
 * feed is tuned. The wrapper
 *
 * - waits for the account's seen list before the first page, then sets the
 *   snapshot time once the page has arrived, and
 * - answers the "new posts" check with nothing when the newest post is
 *   already seen, since the feed would hide it.
 */
export class SeenFilteringFeedAPI implements FeedAPI {
  constructor(
    readonly inner: FeedAPI,
    readonly did: string,
    private lists: SeenListRegistry = getSeenLists(),
    private now: () => number = Date.now,
  ) {}

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
    if (isFirstPage) {
      await this.lists.get(this.did).ready
    }
    const res = await this.inner.fetch(params)
    if (isFirstPage) {
      setSeenSnapshotTime(this.did, this.now())
    }
    return res
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
  return new SeenFilteringFeedAPI(create({...args, feedTuners}), did)
}
