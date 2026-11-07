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

## Upstream files the fork changes

These are the only upstream files Cloudless Sky changes. Expect merge conflicts
in them, and nowhere else.

| File | Change | Story |
| ---- | ------ | ----- |
| `src/lib/strings/headings.ts` | `bskyTitle()` appends `APP_NAME` from `src/features/cloudless/appName.ts` ("Cloudless Sky") in place of the literal "Bluesky". Every page title goes through this function. | 1.1 |
| `src/lib/hooks/__tests__/useSetPostTitle.test.tsx` | The expected titles end in "— Cloudless Sky". | 1.1 |
| `bskyweb/templates/base.html` | The default `<title>` and `application-name` say "Cloudless Sky", and an `apple-mobile-web-app-title` meta tag labels the home-screen icon "Cloudless Sky". | 1.1 |
| `bskyweb/templates/home.html` | The server-rendered title of `/` says "Cloudless Sky". It shows until the app's JavaScript sets the page title. | 1.1 |
| `bskyweb/templates/error.html` | Server error pages are titled `Error {{ statusCode }} - Cloudless Sky`. | 1.1 |

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
