#!/usr/bin/env bash
# Housekeeping for jobs on Ryan's self-hosted Mac runners (docs/ci.md). A Mac keeps its
# checkout, processes and ports between jobs, unlike GitHub's throwaway machines.
#
#   bash .github/scripts/mac-runner.sh pick-ports   two free ports for this job's e2e servers,
#                                                   into $GITHUB_ENV (A1140), so any Mac runs it
#   bash .github/scripts/mac-runner.sh free-ports   stop CI servers still listening on this
#                                                   job's e2e ports (else 4173, 5173, 8787, 8791)
#   bash .github/scripts/mac-runner.sh clean        stop this runner's Gradle daemons and
#                                                   empty the checkout
#   bash .github/scripts/mac-runner.sh clean --ports   the same, after free-ports (the jobs
#                                                   that bind the ports, on the ports runner)
#
# Only processes started from this runner's _work folder are stopped. Anything else on a port
# (Ryan's own `task dev`, or another runner's job) is reported and left alone; a job that needs
# the port then fails on it rather than stopping someone else's server.
set -uo pipefail

# This job's ports when pick-ports chose them (A1140); the fixed ones otherwise.
if [ -n "${PENMOSS_E2E_PORT:-}" ] && [ -n "${PENMOSS_E2E_PREVIEW_PORT:-}" ]; then
  PORTS=("$PENMOSS_E2E_PORT" "$PENMOSS_E2E_PREVIEW_PORT")
else
  PORTS=(4173 5173 8787 8791)
fi
work="$(cd "${RUNNER_WORKSPACE:?}/.." && pwd -P)"

listeners() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u
}

started_here() {
  local cwd
  cwd="$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [[ "$cwd/" == "$work"/* ]]
}

free_ports() {
  local port pid stopped=()
  for port in "${PORTS[@]}"; do
    for pid in $(listeners "$port"); do
      if started_here "$pid"; then
        echo "Stopping $(ps -o comm= -p "$pid") (pid $pid) on :$port, left by a CI job"
        pkill -TERM -P "$pid" 2>/dev/null
        kill -TERM "$pid" 2>/dev/null && stopped+=("$pid")
      else
        echo "Port $port is held by pid $pid, not started from this runner's _work folder: leaving it."
      fi
    done
  done
  if [ "${#stopped[@]}" -gt 0 ]; then
    sleep 3
    for pid in "${stopped[@]}"; do kill -KILL "$pid" 2>/dev/null; done
  fi
  for port in "${PORTS[@]}"; do
    if [ -n "$(listeners "$port")" ]; then echo "Port $port is still in use."; fi
  done
  return 0
}

clean() {
  if [ "${1:-}" = --ports ]; then free_ports; fi
  local workspace="${GITHUB_WORKSPACE:?}"
  if [ -n "${GRADLE_USER_HOME:-}" ] && [ -d "$GRADLE_USER_HOME/daemon" ] &&
    [ -x "$workspace/apps/android/gradlew" ]; then
    (cd "$workspace/apps/android" && ./gradlew --stop --quiet) || true
  fi
  if [ -d "$workspace/.git" ]; then
    git -C "$workspace" clean -ffdxq
    echo "Emptied the checkout of build output and dependencies."
  fi
  return 0
}

# Two ports nothing listens on, given by the system, for Vite and vite preview.
pick_ports() {
  local picked
  picked="$(python3 -c 'import socket
socks = [socket.socket() for _ in range(2)]
for s in socks: s.bind(("127.0.0.1", 0))
print(" ".join(str(s.getsockname()[1]) for s in socks))')" || return 1
  set -- $picked
  echo "PENMOSS_E2E_PORT=$1" >> "${GITHUB_ENV:?}"
  echo "PENMOSS_E2E_PREVIEW_PORT=$2" >> "$GITHUB_ENV"
  echo "This job's e2e ports: $1 (Vite) and $2 (vite preview)."
}

case "${1:-}" in
  pick-ports) pick_ports ;;
  free-ports) free_ports ;;
  clean) clean "${2:-}" ;;
  *)
    echo "usage: $0 pick-ports | free-ports | clean [--ports]" >&2
    exit 2
    ;;
esac
