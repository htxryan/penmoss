#!/bin/sh
# The Playwright suite's stand-in for the Mac's owner check (T41, A504), which needs macOS:
# an unpackaged build runs it through PENMOSS_TEST_AUTH_HELPER, exactly as it runs the real
# helper. It records the reason it was given (one line each) and exits with the code the test
# wrote: 0 confirmed, 1 refused, 2 unavailable (native/penmoss-auth.swift). No answer: refused.
[ "$#" -eq 1 ] || exit 64
printf '%s\n' "$1" >> "$PENMOSS_TEST_AUTH_DIR/asked"
code="$(cat "$PENMOSS_TEST_AUTH_DIR/answer" 2>/dev/null || echo 1)"
exit "$code"
