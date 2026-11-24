#!/bin/sh
# Refuses a production deploy inside a software factory run (F17, FD24): deploys happen after
# merge, never from a run, and every run's sandbox sets PENMOSS_FACTORY_RUN. Every repo command
# that runs `wrangler deploy` runs this first (the apps' `deploy` scripts, `task site:deploy`);
# tools/factory/test/deploy-guard.test.ts checks that they do.
if [ -n "${PENMOSS_FACTORY_RUN-}" ]; then
  echo 'No production deploys from a factory run: they happen after merge (FD24).' >&2
  exit 1
fi
