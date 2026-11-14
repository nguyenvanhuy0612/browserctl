# Errors

Status: approved
Depends on: none

Every failed call returns:

```json
{ "ok": false, "error": { "code": "TARGET_COVERED", "message": "...", "hint": "..." } }
```

`message` says what happened, with names from the page. `hint` names the next call to make. A
code is added here before any code returns it.

| Code | Meaning |
| --- | --- |
| `INVALID_PARAMS` | unknown parameter, wrong type or value; the message lists the valid parameters |
| `NO_BROWSER` | no extension connected |
| `AMBIGUOUS_BROWSER` | several browsers connected and none named |
| `EXTENSION_OUTDATED` | the extension's protocol version differs from the daemon's |
| `NO_TAB` | the session has no current tab |
| `TAB_NOT_OWNED` | the tab belongs to another session or to none |
| `TAB_CLOSED` | the tab closed before or during the call |
| `PAGE_UNSCRIPTABLE` | the page cannot be scripted by an extension (`chrome://`, Web Store, the PDF viewer, an error page) |
| `INVALID_TARGET` | the selector does not parse |
| `REF_NOT_FOUND` | the ref's element is gone, or the tab navigated since the snapshot that gave it |
| `TARGET_NOT_FOUND` | the selector matched nothing within the wait |
| `AMBIGUOUS_TARGET` | the selector matched several elements |
| `TARGET_HIDDEN` | the element stayed invisible |
| `TARGET_DISABLED` | the element stayed disabled or inert |
| `TARGET_COVERED` | another element receives the pointer at the target point |
| `TARGET_NOT_EDITABLE` | text entry into an element that takes none |
| `DIALOG_OPEN` | a native dialog not handled by the shim blocks the page |
| `OPTION_NOT_FOUND` | a `<select>` has no option with that value or label |
| `NAVIGATION_FAILED` | the page did not load; the message has Chrome's net error |
| `FILE_NOT_FOUND` | an upload path does not exist or cannot be read |
| `BODY_UNAVAILABLE` | the response body was not captured (`captureBodies` was off) |
| `EVAL_ERROR` | code passed to `evaluate` or `run` threw; the message has the page's error |
| `USER_SCRIPTS_OFF` | `evaluate` without the debugger needs "Allow User Scripts"; the hint offers `trusted: true` |
| `DEBUGGER_CANCELED` | the user pressed Cancel on the debugging bar |
| `DEBUGGER_BUSY` | another debugger (DevTools) holds the tab |
| `TIMEOUT` | the call's overall time limit passed |
| `INTERNAL_ERROR` | a fault in browserctl itself; the message has the cause, the call log has the details |
