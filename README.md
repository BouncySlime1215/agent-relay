# Agent Relay

Agent Relay is a local, provider-neutral coordinator for coding agents. Give it one goal and it asks two independent agents to assess the repository, splits file ownership, implements in isolated Git worktrees, combines the work, runs tests, exchanges reviews, and protects your main branch behind an approval gate.

Built-in adapters support Claude Code, OpenAI Codex, and GitHub Copilot CLI. Named account connections and custom command adapters let every contributor use their own accounts and models without sharing credentials.

## Highlights

- Primary, partner, and optional backup roles.
- Multiple accounts per provider using separate native configuration directories.
- Saved team profiles.
- Custom non-interactive CLI adapters.
- Durable handoff checkpoints for context or rate-limit interruptions.
- Manual in-app takeover by default; optional automatic backup.
- Same-worktree continuation with Git status and diff recovery.
- Isolated implementation branches and a separate integration branch.
- Tests and two explicit approvals before the merge gate opens.
- Activity-first dashboard, compact mode, minimized idle agents, and a separate conversation log.
- No API keys or provider tokens stored by Relay.

## Requirements

- macOS for the included double-click launcher. The Node server also runs on Linux and Windows.
- Node.js 22 or later.
- Git.
- At least two authenticated coding-agent CLIs, or compatible custom adapters.

## Quick start

```bash
npm start
```

On macOS, double-click `start-agent-relay.command`. The dashboard opens at `http://127.0.0.1:4317` and binds only to the local machine.

1. Open **Accounts & models** and add any separate account connections.
2. Select the primary, partner, and optional backup.
3. Leave **Automatically use backup without asking** off if you want to choose every takeover yourself.
4. Choose a clean local Git repository, enter a goal and test command, then start the team.

## Multiple accounts and collaborators

Relay stores connection metadata in `~/.agent-relay/config.json` with owner-only permissions. Credentials remain in the provider's own configuration folder. See [Multiple accounts](docs/MULTI_ACCOUNT.md).

Repository collaborators clone Agent Relay and configure their own local connections. Shared project repositories contain code and team conventions, not personal model credentials.

## Custom models

Use **Accounts & models → Custom** for any trusted CLI that accepts a prompt non-interactively and writes its final response to standard output. See [Custom adapters](docs/CUSTOM_ADAPTERS.md).

## Interrupted-agent recovery

Agents are instructed to maintain an external handoff checkpoint containing decisions, files, commands, results, risks, remaining work, and the exact next action. If an agent fails, Relay pauses without discarding its worktree. In the dashboard you can retry the same connection after fixing its login or limits, or select a different connection. Either choice receives the checkpoint plus the current Git status and diff summary.

No provider exposes a universal reliable “tokens remaining” API, so checkpoints are proactive while takeover is triggered by an agent exit, context-limit error, rate limit, authentication failure, or manual choice.

## Safety

- The selected repository must be clean before a run.
- Agents cannot edit main directly through Relay.
- Automatic merge is disabled by default.
- Relay never pushes automatically.
- Custom adapters execute local programs and should be treated as trusted code.
- Provider usage limits and charges remain controlled by each native CLI.

## Development

```bash
npm run check
```

See [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).
