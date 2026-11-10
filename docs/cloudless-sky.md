# Cloudless Sky fork guide

Cloudless Sky is a personal fork of the official Bluesky client
([bluesky-social/social-app](https://github.com/bluesky-social/social-app)). It
runs as a private web app and adds features to the Following feed, such as
hiding posts you have already read.

This guide covers how the fork is laid out, how to bring in upstream changes,
and which upstream files the fork changes on purpose.

## Where the fork's code lives

All Cloudless Sky feature code lives in **`src/features/cloudless/`**. This
includes all feature code for Epics 2–4. `AGENTS.md` asks for cross-cutting
modules to go in `src/features/<name>` and for no new top-level `src/` folders.
Keeping everything in one folder means upstream merges rarely touch fork code.

Rules for fork code:

- New fork code goes in `src/features/cloudless/`. Upstream files change only
  where the fork must hook in. Keep each hook small (an import plus a call),
  and put the logic in the feature folder.
- Every upstream file the fork changes is listed in
  [Upstream files the fork changes](#upstream-files-the-fork-changes). Update
  that list in the same commit as the change.
- Fork-only docs live in this file. The upstream docs (`docs/build.md`,
  `AGENTS.md`) stay as upstream ships them.

**Likely conflict area for Epic 2:** upstream already has
`src/features/followingV2/`, which changes the home screen and the Following
feed. Epic 2 works on the same screens. Expect upstream changes there and check
them before each sync.

## Remotes

| Remote     | URL                                             | Purpose                   |
| ---------- | ----------------------------------------------- | ------------------------- |
| `origin`   | `https://github.com/ngittlen/cloudless-sky.git` | The fork                  |
| `upstream` | `https://github.com/bluesky-social/social-app.git` | The official Bluesky app |

In a fresh clone of the fork, add the upstream remote once:

```bash
git remote add upstream https://github.com/bluesky-social/social-app.git
git fetch upstream
```

The fork starts at upstream commit `cb5888730` ("Nightly source-language
update").

## Bringing in upstream changes

Use a merge, not a rebase. A merge keeps `origin` history stable and records
each sync as one merge commit.

```bash
git checkout main
git pull origin main
git fetch upstream
git log --oneline main..upstream/main   # what is coming in
git merge upstream/main
```

Conflicts are expected only in the files listed under
[Upstream files the fork changes](#upstream-files-the-fork-changes). For each
one, take the upstream version and then re-apply the fork's small change. A
conflict in any other file means the list is out of date or a fork change has
leaked outside the feature folder. Fix the list or move the change before
going on.

To preview conflicts before merging, without touching the working tree:

```bash
git merge-tree --write-tree --name-only HEAD upstream/main
```

The first line is the merged tree ID. On a conflict, the lines after it (up to
the first blank line) name the conflicted files, followed by `CONFLICT`
messages. The exit status is `0` for a clean merge and `1` when there are
conflicts.

### Nightly sync pull request

The workflow `.github/workflows/cloudless-upstream-sync.yml` runs every night
at 04:00 UTC, after upstream's own nightly jobs, and can also be started by hand
from the Actions tab. When upstream's `main` has commits the fork's `main`
lacks, it pushes upstream's `main` to the `upstream-sync` branch and opens a
pull request into `main`, or updates the one already open. The description
lists the incoming commits, whether GitHub can merge them without conflicts,
and which [upstream files the fork changes](#upstream-files-the-fork-changes)
upstream touched.

- **Merge it with "Create a merge commit"**, never squash or rebase. Only a
  merge commit records that upstream's commits are in `main`; otherwise the
  next sync brings them in again and conflicts.
- **When it has conflicts**, merge locally as above (`git merge upstream/main`
  or `git merge origin/upstream-sync`), push `main`, and the pull request
  closes as merged.
- Either way, go through [After the merge](#after-the-merge) before
  redeploying.

The workflow needs a repository secret named `UPSTREAM_SYNC_TOKEN`: a
fine-grained personal access token limited to this repository, with
**Contents**, **Pull requests** and **Workflows** set to read and write. The
built-in `GITHUB_TOKEN` can't push commits that change files under
`.github/workflows`, and upstream changes them often. The repository's Actions
setting "Allow GitHub Actions to create and approve pull requests" is not
needed, because the token is a personal one.

### After the merge

1. Set up the toolchain and dependencies with the commands in
   [Toolchain and dependencies](#toolchain-and-dependencies). `.nvmrc` and
   `devEngines` can change upstream, so run all of them every time, including
   `nvm install` and `corepack enable`.

2. If the merge changed any `src/locale/locales/*/messages.po` file, refresh
   the compiled catalogs (see [Translations](#translations)).

3. Run the [checks](#checks) and compare them with the
   [baseline](#baseline-check-results). A failure that the baseline does not
   list is new. Find out whether it comes from upstream (it also fails on a
   clean `upstream/main`) or from the fork.

4. Start the app with `pnpm web` and go through
   [Start the app](#start-the-app) and [Signing in](#signing-in): the title,
   sign-in and the Following feed.

5. Check that the modified-files list still matches the code:

   ```bash
   git diff --name-status upstream/main HEAD
   ```

   Lines marked `M` (or `D`) are upstream files the fork changes; they must
   match [Upstream files the fork changes](#upstream-files-the-fork-changes)
   exactly. Lines marked `A` are fork-only files.

6. Push to `origin` and redeploy (see
   [Updating to a new version](#updating-to-a-new-version)).

## Running locally

The dev server runs the app from source with hot reload. Every later story is
built and checked this way.

### Tool versions

| Tool | Version | Source of truth |
| ---- | ------- | --------------- |
| Node.js | 24.22.1 | `.nvmrc`; `package.json` `engines` (`>=24.22.1`) and `devEngines.runtime` (`^24.22.1`) |
| pnpm | 11.28.5 | `package.json` `devEngines.packageManager`, provided by Corepack |
| nvm | any | Installs and switches Node versions |

The default Node through nvm on the dev VM is v26, which is outside `^24`.
Always switch to the repo's version first.

### First-time setup (from a fresh clone)

```bash
git clone https://github.com/ngittlen/cloudless-sky.git
cd cloudless-sky
git remote add upstream https://github.com/bluesky-social/social-app.git
```

Then run the commands in
[Toolchain and dependencies](#toolchain-and-dependencies).

### Toolchain and dependencies

```bash
source ~/.nvm/nvm.sh
nvm install          # installs the Node version in .nvmrc if missing
nvm use              # switches this shell to it
corepack enable      # installs the pnpm shim for this Node version
pnpm install         # the first run asks to download pnpm 11.28.5; answer Y
```

Corepack installs its `pnpm` shim per Node version, so run `corepack enable`
again whenever `nvm install` installs a new Node.

`pnpm install` takes a few minutes on the first run and fills `node_modules`
(about 2 GB). Its `postinstall` step generates the lexicon types and compiles
the translation catalogs if they don't exist yet, so the app is ready to run
afterwards.

No `.env` file is needed for web development. The dev server starts and
serves the app without one. The optional keys `docs/build.md` describes
(Sentry, bitdrift) stay off when unset.

Every new shell needs `source ~/.nvm/nvm.sh && nvm use` before running
`pnpm`. This includes the shell you commit from: the repo's pre-commit hook
(husky + lint-staged) runs `pnpm` and fails with `pnpm: not found` without
it.

### Translations

The compiled translation catalogs (`src/locale/locales/*/messages.ts`) are
gitignored and built from the committed `messages.po` files. `pnpm install`
compiles them only when `src/locale/locales/en/messages.ts` is missing, so
after a merge that changes `.po` files, rebuild them through the same script:

```bash
rm src/locale/locales/en/messages.ts
pnpm intl:compile-if-needed
```

This writes only gitignored files. Don't run `pnpm intl:extract` or
`pnpm intl:compile` directly: `AGENTS.md` reserves extraction and compilation
of the committed catalogs for upstream's nightly CI job. The container build
compiles the catalogs itself.

### Start the app

```bash
pnpm web
```

This runs `expo start --web`. When Metro prints `Waiting on
http://localhost:8081`, open <http://localhost:8081> in a desktop browser.
The first page load takes about 15 seconds while Metro bundles the app.
The dev server listens on all interfaces, so from the Mac (outside the
OrbStack VM) `http://localhost:8081` also works, as does
`http://<vm-name>.orb.local:8081`.

The browser tab reads "Home — Cloudless Sky" once the app loads, with an
unread-notification count in front when there is one, for example
"(3) Home — Cloudless Sky".

If bundling fails with `ENOENT ... node_modules/react-native-worklets/.worklets/<number>.js`,
restart with a cleared Metro cache:

```bash
pnpm web --clear
```

The worklets Babel plugin writes generated files into
`node_modules/react-native-worklets/.worklets/`, but Metro's transform cache
lives outside the repo, in the system temp directory (`/tmp/metro-cache` on
Linux), and is shared by every checkout on the machine. After a second clone, or after `node_modules` is reinstalled,
Metro can reuse a cached transform whose generated file doesn't exist in this
`node_modules`.

### Syncing seen posts in development

`pnpm web` doesn't sync the seen list unless it is told where the sync
service is, because the dev server runs on a different origin from
production's `/sync`. To try sync locally, run the service in dev mode (it
allows CORS from `http://localhost:*`) and point the app at it:

```bash
cd cloudless-sync && pnpm install && pnpm dev     # 127.0.0.1:8101, data in cloudless-sync/data/
EXPO_PUBLIC_CLOUDLESS_SYNC_URL=http://localhost:8101/sync pnpm web
```

Open the app at `http://localhost:8081` (not the `.orb.local` name, whose
origin dev-mode CORS doesn't allow). The browser console logs every sync:
`[cloudless] seen sync: synced` with what was received and sent, `pushed on
hide`, and `sync failed` with the retry delay.

### Signing in

Sign in with your handle and a Bluesky **app password**, not your main
password:

1. On bsky.app (or in the official app), go to **Settings → Privacy and
   security → App passwords** and add one, for example named
   `cloudless-sky-dev`.
2. Leave **Allow access to your direct messages** off unless you need DMs in
   Cloudless Sky.
3. In Cloudless Sky, choose **Sign in**, keep the hosting provider as
   Bluesky Social, and enter your handle and the app password.

An app password signs in through the same path as a normal password
(`createSessionBundleAndLogin` in `src/state/session/session-core.ts`). It
can be revoked at any time from the same settings page without changing your
main password. It can't change your email or password, delete the account,
or manage app passwords, but it can do everything else the app does, such as
posting, following and changing preferences.

### Checks

```bash
pnpm typecheck   # TypeScript, for the iOS, Android and web configurations
pnpm lint        # oxlint, plus the Sentry browser-version check
pnpm test        # Jest
```

Always use these scripts rather than calling the tools directly. `pnpm test`
runs Jest with `--bail`, so it stops at the first failing suite. To run
specific tests, pass paths: `pnpm test src/features/cloudless`.

The seen-list sync service in `cloudless-sync/` is a separate pnpm workspace
that these checks leave out (root Jest and oxlint ignore the folder, and
`typecheck` only covers `src` and `modules`). Check it on its own:

```bash
cd cloudless-sync
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

### Baseline check results

Results on untouched upstream `cb5888730`, with Node 24.22.1 and pnpm
11.28.5 on the ARM64 Linux dev VM:

| Check | Result |
| ----- | ------ |
| `pnpm typecheck` | Pass (iOS, Android and web configurations), about 8 s |
| `pnpm lint` | Pass: no oxlint errors (`--quiet` hides warnings), and `check-sentry-browser-version: OK (10.74.0)` |
| `pnpm test` | Pass: 186 suites, 2494 tests passed, 28 todo, 21 snapshots, about 20 s |

Upstream failures: none. `pnpm test` prints a Jest warning ("A worker process
has failed to exit gracefully and has been force exited") and "Force exiting
Jest". Both come from upstream and don't affect the result.

Compare pass and fail, not counts. The fork adds its own test suites under
`src/features/cloudless/`, and every upstream merge changes the totals. When a
merge brings in a new upstream failure, record it here with the upstream
commit it first appears in.

## Building and running the container

Production runs one container image built from the upstream `Dockerfile`. It
has three stages:

1. **web-build** (`ghcr.io/pnpm/pnpm:11`): `pnpm install --frozen-lockfile`,
   `pnpm intl:build`, then `pnpm build-web`. The Metro web export lands in
   `dist/`, and `scripts/post-web-build.js` copies it into `bskyweb/static`
   and writes `bskyweb/templates/scripts.html` and `fonts.html`.
2. **go-build** (`golang:1.26.10-bookworm`): compiles the `bskyweb` Go server
   with the templates and static files embedded.
3. **runtime** (`debian:bookworm-slim`): runs `/usr/bin/bskyweb` under
   `dumb-init`.

All three base images publish `linux/arm64` builds (checked against the
registries). The Go stage builds for Docker's `TARGETARCH`, the architecture
of the image being built. It defaults to the build host's, so a plain
`docker build` on the Apple M4 host produces a native arm64 image with no x86
emulation. Don't pass `--platform linux/amd64`.

### Build

From the repo root, on a machine with Docker Engine (BuildKit, the default
builder, is required for `TARGETARCH` and the `RUN --mount` cache):

```bash
docker build -t cloudless-sky:latest \
  --build-arg EXPO_PUBLIC_ENV=production \
  --build-arg EXPO_PUBLIC_BUNDLE_IDENTIFIER="$(git rev-parse --short HEAD)" \
  .
```

`EXPO_PUBLIC_BUNDLE_IDENTIFIER` is optional. It shows the commit in the app's
settings (**Settings → About**); without it the app shows `dev`. The release
version comes from `package.json`.

The `.dockerignore` (fork-only) keeps `.git`, `node_modules`, `.env*` files
and locally generated web and embed build output out of the build context, so
a build from a working copy that has run `pnpm install` or `pnpm build-web`
produces the same image as a fresh clone.

**Memory:** the Dockerfile sets `NODE_OPTIONS=--max-old-space-size=8192`
because Metro's web export runs out of heap at Node's default. A local
`pnpm build-web` on the ARM64 dev VM took about 2 minutes and peaked at about
7.8 GB resident memory. Give Docker at least 8 GB for the build itself, plus
headroom for everything else running on the host; with less, the build fails
with a V8 out-of-memory error or the kernel kills it. The Docker build adds
`pnpm install` and `pnpm intl:build` in front, so expect roughly 5 to 10
minutes in total.

### Build arguments

| Argument | Value | Why |
| -------- | ----- | --- |
| `EXPO_PUBLIC_ENV` | `production` | The Dockerfile defaults to `development`. On web, the only code that reads it is the Sentry setup (the environment label), and Sentry is off. `__DEV__` is `false` in an export either way. `production` matches the official bsky.app build. |
| `EXPO_PUBLIC_SENTRY_DSN` | leave unset | Sentry error reporting is off when the DSN is empty. |
| `SENTRY_AUTH_TOKEN` | leave unset | The Dockerfile defaults it to `unknown`, so `post-web-build.js` skips uploading source maps to Sentry. |
| `EXPO_PUBLIC_BUNDLE_IDENTIFIER` | commit hash (optional) | Shown in the app's settings. |

The Dockerfile has no argument for `EXPO_PUBLIC_METRICS_API_HOST`, so the
image never sets it and usage metrics stay off (see
[Analytics and error reporting](#analytics-and-error-reporting)).

### Run

```bash
docker run --rm --name cloudless-sky \
  -p 127.0.0.1:8100:8100 \
  -e ATP_APPVIEW_HOST=https://public.api.bsky.app \
  -e ROBOTS_DISALLOW_ALL=true \
  cloudless-sky:latest /usr/bin/bskyweb serve
```

Then open <http://localhost:8100>. The image's default command runs
`bskyweb` with no subcommand, which prints its help and exits, so the run
command must end in `/usr/bin/bskyweb serve`. The deployment runs the same
settings from a Compose file (see [Deploying and updating](#deploying-and-updating)).

### Runtime settings

| Variable | Value | Why |
| -------- | ----- | --- |
| `ATP_APPVIEW_HOST` | `https://public.api.bsky.app` | Bluesky's public AppView. The server fetches posts and profiles from it to render link previews and titles for direct links. Its default, `http://localhost:2584`, only exists in a local atproto dev environment. |
| `HTTP_ADDRESS` | default `:8100` | Listens on all interfaces inside the container, which Docker's port publishing needs. Restrict access on the host side by publishing to `127.0.0.1` only. |
| `ROBOTS_DISALLOW_ALL` | `true` | `/robots.txt` disallows all crawling. |
| `BSKY_APP_VERSION` | leave unset | When set, the server loads the app from Bluesky's S3 bucket in place of the embedded build. |
| `FEATURE_GATE_BOOTSTRAP` | default `true` | The server fetches feature flags from `GROWTHBOOK_API_HOST` (default `https://events.bsky.app/gb`) and embeds them in the HTML, so pages render with the right flags before the client fetches them. |
| `BASIC_AUTH_PASSWORD` | optional | Puts HTTP basic auth (username `admin`) in front of every route. The tailnet already limits who can reach the app. |

`bskyweb` also serves Prometheus metrics on `:9090` inside the container
(`METRICS_HTTP_ADDRESS`). Those are local server metrics, not sent anywhere,
and the run command doesn't publish the port.

There is no dedicated health endpoint. Use `GET /robots.txt` (or `GET /`) to
check that the server is up. With `BASIC_AUTH_PASSWORD` set, these return
`401` without credentials, which still shows the server is responding.

### Analytics and error reporting

Cloudless Sky sends no usage analytics or error reports to Bluesky:

- **Usage metrics** (`POST https://events.bsky.app/t`): upstream sends them
  whenever `EXPO_PUBLIC_METRICS_API_HOST` is unset, because the host falls
  back to `events.bsky.app`. Unless that variable is set,
  `src/features/cloudless/metrics.ts` turns the metrics client's `track` and
  its send path into no-ops, so the client never queues an event, starts its
  flush timer or sends a request. This applies to `pnpm web` too. A test in
  `src/features/cloudless/__tests__/metrics.test.ts` fails when upstream adds
  or renames a `MetricsClient` method, as a prompt to check the policy still
  covers every send path.
- **Sentry**: off while `EXPO_PUBLIC_SENTRY_DSN` is empty (and always in
  `__DEV__`).
- **bitdrift**: not part of the web app. Only the native build config
  (`app.config.js`) includes it.

**Feature flags stay on.** Bluesky's GrowthBook flags decide which app
features are enabled. The app keeps fetching them from
`https://events.bsky.app/gb/...`, and `bskyweb` keeps embedding them in the
HTML. The app's flag host defaults to `<metrics host>/gb`, which is
`https://events.bsky.app/gb` while `EXPO_PUBLIC_METRICS_API_HOST` is unset. If
you ever set a metrics host, also set
`EXPO_PUBLIC_GROWTHBOOK_API_HOST=https://events.bsky.app/gb`. Otherwise the
app looks for flags on your metrics host, and it rejects the flags `bskyweb`
embeds because their host no longer matches.

To check in a browser: open the network panel, sign in and scroll for a
minute. Expect requests to the PDS and AppView, `events.bsky.app/gb/...`
(feature flags), `ip.bsky.app` (region-based defaults),
`app-config.workers.bsky.app` and `live-events.workers.bsky.app`
(configuration), and media CDNs. There should be no requests to
`events.bsky.app/t` and none to `sentry.io`.

### Running the production build without Docker

To check a production build on a machine without Docker (this is how the
build was verified on the dev VM), build the web bundle and the Go server
directly. This needs Go 1.26.10 (the version in `bskyweb/go.mod`) and a C
compiler for the SQLite driver:

```bash
NODE_OPTIONS=--max-old-space-size=8192 EXPO_PUBLIC_ENV=production pnpm build-web
cd bskyweb
go build -trimpath -tags timetzdata -o bskyweb ./cmd/bskyweb
ATP_APPVIEW_HOST=https://public.api.bsky.app HTTP_ADDRESS=127.0.0.1:8100 \
  ROBOTS_DISALLOW_ALL=true ./bskyweb serve
```

The build output and the binary are gitignored.

## Deploying and updating

Cloudless Sky runs on its own OrbStack Linux machine (VM) named
`cloudless-sky` on the M4 Mac. The machine runs Docker Engine and Tailscale.
It joins the tailnet as the device `cloudless-sky`, and Tailscale Serve
publishes the app at `https://cloudless-sky.<tailnet>.ts.net` (for this
tailnet, `https://cloudless-sky.tail8e6d2.ts.net`). Only devices on the
tailnet can reach it.

```
iPhone / Mac (on the tailnet)
  └─ https://cloudless-sky.<tailnet>.ts.net        (Tailscale cert)
       └─ tailscale serve on the cloudless-sky VM
            ├─ /      → http://127.0.0.1:8100        (published on loopback only)
            │            └─ container "web": bskyweb serve   (restart: unless-stopped)
            └─ /sync  → http://127.0.0.1:8101/sync   (published on loopback only)
                         └─ container "sync": cloudless-sync (restart: unless-stopped)
                              └─ volume "sync-data": seen.sqlite
```

The `sync` container is the seen-list service from `cloudless-sync/`
(Story 4.1): one seen list per Bluesky account, shared by every device, so a
post read on one device is hidden on the others. The app and the service share
one origin, so the browser needs no CORS setup. There is no login of its own:
being on the tailnet is the only access control, as for the app.

The production web build syncs with `/sync` on its own origin (Story 4.2,
`src/features/cloudless/sync/`): on open, every 30 seconds while visible, a
few seconds after posts are seen, and when the app is hidden. Posts seen on
another device are hidden from the next refresh of Following on. Opening the
app through `http://localhost:8100` on the Mac skips Tailscale Serve, so
`/sync` reaches `bskyweb` instead and sync fails quietly there; use the
tailnet address.

The container's settings live in `compose.cloudless.yaml` at the repo root:
the build arguments and runtime settings from
[Building and running the container](#building-and-running-the-container),
the `restart: unless-stopped` policy, and a port binding to `127.0.0.1` only,
so nothing on the network reaches the container directly and tailnet devices
come in through Tailscale Serve. OrbStack also forwards the VM's ports to
`localhost` on the Mac itself, so `http://localhost:8100` works on that Mac.
That is local to the Mac, not a network exposure. Keep OrbStack's option to
expose machine ports to the LAN off. Don't run another server on port 8100 or
8101 in the dev VM at the same time, or the Mac's `localhost:8100` (or `8101`)
may reach the wrong one.

The sync service's settings are in the same file: built from
`Dockerfile.cloudless-sync`, `restart: unless-stopped`, port `8101` on
`127.0.0.1` only, and its SQLite database on the named volume `sync-data`
(Docker names it `cloudless-sky_sync-data`). A named volume outlives the
container, so rebuilding, `up -d --build`, `down` and restarts keep the data.
Only `docker compose down -v` or `docker volume rm` deletes it, so never pass
`-v`. The image uses Node's built-in SQLite (`node:sqlite`), so nothing is
compiled natively and it builds natively on arm64.

### One-time setup

**1. On the Mac: OrbStack settings.**

- **Settings → General → Start at login**: on, so OrbStack and its machines
  come back after the Mac restarts and someone logs in. OrbStack runs in a
  user session, so nothing starts until a user logs in. With FileVault on,
  macOS can't log in automatically, so after a power cut or an unattended
  update the app stays down until you log in on the Mac. Automatic login
  (System Settings → Users & Groups) closes that gap but requires turning
  FileVault off; that trade-off is yours to make.
- **Settings → System → Memory limit**: OrbStack machines share one memory
  limit; there is no per-machine setting. The image build needs about 8 GB on
  top of whatever else is running (other machines, containers), so set the
  limit to at least 12 GB.

**2. In the Tailscale admin console** (<https://login.tailscale.com/admin/dns>):
MagicDNS and HTTPS Certificates must both be on. This tailnet already has them
(the dev VM has a certificate domain), so this is a check, not a change.

**3. On the Mac: create the machine.**

```bash
orb create ubuntu:noble cloudless-sky
orb -m cloudless-sky          # opens a shell in it (or: ssh cloudless-sky@orb)
```

The machine uses the Mac's architecture (arm64), and its hostname is
`cloudless-sky`. Run all of the following inside that shell.

**4. Install Docker Engine and start it at boot.**

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker.service containerd.service
sudo usermod -aG docker "$USER"
exit
```

Reopen the shell (`orb -m cloudless-sky`) so the `docker` group applies, then
check:

```bash
docker run --rm hello-world
docker compose version
```

**5. Install Tailscale and join the tailnet as `cloudless-sky`.**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up --hostname=cloudless-sky
```

Open the login URL it prints and approve the device. Then, in the admin
console's **Machines** page, open `cloudless-sky` and choose **Disable key
expiry**, so the server doesn't drop off the tailnet when its node key
expires (180 days by default).

**6. Get the code, build and start.** `git clone` checks out `origin`'s
default branch (`main`), so first merge the fork's work into `main` and push
it to `origin`. The clone must contain `compose.cloudless.yaml`.

```bash
git clone https://github.com/ngittlen/cloudless-sky.git ~/cloudless-sky
cd ~/cloudless-sky
docker compose -f compose.cloudless.yaml config --quiet   # checks the file
CLOUDLESS_COMMIT=$(git rev-parse --short HEAD) \
  docker compose -f compose.cloudless.yaml up -d --build
```

The first build takes several minutes (see the memory notes in
[Build](#build)). Check that both servers answer:

```bash
curl -fsS http://127.0.0.1:8100/robots.txt
curl -fsS http://127.0.0.1:8101/sync/health   # {"status":"ok"}
docker compose -f compose.cloudless.yaml ps   # sync shows (healthy) after ~30 s
```

**7. Publish it on the tailnet over HTTPS.**

```bash
sudo tailscale serve --bg 8100
sudo tailscale serve --bg --set-path /sync http://127.0.0.1:8101/sync
tailscale serve status
```

`--bg` stores the Serve configuration in `tailscaled`, so it survives
restarts. The first command proxies `https://cloudless-sky.<tailnet>.ts.net`
to `http://127.0.0.1:8100` with a certificate Tailscale issues automatically.
The second sends everything under `/sync` to the sync service. Tailscale
strips the `/sync` mount point and then appends the rest of the path to the
target URL, so `/sync/seen` reaches `http://127.0.0.1:8101/sync/seen`. The
service answers both with and without the `/sync` prefix, so a target of plain
`http://127.0.0.1:8101` works too. `tailscale serve status` should list both
`/` and `/sync`. If you deployed before the sync service existed, run just the
second command.
The first HTTPS request can take a few seconds while the certificate is
issued. This is Tailscale **Serve** (tailnet only), not Funnel: nothing is
exposed to the public internet.

### Checking the deployment

- **From a device on the tailnet**, open
  `https://cloudless-sky.<tailnet>.ts.net`: no certificate warning, and the
  tab title reads "Home — Cloudless Sky".
- **Sync service, from a device on the tailnet:** open
  `https://cloudless-sky.<tailnet>.ts.net/sync/health`. It shows
  `{"status":"ok"}`.
- **From a device not on the tailnet** (for example the iPhone with
  Tailscale turned off, on cellular), the address doesn't load, `/sync`
  included: the `ts.net` name only resolves to a tailnet address, which is
  unreachable from outside.
- **VM restart:** on the Mac, run `orb restart cloudless-sky`, wait a minute,
  then load the address again. Docker starts at boot, `restart:
  unless-stopped` starts the container, and `tailscaled` restores the Serve
  configuration. `/sync/health` answers again, and the seen list is intact
  (the same posts stay hidden after a refresh).
- **Mac restart:** restart the Mac and log in (see the FileVault note in
  step 1). OrbStack starts at login and starts the machine with it. If the app isn't back within a few minutes,
  check `orb list` on the Mac: if `cloudless-sky` is stopped, start it with
  `orb start cloudless-sky` and report it, because then OrbStack isn't
  restoring the machine at login on this setup.

Inside the VM, useful commands:

```bash
cd ~/cloudless-sky
docker compose -f compose.cloudless.yaml ps        # status
docker compose -f compose.cloudless.yaml logs -f   # server logs
docker compose -f compose.cloudless.yaml logs -f sync   # sync service only
tailscale serve status                             # what Serve publishes
docker volume ls                                   # cloudless-sky_sync-data
```

The sync service has no backup. If its volume is lost, each device keeps its
own list, but entries a device has already sent are not sent again, so
devices stop sharing older history until new posts are seen. To copy the
database out, stop the service first so the file is consistent:

```bash
docker compose -f compose.cloudless.yaml stop sync
docker run --rm -v cloudless-sky_sync-data:/data -v "$PWD":/out alpine \
  cp /data/seen.sqlite /out/seen-backup.sqlite
docker compose -f compose.cloudless.yaml start sync
```

**Seen-list sync** (needs two devices or browsers signed in to the same
account, on the tailnet):

1. On device A, scroll Following until some posts have been on screen.
2. Within about a minute, refresh Following on device B (pull down, or tap
   the Following tab). Those posts are hidden there, and showing seen posts
   (the eye button) shows them with the "Seen" badge. Posts that sync brings
   in never vanish from a feed that is already on screen; only the refresh
   hides them.
3. The same works between iPhone Safari and the iPhone home-screen app,
   which keep separate local lists.
4. Turn Tailscale off on device A, scroll some more, then turn it back on and
   reopen the app. Within a minute, device B hides those posts after a
   refresh too.
5. With two accounts on one device, switch between them: each account's seen
   posts stay its own.

### Adding it to the iPhone home screen

1. Install the Tailscale app on the iPhone, sign in to the same tailnet and
   connect.
2. In Safari, open `https://cloudless-sky.<tailnet>.ts.net`.
3. Tap **Share → Add to Home Screen**. The name is already "Cloudless Sky"
   (from the `apple-mobile-web-app-title` tag). If iOS shows an **Open as Web
   App** switch, leave it on. Tap **Add**.
4. Open it from the home screen. It opens full-screen without Safari's address
   bar (from the `apple-mobile-web-app-capable` tag). Sign in with an app
   password (see [Signing in](#signing-in)). The bottom tab bar sits above
   the home indicator (the swipe-up bar), and the header sits below the
   status bar.
5. Close the app from the app switcher and reopen it: you are still signed
   in.

iOS keeps a home-screen web app's storage separate from Safari's, so signing
in (and anything else stored in the browser) in one doesn't carry over to the
other. Safari can clear storage for sites you haven't visited in a while;
home-screen web apps are exempt. Prefer the home-screen app.

Tailscale must be connected on the iPhone for the app to load.

### Updating to a new version

After merging upstream changes or fork changes into `main` and pushing to
`origin` (see [Bringing in upstream changes](#bringing-in-upstream-changes)),
in the VM:

```bash
cd ~/cloudless-sky
git checkout main
git pull --ff-only
docker tag cloudless-sky:latest cloudless-sky:previous
docker tag cloudless-sync:latest cloudless-sync:previous   # skip on its first deploy
CLOUDLESS_COMMIT=$(git rev-parse --short HEAD) \
  docker compose -f compose.cloudless.yaml up -d --build
docker image prune -f
curl -fsS http://127.0.0.1:8100/robots.txt
curl -fsS http://127.0.0.1:8101/sync/health
```

The sync service's database is on the `sync-data` volume, so the rebuild keeps
it.

The old container keeps serving while the new image builds; Compose then
replaces it, so the app is down for only a few seconds. The `previous` tag
keeps the last working image. `docker image prune -f` removes only untagged
images, which leaves `latest` and `previous` in place. Every few months,
`docker builder prune -f` frees the build cache.

To roll back without rebuilding, point `latest` at the previous image and
recreate the container:

```bash
docker tag cloudless-sky:previous cloudless-sky:latest
docker tag cloudless-sync:previous cloudless-sync:latest
docker compose -f compose.cloudless.yaml up -d
```

Without `--build`, Compose uses the existing `cloudless-sky:latest` image.
The checkout stays on `main`, so the next update works as usual; fix forward
on `main` (or revert the bad commit) before updating again.

The home-screen app picks up the new version on its next full load. If it
looks stale, close it from the app switcher and reopen it.

## Upstream files the fork changes

These are the only upstream files Cloudless Sky changes. Expect merge conflicts
in them, and nowhere else.

| File | Change | Story |
| ---- | ------ | ----- |
| `src/lib/strings/headings.ts` | `bskyTitle()` appends `APP_NAME` from `src/features/cloudless/appName.ts` ("Cloudless Sky") in place of the literal "Bluesky". Every page title goes through this function. | 1.1 |
| `src/lib/hooks/__tests__/useSetPostTitle.test.tsx` | The expected titles end in "— Cloudless Sky". | 1.1 |
| `bskyweb/templates/base.html` | The default `<title>` and `application-name` say "Cloudless Sky", and an `apple-mobile-web-app-title` meta tag labels the home-screen icon "Cloudless Sky" (1.1). `apple-mobile-web-app-capable` and `mobile-web-app-capable` meta tags make the home-screen app open full-screen (1.4). | 1.1, 1.4 |
| `bskyweb/templates/home.html` | The server-rendered title of `/` says "Cloudless Sky". It shows until the app's JavaScript sets the page title. | 1.1 |
| `bskyweb/templates/error.html` | Server error pages are titled `Error {{ statusCode }} - Cloudless Sky`. | 1.1 |
| `Dockerfile` | The Go stage builds for Docker's `TARGETARCH` (`ARG TARGETARCH`, `ENV GOARCH=$TARGETARCH`) in place of a hardcoded `amd64`. | 1.3 |
| `src/analytics/metrics/index.ts` | The shared metrics client is wrapped in `applyMetricsPolicy()` from `src/features/cloudless/metrics.ts`, which turns off usage metrics unless `EXPO_PUBLIC_METRICS_API_HOST` is set. | 1.3 |
| `src/view/shell/bottom-bar/BottomBarWeb.tsx` | The web bottom bar adds the bottom safe-area inset as padding (`useWebBottomBarSafeAreaStyle()` from `src/features/cloudless/safeArea.ts`), so it clears the iPhone home indicator in the full-screen home-screen app. | 1.4 |
| `src/state/feed-feedback.tsx` | `onItemSeen` calls `recordSeenFeedRow()` from `src/features/cloudless/seen` first, before the `enabled` check (which is false for Following). The recorder ignores every feed but Following. The callback's dependency list gains `feed?.feedDescriptor` and `client`. | 2.1 |
| `src/state/queries/post-feed.ts` | `createApi()` is renamed `createBaseApi()`, and a new `createApi()` passes it to `withSeenFiltering()` from `src/features/cloudless/seen/SeenFilteringFeedAPI.ts`, which wraps the Following feed's API in `SeenFilteringFeedAPI` and returns every other feed's API unchanged. The wrapper's `peekLatest()` returns `undefined` when the newest post is already seen, although the `FeedAPI` type promises a post (it uses a cast); `pollLatest()` already checks `if (post)`, so this reads as "nothing new". | 2.3 |
| `src/state/preferences/feed-tuners.tsx` | `useFeedTuners()` appends the hiding tuner from `useHideSeenTuner()` (`src/features/cloudless/seen/context.tsx`) to the Following tuners, after the existing ones, and adds it to the memo's dependencies. List feeds share that branch but don't get the tuner. | 2.3 |
| `src/features/followingV2/home/index.tsx` | The Home route renders the Following v2 fork of Home only when `FOLLOWING_V2_HOME_ALLOWED` (`src/features/cloudless/seen/home.ts`, `false`) is set, so it always renders the legacy Home whatever the remote `following_v2:enable` flag says. Hiding seen posts hooks into the legacy Following data path only. When upstream removes the legacy Home, the hooks must be ported to `src/features/followingV2/home/api/following.ts` and `queries/postFeed.ts`. | 2.3 |
| `src/features/followingV2/home/index.test.tsx` | The "following v2 enabled" case expects the legacy Home. | 2.3 |
| `src/view/screens/Home.tsx` | `HomeScreenReady` is wrapped in `SeenFeedProvider` (`src/features/cloudless/seen/context.tsx`), which provides the hiding state to the feeds and header (2.3). Following's empty state renders `FollowingEmptyStateOrCaughtUp` and its end-of-feed state `renderFollowingEndOfFeed` (`src/features/cloudless/seen/CaughtUp.tsx`), which show "You're all caught up" while seen posts are hidden and the official messages otherwise; the imports of `FollowingEmptyState` and `FollowingEndOfFeed` move there (2.4). | 2.3, 2.4 |
| `src/view/com/home/HomeHeader.tsx` | Computes `showSeenToggle` with `useShowSeenToggle()` (`src/features/cloudless/seen/SeenToggle.tsx`), true while the Following tab is selected in the Home that hides seen posts, and passes it to `HomeHeaderLayout`. | 3.1 |
| `src/view/com/home/HomeHeaderLayout.web.tsx` | `HomeHeaderLayout` takes an optional `showSeenToggle` and passes it to both layouts. The desktop and tablet header renders `HomeHeaderSeenToggle` (the show/hide seen posts eye button) just before the feeds link. It takes no layout space, so the logo stays centered. | 3.1 |
| `src/view/com/home/HomeHeaderLayoutMobile.tsx` | Takes an optional `showSeenToggle` and renders `HomeHeaderSeenToggle` in the slot that holds the feeds link, positioned just left of it. | 3.1 |
| `src/view/com/posts/PostFeed.tsx` | The list's `renderItem` goes through `useSeenAnchorRenderItem()` (`src/features/cloudless/seen/SeenAnchorRow.tsx`), which wraps each Following post row in a `View` that registers its DOM node, so the show/hide toggle can keep the reader's place. Other feeds get `renderItem` unchanged (3.1). Each post row passes `metaAccessory={seenBadgeFor(slice)}` to `PostFeedItem`, where `seenBadgeFor` comes from `useSeenBadgeFor(feed)` (`src/features/cloudless/seen/SeenBadge.tsx`) and is in `renderItem`'s dependencies. It returns the "Seen" badge for units seen as of the snapshot, only in Following and only while seen posts are shown (3.2). | 3.1, 3.2 |
| `src/view/com/posts/PostFeedItem.tsx` | `PostFeedItem` and `FeedItemInner` take an optional `metaAccessory` node. `PostMeta` is wrapped in `PostMetaRow` (`src/features/cloudless/seen/PostMetaRow.tsx`), which renders it unchanged without an accessory and otherwise lays it out in a row with the accessory after it, `PostMeta` keeping `flex: 1`. `PostMeta` itself is unchanged. | 3.2 |
| `package.json` | Jest's `modulePathIgnorePatterns` gains `cloudless-sync/.*` (next to upstream's `bskylink/.*`), so the app's `pnpm test` leaves out the sync service's own `node:test` suites. | 4.1 |
| `.oxlintrc.json` | `ignorePatterns` gains `cloudless-sync/**`. The sync service is a Node project with its own checks; the app's browser-oriented rules (such as `import/no-nodejs-modules`) don't apply to it, and the pre-commit hook would otherwise lint its staged files with them. | 4.1 |

Fork-only files outside `src/features/cloudless/` (no upstream counterpart,
so no content conflicts; an add/add conflict is possible only if upstream
creates a file at the same path):

| File | Purpose | Story |
| ---- | ------- | ----- |
| `docs/cloudless-sky.md` | This guide | 1.1 |
| `.dockerignore` | Keeps `.git`, `node_modules`, `.env*` files, generated build output and the sync service's local database out of the Docker build context | 1.3, 4.1 |
| `compose.cloudless.yaml` | The deployment: build arguments, runtime settings, restart policies, loopback-only ports, and the sync service with its data volume | 1.4, 4.1 |
| `cloudless-sync/` | The seen-list sync service, its own pnpm workspace (see its `README.md`) | 4.1 |
| `Dockerfile.cloudless-sync` | The sync service's image, modeled on `Dockerfile.bskylink` | 4.1 |
| `docs/backlog/epic-*-stories.md` | Planning documents for Epics 1–4 (if committed) | – |

Upstream files deliberately left unchanged:

- `app.config.js`: the native app name (`Bluesky`) and bundle ID
  (`xyz.blueskyweb.app`) only affect native builds, which the fork does not
  make.
- `public/index.html`: it has an empty `<title>` that the app fills in, and
  it is only the template for `pnpm web` and the Metro export. Production
  pages come from `bskyweb/templates/base.html`.
- The link-preview `bskyweb` templates (`post.html`, `profile.html`,
  `feed.html`, `starterpack.html`, `chatinvite.html`) and the Open Graph and
  Twitter tags in `base.html` and `home.html` (`og:site_name`, `og:title`,
  `twitter:site` and similar): they still say "Bluesky". Their
  server-rendered titles show only until the app's JavaScript sets the page
  title, and the Open Graph tags only matter for link previews, which a
  private deployment does not produce.
