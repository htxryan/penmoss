---
id: 01JB7Q3V6M8K2T9RZ4XN5C1HPD
title: Penmoss — sync design
created: 2026-10-14T09:12:00-05:00
updated: 2026-10-21T16:40:12-05:00
tags: [penmoss, architecture]
aliases: [sync design]
type: note
---

Each note is a Yjs document in its own Durable Object. See [[Penmoss — MCP tools]].

> [!note] Source of truth
> D1 is an index. It can always be rebuilt.

- [ ] Benchmark snapshot compaction #perf

![Sync diagram|480](../../attachments/9f2c1e.png)

![[Penmoss — product brief#Milestones]]
