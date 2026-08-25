import test from "node:test";
import assert from "node:assert/strict";
import { compactObjectiveContext, parseReview, recordReviewRound, recordTokenEstimate } from "../relay/review-gate.mjs";

test("structured phase review distinguishes blockers from follow-ups",()=>{
  const approved=parseReview(JSON.stringify({verdict:"APPROVE_WITH_FOLLOWUPS",blockers:[],followups:["Add a chart later"]}));
  assert.equal(approved.verdict,"FOLLOWUPS");
  assert.deepEqual(approved.followups,["Add a chart later"]);
  const revise=parseReview(JSON.stringify({verdict:"REVISE",blockers:[{id:"auth-1",criterion:"Authorization",evidence:"route allows an unowned mutation"}],followups:[]}));
  assert.equal(revise.verdict,"REVISE");
  assert.equal(revise.blockers[0].id,"auth-1");
});

test("raw Codex JSONL is unwrapped before verdict parsing",()=>{
  const raw=[JSON.stringify({type:"thread.started"}),JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify({verdict:"APPROVE",blockers:[],followups:[]})}})].join("\n");
  assert.equal(parseReview(raw).verdict,"APPROVE");
});

test("finding ledger verifies findings absent from the next round",()=>{
  const run={findingLedger:[]};
  recordReviewRound(run,[{agent:"Codex",review:{blockers:[{id:"auth-1",criterion:"Authorization",evidence:"failure"}]}}],1);
  assert.equal(run.findingLedger[0].status,"open");
  recordReviewRound(run,[{agent:"Codex",review:{blockers:[]}}],2);
  assert.equal(run.findingLedger[0].status,"verified");
});

test("token estimates accumulate without storing new credentials",()=>{
  const run={};recordTokenEstimate(run,"Claude","12345678","1234");recordTokenEstimate(run,"Claude","1234","1234");
  assert.equal(run.tokenUsage.Claude.calls,2);
  assert.equal(run.tokenUsage.Claude.total,5);
});

test("objective context is bounded while history remains on the run",()=>{
  const run={primaryObjective:"x".repeat(9000),secondaryObjectives:[],steeringNotes:[]};
  const context=compactObjectiveContext(run);
  assert.ok(context.length<5000);
  assert.equal(run.primaryObjective.length,9000);
});
