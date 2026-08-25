# Changelog

## 2.5.0

- Added separate current-build and overall-project timelines.
- Made plan generation return an ordered project roadmap alongside the bounded active phase.
- Fixed token estimates so calls appear immediately and successful or failed outputs are counted.
- Added per-agent input/output/call/failure totals and an all-agent total.
- Added persistent controls to completely minimize prompts and current-status cards.

## 2.4.1

- Downgraded read-only Git metadata, commit-message, signing, and sandbox limitations to non-blocking follow-ups when Relay's authoritative tests pass.
- Fixed finding-ledger verification when a recovered session restarts review-round numbering.
- Clarified reviewer instructions so repository metadata cannot trap an otherwise passing phase in a repair loop.

## 2.4.0

- Replaced roadmap-wide approval with a frozen, bounded phase gate.
- Added Approved with Follow-ups so future improvements no longer fail completed phases.
- Added a persistent finding ledger that tracks open and verified blockers across review rounds.
- Added per-connection estimated token tracking and compact prompt contexts.
- Made Relay's authoritative test run override reviewer-sandbox execution limitations.
- Added parsing for clean structured reviews and raw Codex JSONL custom adapters.
- Preserved backward compatibility for all existing saved sessions and worktree history.

## 2.3.0

- Added persistent Primary, Secondary, and Steer objective layers.
- Added an in-app objective history board and secondary-objective composer.
- Included objective history in planning, implementation, takeover, recovery, and review prompts.
- Recorded model failures and restarts as recovery objectives automatically.

## 2.2.0

- Added mandatory human-readable plan review before implementation.
- Added in-app plan approval and revision directions.
- Added live Interrupt & Steer with checkpoint-preserving continuation.
- Added evidence-based disagreement rules and bounded decision authority.
- Added a beginner setup assistant for Node, Git, and model CLIs.

## 2.1.0

- Added durable run-state persistence outside project repositories.
- Added automatic restoration after browser, Relay, or Mac restarts.
- Added Previous Sessions with full message and technical history.
- Added Resume Preserved Work using saved checkpoints, branches, and worktrees.
- Added recovered-session testing and independent approval rounds.

## 2.0.0

- Added named provider connections and saved team profiles.
- Added separate local account configuration directories.
- Added Claude Code, Codex, GitHub Copilot, legacy Gemini CLI, and custom CLI adapters.
- Added durable handoff checkpoints and same-worktree takeover.
- Added manual retry or replacement decisions inside the dashboard.
- Added optional automatic backup failover.
- Moved readable agent messages into the main feed and technical events into a collapsible log.
- Added compact display controls and smoother incremental updates.
- Added public packaging, security guidance, tests, and CI configuration.
