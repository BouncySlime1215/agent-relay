#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Agent Relay setup"
echo "================="

if ! command -v git >/dev/null 2>&1; then
  echo "Git is missing. macOS will open its installer now. Finish that installer, then run this file again."
  xcode-select --install || true
  read -r -p "Press Return to close."
  exit 1
fi

node_ok=false
if command -v node >/dev/null 2>&1; then
  node_major=$(node -p "Number(process.versions.node.split('.')[0])")
  if [ "$node_major" -ge 22 ]; then node_ok=true; fi
fi

if [ "$node_ok" != true ]; then
  echo "Node.js 22 or newer is required."
  if command -v brew >/dev/null 2>&1; then
    read -r -p "Install Node.js automatically with Homebrew? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then brew install node; else open "https://nodejs.org/en/download"; exit 1; fi
  else
    echo "The Node.js download page will open. Install the LTS version, then run this setup again."
    open "https://nodejs.org/en/download"
    exit 1
  fi
fi

install_agent() {
  command_name="$1"
  display_name="$2"
  package_name="$3"
  if command -v "$command_name" >/dev/null 2>&1; then
    echo "✓ $display_name is installed"
    return
  fi
  read -r -p "$display_name is missing. Install it now? [y/N] " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then npm install -g "$package_name"; else echo "Skipped $display_name"; fi
}

install_agent claude "Claude Code" "@anthropic-ai/claude-code"
install_agent codex "OpenAI Codex" "@openai/codex"
install_agent copilot "GitHub Copilot CLI" "@github/copilot"
install_agent gemini "Google Gemini CLI" "@google/gemini-cli"

echo
echo "Setup check finished. You only need two working agents."
echo "Run each agent once in Terminal and follow its sign-in screen: claude, codex, copilot, or gemini."
echo "Then double-click start-agent-relay.command."
read -r -p "Press Return to close."
