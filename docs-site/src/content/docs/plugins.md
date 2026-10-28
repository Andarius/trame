---
title: Plugins
description: Install out-of-tree native plugins by building Trame with them, locally or on GitHub.
---

A Trame plugin is a Rust module and a React frontend in its own GitHub repo. Plugins compile
into the app, so the official releases cannot load one: you need a build that includes it.
There are two ways to get one. Both take plain `owner/repo` links.

| | Your own build (GitHub) | Local build (`tramecli plugins`) |
|---|---|---|
| You need | a GitHub account | git, bun, npm, Rust and the native build libraries |
| Updates | automatic, from your repo's releases | "Update now" rebuilds it (AppImage) |
| Platforms | Linux AppImage and `.deb`, macOS dmg | the machine you build on |

Only native plugins (a `src/mod.rs`) can be composed. Each plugin is fetched at a release tag,
never a branch, and declares the Trame versions it works with (`TRAME` in its `version.ts`). A
build stops when a plugin's range excludes the Trame being built; pin an older plugin tag
(`owner/repo@v1.2.0`) or wait for the plugin's next release.

## Your own build

Create a repository with two files. `plugins.json` lists the plugins, each as `owner/repo`
(its latest release) or `owner/repo@tag` (pinned):

```json
{ "plugins": ["Andarius/trame-notebook-cells", "someone/trame-other@v1.2.0"] }
```

`.github/workflows/trame.yml` calls Trame's reusable workflow every night:

```yaml
name: Trame
on:
  schedule: [{ cron: "0 4 * * *" }]
  workflow_dispatch:
concurrency: trame-compose
jobs:
  build:
    uses: Andarius/trame/.github/workflows/compose.yml@master
    permissions:
      contents: write
    # with:
    #   macos: false
    # secrets:
    #   plugins-token: ${{ secrets.PLUGINS_TOKEN }}   # to read private plugin repos
```

Run it once from the Actions tab. It builds Trame's latest release with the plugins and
publishes a release in your repository, tagged `v<trame version>-<n>`. Install the AppImage,
`.deb` or dmg from that release. Every later run rebuilds only when Trame or a plugin cut a new
release, and your installed app updates itself from your repository's releases, the same way
the official build does.

Plugin code runs during the build with a read-only token; only the final job, which uploads
the release, can write to your repository.

## Local build

```bash
tramecli plugins add Andarius/trame-notebook-cells   # adds it to the list and builds
tramecli plugins build                               # rebuild later, e.g. after an upgrade
```

The build clones Trame at your `tramecli` version into `~/.cache/trame/build` and prints the
path of the AppImage (`--deb` for a package, a dmg on macOS). Install it in place of your
current Trame. The AppImage then updates by rebuilding itself: when Trame or an unpinned plugin
has a new release, Trame offers the update, and "Update now" runs
`tramecli plugins build --latest --install=<the AppImage>` (a few minutes, same toolchain;
log in `~/.local/share/trame/plugins-build.log`). Restart to run it. Other formats: rerun
`tramecli plugins build` yourself.

A private plugin repo builds with your `gh` login (`gh auth token`) when `GITHUB_TOKEN` is unset.

On Ubuntu, the native build needs:

```bash
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libxdo-dev libssl-dev
```

Writing a plugin: see the `trame-plugin` agent skill (`tramecli setup --claude`).
