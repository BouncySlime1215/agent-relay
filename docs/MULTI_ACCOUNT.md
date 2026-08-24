# Multiple accounts

Open **Accounts & models** in the dashboard and add a named connection. A connection selects a provider and, optionally, a separate native configuration folder.

| Provider | Isolated configuration variable |
|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` |
| OpenAI Codex | `CODEX_HOME` |
| GitHub Copilot CLI | `COPILOT_HOME` |
| Gemini CLI | `GEMINI_CLI_HOME` |

Sign in to each account using its native CLI and the same configuration variable before starting Relay. Agent Relay stores only the folder path; it does not copy or store credentials.

Saved team profiles remember the primary, partner, and backup connection IDs. Each collaborator maintains their own local connection configuration, so a shared repository never contains personal credentials.
