import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("run history survives restart and marks active work recoverable",async()=>{
  const root=mkdtempSync(join(tmpdir(),"relay-run-store-"));
  process.env.AGENT_RELAY_STATE=root;
  const store=await import(`../relay/run-store.mjs?test=${Date.now()}`);
  store.saveRunState({id:"abc123",status:"running",goal:"Keep everything",events:[{agent:"Relay",text:"Saved"}],messages:[{agent:"Claude",text:"Current work"}],transcript:{primaryReview1:"evidence"},projectTimeline:[{name:"Foundation",status:"active"}],currentBuildTimeline:[{name:"Test",status:"active"}],integrationBranch:"relay/abc123-integration",integrationPath:"/tmp/preserved-integration",children:new Set([123]),createdAt:new Date().toISOString()});
  const [loaded]=store.loadRunStates();
  assert.equal(loaded.id,"abc123");
  assert.equal(loaded.status,"interrupted");
  assert.equal(loaded.recoverable,true);
  assert.equal(loaded.events[0].text,"Saved");
  assert.equal(loaded.messages[0].text,"Current work");
  assert.equal(loaded.transcript.primaryReview1,"evidence");
  assert.equal(loaded.integrationBranch,"relay/abc123-integration");
  assert.equal(loaded.integrationPath,"/tmp/preserved-integration");
  assert.equal(loaded.projectTimeline[0].name,"Foundation");
  assert.equal(loaded.currentBuildTimeline[0].name,"Test");
  assert.equal(loaded.children.size,0);
  assert.equal(loaded.primaryObjective,"Keep everything");
  assert.equal(loaded.secondaryObjectives[0].source,"restart");
  assert.deepEqual(loaded.steeringNotes,[]);
});
