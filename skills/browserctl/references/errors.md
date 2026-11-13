# Error Recovery Reference

Guide for autonomous error handling and self-healing in browserctl.

## Error Recovery Strategies

| Error Code | Recovery Strategy | Actionable Next Step |
| :--- | :--- | :--- |
| `STALE_REF` | `refresh_snapshot` | Call `browser_snapshot` immediately. The DOM was modified and the element ref changed. |
| `AMBIGUOUS_TARGET` | `narrow_target` | Provide a specific CSS selector or exact `@e` ref from snapshot. |
| `ELEMENT_DISABLED` | `inspect_state` | Element is non-interactive. Verify form validation requirements or previous inputs. |
| `ELEMENT_NOT_VISIBLE` | `scroll_to_view` | Call `browser_scroll({ target: "@e1" })` to bring control into viewport. |
| `ELEMENT_NOT_FOUND` | `verify_selector` | Take a new snapshot or re-verify CSS selector spelling. |
| `ELEMENT_NOT_EDITABLE` | `target_input` | Locate the child or associated `<input>` / `<textarea>` element. |
| `BROWSER_BUSY` | `wait_retry` | Wait for active lease settle window or select another browser profile. |
| `BROWSER_DISCONNECTED` | `reconnect` | Call `browser_status` to inspect bridge status. |
| `TARGET_CLOSED` | `reselect_tab` | Call `browser_tabs({ action: "list" })` and pick an active tab or open a new tab. |
| `TARGET_TAKEN` | `reselect_tab` | Another agent claimed the tab. Call `browser_tabs({ action: "new" })` for dedicated tab. |
| `NEEDS_TARGET` | `select_target` | Multi-browser active. Call `browser_tabs({ action: "select", tabId: ... })`. |
| `TAB_OWNED` | `choose_tab` | Tab belongs to another session. Work in another tab or request user force. |
| `DIALOG_BLOCKED` | `handle_dialog` | Call `browser_handle_dialog({ action: "accept" })` to unblock DOM execution. |
| `COMMAND_TIMEOUT_MS` | `inspect_state` | Bridge command timed out. Take a snapshot to check if page rendered or is loading. |
| `TIMEOUT` | `retry_or_increase` | Retry with larger `timeout_ms` or inspect network condition. |
