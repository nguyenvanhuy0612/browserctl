# `file_upload`

Status: approved
Depends on: `dom-lane.md`, `relay.md`, `targets.md`, `errors.md`

## Purpose

Attach local files to a file input, or to whatever file chooser a button opens.

## Parameters

| Name | Type | Required | Default | Allowed values / constraints | Meaning |
| --- | --- | --- | --- | --- | --- |
| `target` | string | yes | | ref or selector: an `input[type=file]`, its label, or a control that opens a file chooser | where to attach |
| `paths` | string[] | yes | | absolute paths on the daemon's host; empty list clears the input | files |
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
| IF-001, IF-009, IF-010, IF-012, IF-013, IF-014, IF-015, IF-016, IF-018..IF-022 | live | Playwright upload cases | DOM lane, and CDP lane for IF-009 |
| playwright-mcp `files.spec.ts` | live | adopted | same results |

Not adopted: IF-002..IF-007 (directory uploads: later, through the CDP lane only).
