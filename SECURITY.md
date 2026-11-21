# Security policy

Graphite stores database credentials and can let AI agents run SQL, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/julioczn/graphite/security/advisories/new)
(Security tab → *Report a vulnerability*).

Include what you found, how to reproduce it and the version / OS you used. You should get an answer within a week.
Once a fix is released you'll be credited in the advisory unless you'd rather not be.

## Supported versions

Only the latest release gets security fixes.

## Scope

Things we especially want to hear about:

- Ways for an AI agent (assistant or MCP client) to write to a database **without** the user's approval, or to bypass
  the database-enforced read-only mode.
- Ways to reach the MCP server from another machine or from a web page, or to use it without the token.
- Leaks of saved passwords or API keys (to the renderer, logs, other providers or disk in plain text).
- Code execution from content in a database, SQL file or AI response (e.g. HTML/script injection in the interface).

Out of scope: attacks that require an already compromised machine or user account, and the unsigned/not notarized
status of the macOS build (documented in the README).
