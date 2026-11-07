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

1. Set up the toolchain and dependencies:

   ```bash
   source ~/.nvm/nvm.sh && nvm install && nvm use
   pnpm install
   ```

   `.nvmrc` and `devEngines` can change upstream, so run `nvm install` every
   time.

2. Run the checks and compare them with the baseline results recorded in
   this guide. A failure that the baseline does not list is new. Find out whether it comes from upstream (it also fails on a
   clean `upstream/main`) or from the fork.

   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

3. Start the app and check the title, sign-in and the Following feed:

   ```bash
   pnpm web
   ```

4. Check that the modified-files list still matches the code:

   ```bash
   git diff --name-status upstream/main HEAD
   ```

   Lines marked `M` (or `D`) are upstream files the fork changes; they must
   match the list below exactly. Lines marked `A` are fork-only files.

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
