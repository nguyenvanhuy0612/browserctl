# `file_upload`

Status: verified (2026-11-14: common parameters from `actions.md`)
Depends on: `actions.md`, `dom-lane.md`, `relay.md`, `targets.md`, `errors.md`

## Purpose

Attach local files to a file input, or to whatever file chooser a button opens.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes | | ref or selector: an `input[type=file]`, its label, or a control that opens a file chooser | where to attach |
| `paths` | string[] | yes | | absolute paths on the daemon's host; empty list clears the input | files |
| `timeout` | number | no | 5 | 0 to 60 seconds | wait for the target to be actionable (`actions.md`) |
| `wait` | object | no | none | one `wait_for` condition plus `timeout` | wait for it after the action settles (`actions.md`) |
| `tab` | integer | no | current tab | owned tab | which tab |

## Behaviour

1. Read every file in the daemon; a missing or unreadable one → `FILE_NOT_FOUND` before anything
   is sent.
2. Find the input: `target` itself, the input its label points to, or a file input inside it.
3. Found, and the files total at most 25 MB (base64 must stay under Chrome's 64 MiB extension
   message limit): DOM lane, Playwright `setInputFiles` with the contents
   (name, MIME type from the extension, `lastModified`); `input` and `change` fire.
4. Not found (a custom button opening a chooser), or more than 25 MB: CDP lane, Playwright
   `waitForEvent("filechooser")` around a click on `target`, then `setFiles` with the paths.
   Whether `DOM.setFileInputFiles` through `chrome.debugger` needs the extension's "Allow access
   to file URLs" is checked during implementation; if it does, `status` lists it under `setup`.
5. Settle; return.

## Result

| Field | Type | Always present | Meaning |
| --- | --- | --- | --- |
| `lane` | `"dom"` \| `"cdp"` | yes | |
| `files` | `{name, size, mimeType}[]` | yes | as the page sees them (`input.files`) |
| `outcome` | as in `click` | yes | |
| `waited` | object \| null | yes | the `wait` result, null without `wait` (`actions.md`) |
| `hint` | string \| null | yes | set when `wait` timed out (`actions.md`) |

## Errors

`FILE_NOT_FOUND`, `NO_TAB`, `TAB_NOT_OWNED`, `TAB_CLOSED`, `PAGE_UNSCRIPTABLE`, `REF_NOT_FOUND`,
`TARGET_NOT_FOUND`, `AMBIGUOUS_TARGET`, `INVALID_TARGET`, `TARGET_DISABLED`, `DEBUGGER_CANCELED`,
`DEBUGGER_BUSY`, `INVALID_PARAMS`.

## Tool description (what the agent reads)

```text
Attach local files (absolute paths) to a file input or to the upload button that opens a file
chooser. paths: [] clears it. Returns the files as the page sees them.
```

## Tests

| ID | Kind | Case | Asserts |
| --- | --- | --- | --- |
| UP-E01 | live | file input by ref, background tab | DOM lane, no bar, `change` fired |
| UP-E02 | live | custom button opening a chooser | CDP lane, files attached |
| UP-E03 | live | 40 MB file | CDP lane |
| UP-E04 | live | missing path | `FILE_NOT_FOUND`, input untouched |
| IF-001, IF-010, IF-012, IF-013, IF-015, IF-018, IF-020..IF-022 | live | Playwright upload cases | DOM lane |
| IF-009 | live | 200 MB file | CDP lane; `input` then `change`; the page sees name and size (Playwright also posts the form to its test server, which the fixture server has no route for) |
| IF-016 | live | a text file and a PNG into two inputs | the page sees `text/plain` and `image/png` (Playwright reads them back from its server) |
| IF-019 | live | `input` event composed across a shadow root, from a file on disk | as Playwright, which sets the file from memory |
| UP-E05 | live | playwright-mcp `files.spec.ts` "browser_file_upload" and "keeps chooser when setFiles fails": the input by its snapshot ref (`button "Choose File"`), a missing path, then a real one | `FILE_NOT_FOUND`, then attached |

Not adopted: IF-002..IF-007 (directory uploads: later, through the CDP lane only); IF-014 (files
from memory: `paths` only); playwright-mcp `files.spec.ts` file chooser modal state (`file_upload`
names its target instead), downloads (no download tool), workspace roots (paths are the daemon
host's own files, no root list), `browser_drop` (no drag and drop of files).
