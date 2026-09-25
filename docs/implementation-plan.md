# YouTube Client Implementation Plan

**Goal:** Create an independent YouTube extension backed by the existing LingRead service.
**Architecture:** Extract the three existing YouTube scripts and add a scoped service worker, relay bridge and popup. Keep all server contracts and website routes unchanged.
**Tech Stack:** Chrome MV3, plain JavaScript, Vitest, Sharp, JSZip.
**Spec:** docs/design.md

## Constraints

Use the agreed functional name; no emoji; red icon; existing LingRead identity and backend; no API or schema changes. New repository on main, commit after verification; no automatic main push.

## Tasks

- [x] Write failing API proxy and relay tests covering request bodies, HTTP errors, local iframe token isolation, unrelated client sessions, forged callbacks, expired login and worker restart.
- [x] Implement API/auth modules and wire background messages and navigation injection.
- [x] Extract YouTube scripts and existing tests, isolate DOM/event namespaces, add popup actions for subtitle tools and transcript/summary.
- [x] Add red icon source and generated assets, scope manifest permissions, provide reproducible development/production packages.
- [x] Run full tests, resource/syntax checks, inspect popup/icon, review changes and commit.

## Review focus

- Both clients installed: do not reuse/consume another client's relay.
- Login callback before tab creation finishes: store pending state before navigation.
- Stopped MV3 worker: direct callback and alarm resume pending login.
- Local embedded player with a production token: do not forward token across API origins.
- YouTube SPA/navigation: preserve current-video guards and subtitle state resets.

## Execution notes

User explicitly requested implementation and clarified this is only another client. Proceed with that scope; no new account system or admin app. New sibling repository is the isolated workspace.


Review: independent read-only reviewer identified an Alt shortcut guard left over from LingRead. Reproduced with a failing keyboard behavior test, removed the Alt guard and switched to KeyboardEvent.code for macOS compatibility; regression passes.

Ruling: retain the original LingRead checkout unchanged for this migration stage. The optional old-entry removal choice received no answer during implementation. Existing clients remain compatible, but simultaneous old/new extension UI and old relay behavior require follow-up before migration release.
