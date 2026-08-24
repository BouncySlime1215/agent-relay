# Security

Agent Relay runs coding agents with access to local source code. Use it only with repositories and CLI providers you trust.

- Credentials remain in each provider's native configuration directory. Agent Relay never asks for or stores tokens.
- Automatic merging is disabled by default.
- Each implementation agent receives an isolated Git worktree.
- Custom adapters can execute local programs. Only add commands you trust.
- Do not expose port 4317 to a network; the server binds to `127.0.0.1`.

Report vulnerabilities privately to the repository owner rather than opening a public issue containing exploit details.
