My own notes on building apps that work without a network. #reading

## What I keep coming back to

- The copy on the device is the real one. The network is for sharing it, not for asking permission to read it.
- Every write should succeed locally first, then sync when it can.
- Merging should be boring: two edits made apart should both survive.

## For Driftwood

The article cache in [[Driftwood 0.4]] is a first step: reading never waits for a server.
