import {
  getDisplayedSliceItems,
  hasRecordedSeen,
  recordSeenFeedRow,
  resetRecorderForTests,
  type SeenEvent,
  subscribeToSeen,
} from '#/features/cloudless/seen/recorder'

jest.mock('#/logger', () => ({
  logger: {info: jest.fn(), error: jest.fn(), debug: jest.fn()},
}))

const DID = 'did:plc:alice'

function uri(rkey: string) {
  return `at://did:plc:bob/app.bsky.feed.post/${rkey}`
}

function slice(rkeys: string[], isIncompleteThread = false) {
  return {
    items: rkeys.map(rkey => ({uri: uri(rkey)})),
    isIncompleteThread,
  }
}

function row(s: ReturnType<typeof slice>, indexInSlice: number) {
  return {type: 'sliceItem', key: `k${indexInSlice}`, slice: s, indexInSlice}
}

describe('recordSeenFeedRow', () => {
  let events: SeenEvent[]
  let unsubscribe: () => void

  beforeEach(() => {
    resetRecorderForTests()
    events = []
    unsubscribe = subscribeToSeen(e => events.push(e))
  })

  afterEach(() => {
    unsubscribe()
  })

  it('records a single post by its URI', () => {
    recordSeenFeedRow('following', DID, row(slice(['a']), 0), 1000)

    expect(events).toEqual([{did: DID, uris: [uri('a')], seenAt: 1000}])
    expect(hasRecordedSeen(DID, uri('a'))).toBe(true)
  })

  it('records nothing while only the context of a reply was seen', () => {
    const unit = slice(['root', 'parent', 'reply'])

    recordSeenFeedRow('following', DID, row(unit, 0))
    recordSeenFeedRow('following', DID, row(unit, 1))

    expect(events).toEqual([])
    expect(hasRecordedSeen(DID, uri('root'))).toBe(false)
  })

  it('records the whole reply unit once the reply was seen', () => {
    const unit = slice(['root', 'parent', 'reply'])

    recordSeenFeedRow('following', DID, row(unit, 0))
    recordSeenFeedRow('following', DID, row(unit, 2), 2000)

    expect(events).toEqual([
      {
        did: DID,
        uris: [uri('root'), uri('parent'), uri('reply')],
        seenAt: 2000,
      },
    ])
  })

  it('leaves out posts hidden behind "view full thread"', () => {
    const unit = slice(['root', 'gap1', 'gap2', 'parent', 'reply'], true)

    recordSeenFeedRow('following', DID, row(unit, 4))

    expect(events[0].uris).toEqual([uri('root'), uri('parent'), uri('reply')])
    expect(hasRecordedSeen(DID, uri('gap1'))).toBe(false)
    expect(hasRecordedSeen(DID, uri('gap2'))).toBe(false)
  })

  it('records a repost by the original post, so a second repost adds nothing', () => {
    // A repost slice holds the original post, whoever reposted it.
    const repostByCarol = slice(['original'])
    const repostByDave = slice(['original'])

    recordSeenFeedRow('following', DID, row(repostByCarol, 0))
    recordSeenFeedRow('following', DID, row(repostByDave, 0))

    expect(events).toHaveLength(1)
    expect(events[0].uris).toEqual([uri('original')])
  })

  it.each([
    ['a custom feed', 'feedgen|at://did:plc:x/app.bsky.feed.generator/y'],
    ['a profile', 'author|did:plc:bob|posts_and_author_threads'],
    ['a list', 'list|at://did:plc:x/app.bsky.graph.list/y'],
    ['no feed (thread or search)', undefined],
  ])('records nothing in %s', (_name, descriptor) => {
    recordSeenFeedRow(descriptor, DID, row(slice(['a']), 0))

    expect(events).toEqual([])
  })

  it('records nothing without an account', () => {
    recordSeenFeedRow('following', undefined, row(slice(['a']), 0))

    expect(events).toEqual([])
  })

  it('ignores rows that are not posts', () => {
    recordSeenFeedRow('following', DID, {type: 'sliceViewFullThread'})
    recordSeenFeedRow('following', DID, {type: 'videoGridRow', items: []})
    recordSeenFeedRow('following', DID, null)

    expect(events).toEqual([])
  })

  it('keeps accounts apart', () => {
    recordSeenFeedRow('following', DID, row(slice(['a']), 0))
    recordSeenFeedRow('following', 'did:plc:other', row(slice(['a']), 0))

    expect(events.map(e => e.did)).toEqual([DID, 'did:plc:other'])
  })
})

describe('getDisplayedSliceItems', () => {
  it('returns every item of a complete thread', () => {
    expect(
      getDisplayedSliceItems({items: [1, 2, 3], isIncompleteThread: false}),
    ).toEqual([1, 2, 3])
  })

  it('returns the root and the last two items of a collapsed thread', () => {
    expect(
      getDisplayedSliceItems({
        items: [1, 2, 3, 4, 5],
        isIncompleteThread: true,
      }),
    ).toEqual([1, 4, 5])
  })
})
