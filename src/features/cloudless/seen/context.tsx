import {createContext, useContext, useEffect, useSyncExternalStore} from 'react'

import {useSession} from '#/state/session'
import {
  getHideSeen,
  getSeenSnapshotTime,
  subscribeToSeenFeedState,
} from './feedState'
import {getSeenLists} from './seenList'

export type SeenFeedContextValue = {
  /**
   * The signed-in account, whose seen list applies.
   */
  did: string | undefined
  /**
   * Posts known seen at or before this time are hidden. `undefined` until
   * the Following feed has loaded once.
   */
  snapshotTime: number | undefined
  /**
   * Whether Following hides seen posts.
   */
  hideSeen: boolean
}

/**
 * Hiding is off without a provider, so screens outside Home and tests see
 * every post.
 */
const SeenFeedContext = createContext<SeenFeedContextValue>({
  did: undefined,
  snapshotTime: undefined,
  hideSeen: false,
})
SeenFeedContext.displayName = 'SeenFeedContext'

/**
 * Provides the Following feed's hiding state to Home, and starts loading the
 * account's seen list so the first feed request does not wait long for it.
 */
export function SeenFeedProvider({children}: {children: React.ReactNode}) {
  const {currentAccount} = useSession()
  const did = currentAccount?.did
  const snapshotTime = useSyncExternalStore(subscribeToSeenFeedState, () =>
    did ? getSeenSnapshotTime(did) : undefined,
  )
  const hideSeen = useSyncExternalStore(subscribeToSeenFeedState, getHideSeen)

  useEffect(() => {
    if (!did) return
    const lists = getSeenLists()
    lists.retainOnly(did)
    lists.get(did)
  }, [did])

  return (
    <SeenFeedContext value={{did, snapshotTime, hideSeen}}>
      {children}
    </SeenFeedContext>
  )
}

export function useSeenFeed(): SeenFeedContextValue {
  return useContext(SeenFeedContext)
}
