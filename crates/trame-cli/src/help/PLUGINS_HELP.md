tramecli plugins — build Trame with native plugins from their GitHub repos

  tramecli plugins                         list the plugins in your build list
  tramecli plugins add owner/repo[@tag]…   add (or re-pin) plugins, then build
  tramecli plugins remove owner/repo…      drop plugins, then build
  tramecli plugins build                   rebuild from the list (after a plugin or Trame release)
    --no-build                             with add/remove: only edit the list
    --deb                                  build a .deb instead of the AppImage (Linux)
    --latest                               build Trame's latest release, not this binary's
    --install=PATH                         then replace the AppImage at PATH (restart to run it)

Plugins compile into Trame, so this builds the app from source: it clones Trame at this
binary's release into ~/.cache/trame/build, fetches each plugin at its tag (no tag = its
latest release) and runs the release build. The list lives in ~/.local/share/trame/plugins.json.
The first build takes about ten minutes and needs git, bun, npm and a Rust toolchain; on
Linux also the WebKitGTK build libraries listed in the docs ("Plugins" page).

The AppImage updates itself by rebuilding: when Trame or an unpinned plugin has a new release,
"Update now" runs `tramecli plugins build --latest --install=<this AppImage>` (a few minutes,
same toolchain). To get updates without a toolchain, let GitHub build it for you: see the
docs' "Plugins" page, "Your own build".
