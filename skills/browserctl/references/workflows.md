# Workflows Reference

Standard interaction patterns and recipes for common browser tasks.

## 1. Form Filling and Submission

```javascript
// Step 1: Snapshot to find form fields
browser_snapshot({ target: "form#checkout" });

// Step 2: Fill multiple fields atomically
browser_fill_form({
  elements: [
    { target: "input[name='fullName']", value: "Jane Doe" },
    { target: "input[name='email']", value: "jane@example.com" }
  ]
});

// Step 3: Click submit and check effect
const res = browser_click({ target: "button[type='submit']" });
// Check res.effect.urlChanged or res.effect.domChanges to verify navigation
```

## 2. Structured Table and List Extraction

```javascript
// Step 1: Discover table or data container
browser_extract({ target: "table#pricing-matrix", format: "json" });

// Step 2: For CSV export with formula defense
browser_extract({ target: "table.sales-data", format: "csv", csv_safe: true });
```

## 3. Infinite Scroll and Lazy Loading

```javascript
// Step 1: Scroll down by viewport height
browser_scroll({ deltaY: 800 });

// Step 2: Wait for network settle
browser_wait_for({ time: 500 });

// Step 3: Snapshot new region
browser_snapshot({ scope: "viewport" });
```

## 4. Handling Dialogs

```javascript
// When an action triggers an alert/confirm/prompt:
// Step 1: Inspect dialog details
browser_handle_dialog({ action: "inspect" });

// Step 2: Accept or dismiss dialog
browser_handle_dialog({ action: "accept", promptText: "Confirmed" });
```

## 5. Multi-Tab Navigation

```javascript
// Step 1: Open a new tab
const tab = browser_tabs({ action: "new", url: "https://example.com" });

// Step 2: List open tabs
browser_tabs({ action: "list" });

// Step 3: Switch focus
browser_tabs({ action: "select", tabId: tab.tabId });
```
