# Agent Relay

Agent Relay is a local, provider-neutral coordinator for coding agents. Give it one goal and it asks two independent agents to assess the repository, splits file ownership, implements in isolated Git worktrees, combines the work, runs tests, exchanges reviews, and protects your main branch behind an approval gate.

Built-in adapters support Claude Code, OpenAI Codex, and GitHub Copilot CLI. Named account connections and custom command adapters let every contributor use their own accounts and models without sharing credentials.

## Easiest Mac setup

You do not need to understand Git or Terminal commands.

1. Click the green **Code** button near the top of this GitHub page.
2. Click **Download ZIP**.
3. Open your Downloads folder and double-click the ZIP.
4. Open the new `agent-relay` folder.
5. Double-click **`setup-agent-relay.command`**.
6. The setup window checks Git and Node.js, then asks before installing any missing AI tools. You only need two working agents.
7. Run each chosen agent once in Terminal and complete its normal sign-in screen.
8. Double-click **`start-agent-relay.command`**.
9. Your browser opens Agent Relay automatically.

If macOS blocks a `.command` file, right-click it, choose **Open**, and then choose **Open** again. The setup assistant never stores passwords or model tokens.

Supported installers use the providers' official packages: [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup), [OpenAI Codex](https://developers.openai.com/codex/cli), [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli), and [Gemini CLI](https://github.com/google-gemini/gemini-cli).

## Highlights

- Primary, partner, and optional backup roles.
- Multiple accounts per provider using separate native configuration directories.
- Saved team profiles.
- Custom non-interactive CLI adapters.
- Durable handoff checkpoints for context or rate-limit interruptions.
- Crash-safe session history across browser, app, and Mac restarts.
- A saved Primary → Secondary → Steer objective history for every session.
- Frozen phase gates with Approved, Approved with Follow-ups, and Blocked outcomes.
- A persistent finding ledger that prevents resolved issues from silently becoming open again.
- Per-agent estimated token tracking and bounded prompts to reduce unnecessary usage.
- Manual in-app takeover by default; optional automatic backup.
- A readable plan that requires your approval before agents edit code.
- Live Interrupt & Steer that preserves work before changing direction.
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
5. Read the proposed plan. Approve it or tell Relay exactly what to change.
6. Use **Interrupt & steer** at any time if the agents head in the wrong direction.

## Objective history

Every session keeps three simple layers together in one smooth timeline:

- **Primary objective** — the original outcome you want the team to build. It never gets silently replaced.
- **Secondary objectives** — follow-up phases, failures to recover from, support tasks, and “continue from here” instructions. Add these without restarting the team.
- **Steering notes** — live interruptions and small corrections. Relay stops active processes safely, records the direction, and resumes from preserved work.

All three layers survive browser, Relay, and Mac restarts. They are included in agent assessments, implementation prompts, recovery handoffs, and reviews so a replacement model knows both the original intent and everything that changed afterward.

## How disagreements are handled

The primary objective is a roadmap. Each run proposes one bounded phase, and approving its plan freezes the acceptance criteria for that phase. Reviewers cannot fail a phase because unrelated roadmap work remains. Agents must tie blockers to code, authoritative tests, security, data-loss risk, destructive migration, or an unmet frozen criterion. Reversible preferences and worthwhile future work become saved follow-up objectives. Relay keeps a persistent finding ledger, and a resolved finding needs new evidence before it can block again.

Relay runs the configured test command outside model sandboxes. A reviewer's inability to execute a command inside its own sandbox is recorded but does not override Relay's authoritative result.

## Token tracking

The dashboard estimates input and output tokens for each local agent connection and shows total calls. Estimates use character counts because native CLIs do not expose one consistent usage format. Full objectives and history remain saved, while repeated implementation, repair, and review prompts use the approved phase and recent context instead of resending the complete roadmap every turn.

## Multiple accounts and collaborators

Relay stores connection metadata in `~/.agent-relay/config.json` with owner-only permissions. Credentials remain in the provider's own configuration folder. See [Multiple accounts](docs/MULTI_ACCOUNT.md).

Repository collaborators clone Agent Relay and configure their own local connections. Shared project repositories contain code and team conventions, not personal model credentials.

## Custom models

Use **Accounts & models → Custom** for any trusted CLI that accepts a prompt non-interactively and writes its final response to standard output. See [Custom adapters](docs/CUSTOM_ADAPTERS.md).

## Interrupted-agent recovery

Agents are instructed to maintain an external handoff checkpoint containing decisions, files, commands, results, risks, remaining work, and the exact next action. If an agent fails, Relay pauses without discarding its worktree. In the dashboard you can retry the same connection after fixing its login or limits, or select a different connection. Either choice receives the checkpoint plus the current Git status and diff summary.

No provider exposes a universal reliable “tokens remaining” API, so checkpoints are proactive while takeover is triggered by an agent exit, context-limit error, rate limit, authentication failure, or manual choice.

## Restart and crash recovery

Relay continuously saves run goals, readable messages, technical events, test history, model assignments, checkpoint paths, branches, and worktree locations under `~/.agent-relay/runs`. If the browser, Relay process, or Mac restarts, the dashboard restores the active session automatically and shows **Interrupted session preserved**. Choose **Open** to inspect everything or **Resume work** to continue from the saved worktrees. Recovery never silently edits or merges main.

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
