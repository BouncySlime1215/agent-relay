import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const BUILTINS = [
  { id: "Claude", label: "Claude", provider: "Claude", command: "claude" },
  { id: "Codex", label: "Codex", provider: "Codex", command: "codex" },
  { id: "Copilot", label: "GitHub Copilot", provider: "Copilot", command: "copilot" },
  { id: "Gemini", label: "Gemini (legacy)", provider: "Gemini", command: "gemini" }
];

const configPath = process.env.AGENT_RELAY_CONFIG || join(homedir(), ".agent-relay", "config.json");
const empty = { version: 1, connections: [], teamProfiles: [] };

function cleanString(value, max = 240) { return String(value || "").trim().slice(0, max); }
function cleanArgs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).map(v => cleanString(v, 2000)).filter(Boolean);
}
function cleanConnection(input) {
  const provider = ["Claude", "Codex", "Copilot", "Gemini", "Custom"].includes(input.provider) ? input.provider : "Custom";
  const id = cleanString(input.id || `connection-${Date.now()}`, 80).replace(/[^a-zA-Z0-9._-]/g, "-");
  const item = { id, label: cleanString(input.label || id, 80), provider };
  if (provider === "Custom") {
    item.command = cleanString(input.command, 300);
    item.versionArgs = cleanArgs(input.versionArgs);
    item.readArgs = cleanArgs(input.readArgs);
    item.writeArgs = cleanArgs(input.writeArgs);
    item.output = input.output === "jsonl" ? "jsonl" : "text";
  } else {
    item.configDir = cleanString(input.configDir, 500);
  }
  return item;
}
function cleanTeam(input) {
  return {
    id: cleanString(input.id || `team-${Date.now()}`, 80).replace(/[^a-zA-Z0-9._-]/g, "-"),
    name: cleanString(input.name || "My team", 80),
    primary: cleanString(input.primary, 80), partner: cleanString(input.partner, 80), backup: cleanString(input.backup, 80)
  };
}

export function loadConfig() {
  try {
    if (!existsSync(configPath)) return structuredClone(empty);
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return { version: 1, connections: (parsed.connections || []).map(cleanConnection), teamProfiles: (parsed.teamProfiles || []).map(cleanTeam) };
  } catch { return structuredClone(empty); }
}
export function saveConfig(input) {
  const value = { version: 1, connections: (input.connections || []).map(cleanConnection), teamProfiles: (input.teamProfiles || []).map(cleanTeam) };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return value;
}
export function allConnections() { return [...BUILTINS, ...loadConfig().connections]; }
export function findConnection(id) { return allConnections().find(item => item.id === id) || BUILTINS.find(item => item.provider === id); }
export function connectionEnv(connection) {
  const env = { ...process.env };
  if (!connection?.configDir) return env;
  const dir = resolve(connection.configDir.replace(/^~(?=\/)/, homedir()));
  if (connection.provider === "Claude") env.CLAUDE_CONFIG_DIR = dir;
  if (connection.provider === "Codex") env.CODEX_HOME = dir;
  if (connection.provider === "Copilot") env.COPILOT_HOME = dir;
  if (connection.provider === "Gemini") env.GEMINI_CLI_HOME = dir;
  return env;
}
export function publicConfig() {
  const saved = loadConfig();
  return { ...saved, connections: [...BUILTINS, ...saved.connections] };
}
