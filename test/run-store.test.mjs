import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("run history survives restart and marks active work recoverable",async()=>{
  const root=mkdtempSync(join(tmpdir(),"relay-run-store-"));
  process.env.AGENT_RELAY_STATE=root;
  const store=await import(`../relay/run-store.mjs?test=${Date.now()}`);
  store.saveRunState({id:"abc123",status:"running",goal:"Keep everything",events:[{agent:"Relay",text:"Saved"}],messages:[],children:new Set([123]),createdAt:new Date().toISOString()});
  const [loaded]=store.loadRunStates();
  assert.equal(loaded.id,"abc123");
  assert.equal(loaded.status,"interrupted");
  assert.equal(loaded.recoverable,true);
  assert.equal(loaded.events[0].text,"Saved");
  assert.equal(loaded.children.size,0);
  assert.equal(loaded.primaryObjective,"Keep everything");
  assert.equal(loaded.secondaryObjectives[0].source,"restart");
  assert.deepEqual(loaded.steeringNotes,[]);
});
