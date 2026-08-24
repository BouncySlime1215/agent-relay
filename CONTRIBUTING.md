# Contributing

Agent Relay welcomes provider adapters, UI improvements, reliability fixes, and documentation.

1. Fork the repository and create a focused branch.
2. Never commit provider credentials, local configuration folders, transcripts, or user repositories.
3. Run `npm run check` before opening a pull request.
4. Explain the behavior change, safety implications, and manual verification performed.
5. Keep provider-specific behavior behind an adapter instead of adding it to unrelated orchestration code.

Custom adapters must use argument arrays and `spawn(..., { shell: false })`. Pull requests that introduce shell-string execution or credential storage will not be accepted.
