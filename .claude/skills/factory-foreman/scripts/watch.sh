#!/bin/sh
# Prints new ledger events and notable daemon-log lines as they appear. Polls line counts every
# 15 s: a `tail -F` on these paths (they contain a space) once delivered nothing for 26 minutes.
# Use as a Monitor command; it runs until stopped.
S="$HOME/Library/Application Support/penmoss-factory"
a=$(wc -l < "$S/runs.jsonl"); b=$(wc -l < "$S/daemon.log")
echo "watching from ledger line $a, log line $b"
while true; do
  n=$(wc -l < "$S/runs.jsonl")
  if [ "$n" -gt "$a" ]; then sed -n "$((a+1)),${n}p" "$S/runs.jsonl" | cut -c1-300; a=$n; fi
  m=$(wc -l < "$S/daemon.log")
  if [ "$m" -gt "$b" ]; then
    sed -n "$((b+1)),${m}p" "$S/daemon.log" | grep -v '^{' |
      grep -iE "PEN-|error|fail|can't|blocked|daemon|merg|done|review" | cut -c1-300
    b=$m
  fi
  sleep 15
done
