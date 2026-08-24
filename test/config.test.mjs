import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("configuration stores connection metadata without tokens", async () => {
  const root=mkdtempSync(join(tmpdir(),"relay-config-test-"));
  process.env.AGENT_RELAY_CONFIG=join(root,"config.json");
  const mod=await import(`../relay/config.mjs?test=${Date.now()}`);
  const saved=mod.saveConfig({connections:[{id:"work",label:"Work",provider:"Claude",configDir:"/tmp/claude-work",token:"secret"}],teamProfiles:[]});
  assert.equal(saved.connections[0].token,undefined);
  const raw=readFileSync(process.env.AGENT_RELAY_CONFIG,"utf8");
  assert.equal(raw.includes("secret"),false);
  assert.equal(statSync(process.env.AGENT_RELAY_CONFIG).mode & 0o777,0o600);
});

test("custom adapter arguments are bounded and sanitized", async () => {
  const root=mkdtempSync(join(tmpdir(),"relay-adapter-test-"));
  process.env.AGENT_RELAY_CONFIG=join(root,"config.json");
  const mod=await import(`../relay/config.mjs?test=${Date.now()}b`);
  const saved=mod.saveConfig({connections:[{id:"my model",label:"Local",provider:"Custom",command:"aider",readArgs:["--message","{prompt}"],writeArgs:["--yes-always","--message","{prompt}"]}],teamProfiles:[]});
  assert.equal(saved.connections[0].id,"my-model");
  assert.deepEqual(saved.connections[0].readArgs,["--message","{prompt}"]);
});
