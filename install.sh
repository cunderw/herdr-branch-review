#!/usr/bin/env bash
# Copies the two mods into Herdr's home. A symlinked mod folder loads its JavaScript
# but not its icons, so this copies instead; run it again after pulling.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mods=${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods
for name in branch-review branch-review-open; do
  dest=$mods/$name
  # An older install may be a symlink into a checkout: remove the link, never what it points to.
  if [ -L "$dest" ]; then rm "$dest"; fi
  mkdir -p "$dest"
  rsync -a --delete --exclude gpui-kit.d.ts --exclude jsconfig.json --exclude .DS_Store "$here/mods/$name/" "$dest/"
  herdr-app check "$dest"
done
