import {bskyTitle} from '#/lib/strings/headings'

describe('page titles', () => {
  it('appends the app name to the page name', () => {
    expect(bskyTitle('Home')).toBe('Home — Cloudless Sky')
  })

  it('keeps the unread-count prefix', () => {
    expect(bskyTitle('Home', '3')).toBe('(3) Home — Cloudless Sky')
    expect(bskyTitle('Notifications', '30+')).toBe(
      '(30+) Notifications — Cloudless Sky',
    )
  })
})
