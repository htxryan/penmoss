#!/usr/bin/env bash
# Search by meaning in the packaged Mac app (T75, A1152): the app's binary as the CLI downloads the
# pinned model (once: the folder is kept between runs), finds a note by meaning, and without the
# model refuses semantic search with exit 7.
#
#   bash .github/scripts/meaning-check.sh <Penmoss.app> [<folder to keep the model in>]
#
# The model folder defaults to ~/Library/Caches/penmoss-ci/models; only huggingface.co and its
# CDN are reached, and only when the pinned revision is not there yet.
set -euo pipefail

app="${1:?usage: meaning-check.sh <Penmoss.app> [<models folder>]}"
models="${2:-$HOME/Library/Caches/penmoss-ci/models}"
bin="$app/Contents/MacOS/Penmoss"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$models" "$work/home" "$work/bare-home"
ln -s "$models" "$work/home/models"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
pm() { PENMOSS_HOME="$work/home" "$bin" --penmoss-cli "$@"; }

pm models fetch
pm models status
git init --quiet --bare --initial-branch=main "$work/notes.git"
pm notebook add "file://$work/notes.git" --name meaning-check >/dev/null
pm new "UPS shutdown" --text "When the power fails the battery keeps the rack up and the guests shut down in order." --no-sync >/dev/null
pm new "Sourdough" --text "Feed the starter flour and water every morning." --no-sync >/dev/null
pm new "Japan trip" --text "Shrines in Kyoto and the rail pass." --no-sync >/dev/null

started=$(date +%s)
found="$(pm search "keep the computers running during a blackout" --mode semantic --limit 1 --no-sync --json)"
echo "$found"
echo "$found" | grep -q '"title": "UPS shutdown"' || { echo "::error::meaning did not find the note"; exit 1; }
echo "$found" | grep -q '"semantic"' || { echo "::error::the hit was not found by meaning"; exit 1; }
hybrid="$(pm search "shrines and trains" --no-sync --json)"
echo "$hybrid" | grep -q '"mode": "hybrid"' || { echo "::error::hybrid did not fuse meaning"; exit 1; }
echo "Searches by meaning took $(( $(date +%s) - started )) s."

# Without the model: hybrid says words only, semantic exits 7.
PENMOSS_HOME="$work/bare-home" "$bin" --penmoss-cli notebook add "file://$work/notes.git" --name nb >/dev/null
set +e
PENMOSS_HOME="$work/bare-home" "$bin" --penmoss-cli search battery --mode semantic --no-sync 2>"$work/err"
status=$?
set -e
cat "$work/err"
if [ "$status" -ne 7 ]; then
  echo "::error::semantic search without the model should exit 7; it exited $status"
  exit 1
fi
grep -q 'penmoss models fetch' "$work/err"
echo "Search by meaning works in the packaged app."
