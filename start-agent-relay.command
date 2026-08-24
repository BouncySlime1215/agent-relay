#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)" -lt 22 ]; then
  echo "Agent Relay needs Node.js 22 or newer. Opening the guided setup."
  "./setup-agent-relay.command"
fi
node relay/server.mjs &
relay_pid=$!
sleep 1
open "http://127.0.0.1:4317"
wait "$relay_pid"
