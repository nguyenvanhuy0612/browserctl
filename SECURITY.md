# Security policy

## Supported versions

Only the latest release of `browserctl-mcp` gets security fixes. Versions up to 1.0.2 let any web
page control the browser through the daemon; update to 1.0.3 or later.

## Reporting a vulnerability

Please report privately through GitHub:
[Report a vulnerability](https://github.com/nguyenvanhuy0612/browserctl/security/advisories/new).
Do not open a public issue. Reporters are credited in the advisory unless they ask not to be.

## What browserctl protects, and what it does not

browserctl lets AI agents operate the user's own Chrome, with the user's logins. The daemon
listens on `127.0.0.1` and accepts calls from local processes (the MCP server, the CLI, the user's
scripts) and from the browserctl extension.

In scope: anything that lets a web page, or anyone not on the machine, reach the daemon or the
extension.

Known limitations, not treated as vulnerabilities:

- Processes running as the same OS user have full access by design.
- Other OS users on the same machine can reach `127.0.0.1` and so the daemon.
- A bug in another local program that lets a remote attacker send requests to the daemon
  (server-side request forgery) is not stopped by the daemon.
- Another installed extension can connect to the daemon as a browser.
