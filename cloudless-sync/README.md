# cloudless-sync

The Cloudless Sky seen-list service (Story 4.1). It keeps one seen list per
Bluesky account, so every device on the tailnet hides the same posts. The app
syncs with it from `src/features/cloudless/sync/` (Story 4.2). Deployment is
covered in "Deploying and updating" in
[`docs/cloudless-sky.md`](../docs/cloudless-sky.md).

It is its own pnpm workspace with its own lockfile. The app's `pnpm install`,
`typecheck`, `lint` and `test` leave it out.

## API

Every route answers both under `/sync` and at the root, because Tailscale
Serve's `--set-path /sync` strips the prefix before proxying.

- `POST /sync/seen` with `{did, entries: [{uri, seenAt}]}` (at most 1,000
  entries; `seenAt` in milliseconds) stores the batch, keeping the later
  `seenAt` per post, and returns `{serverTime}`.
- `GET /sync/seen?did=…&since=…&cursor=…` returns `{entries, serverTime,
  cursor?}`: entries added or seen later after `since`, 5,000 per page.
  Follow `cursor` until it is absent, then pass that page's `serverTime` as
  `since` next time.
- `GET /sync/health` returns `{status: "ok"}`.

Each account keeps at most 100,000 entries (`SEEN_LIST_LIMIT`, the same as the
app's); past that, the posts seen longest ago are dropped. Responses are
gzipped. A malformed request gets `400` (`413` for a body over 512 KB) with
`{error, message}` and changes nothing.

`serverTime` is a logical clock, not wall time: it starts at the later of now
and the largest stored value and rises with every write batch, so a device's
`since` stays valid when the system clock steps back.

## Commands

Use Node 24.22 (`nvm use` at the repo root) with pnpm through corepack.

```bash
cd cloudless-sync
pnpm install
pnpm test        # node:test, with Node's TypeScript type stripping
pnpm typecheck
pnpm build       # dist/
pnpm dev         # dev mode on 127.0.0.1:8101, database in data/
```

## Settings

| Variable | Default | |
| -------- | ------- | - |
| `CLOUDLESS_SYNC_HOST` | `127.0.0.1` | The container sets `0.0.0.0`; Compose publishes it on the host's loopback only. |
| `CLOUDLESS_SYNC_PORT` | `8101` | |
| `CLOUDLESS_SYNC_DB` | `data/seen.sqlite` | The container uses `/app/data/seen.sqlite` on the `sync-data` volume. |
| `CLOUDLESS_SYNC_DEV` | off | `1` (or `--dev`) allows CORS from `http://localhost:*` and `http://127.0.0.1:*` and logs every request. Never set in production. |

SQLite comes from Node's built-in `node:sqlite`, which needs no native build
and prints no experimental warning on Node 24.22.
