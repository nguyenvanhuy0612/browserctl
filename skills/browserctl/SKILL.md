---
name: browserctl
description: Drive a real Chrome tab in the BACKGROUND while the user keeps working in their own tab. Use for any web task on a logged-in session — reading a page, filling a form, clicking through an app, checking notifications, extracting data, exploratory testing or QA on a live site — and whenever the work must not steal focus or disturb the tab the user is looking at. Also use for capturing network requests, HAR export, cookies, storage, console logs and CDP-level inspection of a page. Prefer browserctl when the target is a site the user is already signed in to, when a pinned target tab must survive the user switching tabs, or when several tabs must be driven in parallel.
---

# browserctl

Background browser automation over a pinned target tab. The user keeps their own tab in the
foreground; browserctl works in another one.

## What makes it different

- **Background operation is the premise.** Clicks, typing, navigation, reads and screenshots all
  run on a tab that is not focused. Never foreground a tab in order to act on it.
- **The target is pinned.** The first command pins a tab and it stays pinned even after the user
  switches away. `browser_new_tab` / `browser_navigate` re-pin; every tab-scoped tool also takes an
  optional `tabId` so parallel agents can drive different tabs without racing on the pin.
- **It uses the user's real session.** No separate profile, no re-login.

## Start here

1. `browser_snapshot` — the census: interactive elements with stable `@ref`s, in reading order,
   plus open dialogs and a note about anything withheld. Act by ref.
2. `browser_find "<label>"` — whole-page search when you know a control's label. On a miss it
   returns near-matches rather than a bare zero.
3. `browser_click` / `browser_fill` / `browser_type` — every one returns an `effect` block
   (mutation count, url change) so you can tell a real action from a no-op.

## Two things that cost agents the most turns

- **Counts and complete lists need `scope: 'all'`.** The default viewport census can omit rows of
  exactly the kind you were asked for. `all` is cheap.
- **`all` is not everything.** Feeds, notification panels and virtualised lists keep rows out of the
  DOM until a control is clicked. When that is likely, the snapshot prints a
  `Possible hidden content` line naming the control — click it rather than re-snapshotting.

## More capability than is loaded

The default profile is a subset. `browser_load_tools` adds network capture, HAR export, cookies,
storage, console and CDP; `browser_action` dispatches any protocol action by name. Every snapshot
footer says how many capabilities are not loaded. Do not conclude something is impossible without
checking there first.
