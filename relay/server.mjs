import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectionEnv, findConnection, publicConfig, saveConfig } from "./config.mjs";
import { loadRunStates, saveRunState } from "./run-store.mjs";
import { applyAuthoritativeGate, compactObjectiveContext, parseReview, phaseContext, recordReviewRound, recordTokenEstimate, reviewPrompt as buildReviewPrompt } from "./review-gate.mjs";

const PORT = 4317;
const runs = new Map();
for(const run of loadRunStates())runs.set(run.id,run);
const dashboard = readFileSync(new URL("./dashboard.html", import.meta.url));
const persistTimers=new Map();
function persist(run,immediate=false){
  if(immediate){clearTimeout(persistTimers.get(run.id));persistTimers.delete(run.id);saveRunState(run);return;}
  if(persistTimers.has(run.id))return;
  persistTimers.set(run.id,setTimeout(()=>{persistTimers.delete(run.id);saveRunState(run)},200));
}

function exec(bin, args, cwd, timeout = 30 * 60_000, run, onLine, env = process.env) {
  return new Promise((resolveRun, reject) => {
    if (run?.cancelled) return reject(new Error("Run stopped by user."));
    if(run?.steerRequested){const error=new Error("Run interrupted for user steering.");error.code="RELAY_STEER";return reject(error);}
    const child = spawn(bin, args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (run) run.children.add(child.pid);
    let out = "", err = "", buffer = "";
    const stop = signal => { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } };
    const timer = setTimeout(() => { stop("SIGTERM"); reject(new Error(`${bin} timed out`)); }, timeout);
    child.stdout.on("data", d => {
      const text = d.toString(); out += text;
      if (onLine) { buffer += text; const lines = buffer.split("\n"); buffer = lines.pop() || ""; for (const line of lines) if (line.trim()) onLine(line); }
    }); child.stderr.on("data", d => err += d);
    child.on("error", reject); child.on("close", code => {
      clearTimeout(timer); if (run) run.children.delete(child.pid);
      if (run?.cancelled) return reject(new Error("Run stopped by user."));
      if(run?.steerRequested){const error=new Error("Run interrupted for user steering.");error.code="RELAY_STEER";return reject(error);}
      if (code === 0) resolveRun({ out, err });
      else reject(new Error(`${bin} exited ${code}: ${err || out}`));
    });
  });
}
async function git(cwd, ...args) { return (await exec("git", args, cwd)).out.trim(); }
function emit(run, agent, text, state = "done") {
  const clean = String(text).replace(/\s+/g, " ").trim().slice(0, 420); if (!clean) return;
  const last = run.events.at(-1); if (last?.agent === agent && last?.text === clean) return;
  run.events.push({ at: new Date().toISOString(), agent, text: clean, state });
  if (run.events.length > 400) run.events.splice(0, run.events.length - 400);
  if (agent === "Relay" || state !== "live") message(run, agent, clean, state);
  run.activity[agent] = clean;
  run.updatedAt = new Date().toISOString();
  persist(run);
}
function message(run, agent, text, state = "message") {
  const clean=String(text).replace(/\s+/g," ").trim().slice(0,1200); if(!clean)return;
  const last=run.messages.at(-1); if(last?.agent===agent&&last?.text===clean)return;
  run.messages.push({at:new Date().toISOString(),agent,text:clean,state}); if(run.messages.length>120)run.messages.shift();
  persist(run);
}
function activity(run, agent, text) { run.activity[agent]=String(text).replace(/\s+/g," ").trim().slice(0,180); run.updatedAt=new Date().toISOString(); persist(run); }
function reviewAccepted(review){return ["APPROVE","FOLLOWUPS"].includes(review.verdict)&&review.blockers.length===0;}
function captureFollowups(run,reviews){const existing=new Set((run.secondaryObjectives||[]).map(item=>item.text.toLowerCase()));for(const review of reviews)for(const text of review.followups||[]){const clean=String(text).trim().slice(0,1200);if(clean&&!existing.has(clean.toLowerCase())){existing.add(clean.toLowerCase());addSecondary(run,clean,"review-followup");}}}
function reviewSummary(review){return review.verdict==="APPROVE"?"Approved phase":review.verdict==="FOLLOWUPS"?"Approved phase with follow-ups":`Requested revisions · ${review.blockers.length} blocker${review.blockers.length===1?"":"s"}`;}
function addSecondary(run,text,source="user"){const clean=String(text||"").trim().slice(0,3000);if(!clean)return null;const item={id:randomUUID().slice(0,8),text:clean,source,at:new Date().toISOString()};run.secondaryObjectives=run.secondaryObjectives||[];run.secondaryObjectives.push(item);message(run,source==="user"?"You":"Relay",`SECONDARY OBJECTIVE · ${clean}`,"objective");persist(run,true);return item;}
function addSteering(run,text){const clean=String(text||"").trim().slice(0,3000);if(!clean)return null;const item={id:randomUUID().slice(0,8),text:clean,at:new Date().toISOString()};run.steeringNotes=run.steeringNotes||[];run.steeringNotes.push(item);message(run,"You",`STEERING NOTE · ${clean}`,"steer");persist(run,true);return item;}
function objectiveContext(run){return compactObjectiveContext(run);}
function simpleError(value) {
  const text=String(value||"");
  const limit=text.match(/You've hit your session limit[^"\n}]*/i); if(limit)return limit[0].replace(/\\_/g,"_");
  if(/rate.limit|api_error_status"?:429|status.?429/i.test(text))return "Rate limit reached. Choose a backup agent or retry after the provider reset time.";
  if(/context window|token limit|maximum context|context length|too many tokens/i.test(text))return "The agent reached its context limit. Relay will continue from its latest handoff checkpoint when a backup is configured.";
  if(/OAuth access token is invalid|authentication_error/i.test(text))return "Authentication expired. Sign in to the agent again, then retry.";
  if(/ENOENT|not found/i.test(text))return "Agent program not found on this Mac. Install its CLI and sign in, then retry.";
  if(/not logged in|authentication required|copilot login|401|unauthorized/i.test(text))return "Agent authentication is missing or expired. Open Terminal, run the agent once, sign in, then retry.";
  const exit=text.match(/^(claude|codex|copilot|gemini) exited \d+:/i); return exit?`${exit[1]} stopped unexpectedly. Open Technical Log for details.`:text.slice(0,500);
}
function parseCodex(raw) { return raw.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter(e => e.type === "item.completed" && e.item?.type === "agent_message").map(e => e.item.text).join("\n") || raw; }
function claudeLine(run, line) { try {
  const e=JSON.parse(line);
  if(e.type==="system") { if(!run.connected.claude){run.connected.claude=true;message(run,"Claude",`Connected${e.model?` · ${e.model}`:""}`);} activity(run,"Claude","Connected and preparing context"); }
  if(e.type==="stream_event") { const v=e.event?.delta?.text; if(v){run.live.claude=(run.live.claude||"")+v; if(run.live.claude.length>1800)run.live.claude=run.live.claude.slice(-1800);} }
  if(e.type==="assistant") for(const b of e.message?.content||[]){ if(b.type==="text"){message(run,"Claude",b.text);activity(run,"Claude","Shared a message");} if(b.type==="tool_use") activity(run,"Claude",`${b.name}${b.input?.command?` · ${b.input.command}`:""}`); }
  if(e.type==="result") activity(run,"Claude","Turn completed");
} catch { activity(run,"Claude","Processing output"); } }
function codexLine(run, line) { try {
  const e=JSON.parse(line),i=e.item;
  if(e.type==="thread.started") { if(!run.connected.codex){run.connected.codex=true;message(run,"Codex","Connected");} activity(run,"Codex","Connected and preparing context"); }
  if(e.type==="turn.started") activity(run,"Codex","Reasoning about the assignment");
  if(e.type==="item.started") activity(run,"Codex",i?.type==="command_execution"?`Running · ${i.command}`:`Working · ${i?.type||"task"}`);
  if(e.type==="item.completed"&&i?.type==="agent_message") { run.live.codex=i.text||""; message(run,"Codex",i.text); activity(run,"Codex","Shared a message"); }
  if(e.type==="item.completed"&&i?.type==="command_execution") activity(run,"Codex",`Command finished${i.exit_code!=null?` · exit ${i.exit_code}`:""}`);
  if(e.type==="item.completed"&&i?.type==="file_change") activity(run,"Codex","Updated project files");
  if(e.type==="turn.completed") activity(run,"Codex","Turn completed");
} catch { activity(run,"Codex","Processing output"); } }
function geminiLine(run,line){try{const e=JSON.parse(line);if(e.type==="init"){if(!run.connected.gemini){run.connected.gemini=true;message(run,"Gemini",`Connected${e.model?` · ${e.model}`:""}`);}activity(run,"Gemini","Connected and preparing context");}if(e.type==="message"&&e.role==="assistant"){const text=e.content||e.text||"";run.live.gemini=(run.live.gemini||"")+text;if(text.trim())message(run,"Gemini",text);activity(run,"Gemini","Shared a message");}if(e.type==="tool_use")activity(run,"Gemini",`Tool · ${e.tool_name||e.name||"working"}`);if(e.type==="tool_result")activity(run,"Gemini","Tool completed");if(e.type==="result")activity(run,"Gemini","Turn completed");if(e.type==="error")activity(run,"Gemini",`Warning · ${e.message||"provider error"}`);}catch{activity(run,"Gemini","Processing output");}}
function copilotText(value){if(typeof value==="string")return value;if(Array.isArray(value))return value.map(copilotText).filter(Boolean).join("\n");if(!value||typeof value!=="object")return "";return copilotText(value.text||value.content||value.message||value.delta||value.result||"");}
function copilotLine(run,line){try{const e=JSON.parse(line);if(!run.connected.copilot){run.connected.copilot=true;message(run,"Copilot",`Connected${e.model?` · ${e.model}`:""}`);}const type=String(e.type||e.event||"").toLowerCase();if(/tool.*start|tool_call|command.*start/.test(type)){activity(run,"Copilot",`Running · ${e.tool?.name||e.tool_name||e.name||e.command||"tool"}`);return;}if(/tool.*complete|command.*complete/.test(type)){activity(run,"Copilot","Tool completed");return;}const value=copilotText(e);if(value&&/assistant|message|response|content|delta/.test(type)){run.live.copilot=(run.live.copilot||"")+value;if(run.live.copilot.length>1800)run.live.copilot=run.live.copilot.slice(-1800);activity(run,"Copilot","Writing a response");}else activity(run,"Copilot","Working");}catch{if(!run.connected.copilot){run.connected.copilot=true;message(run,"Copilot","Connected");}activity(run,"Copilot","Processing output");}}
async function claude(prompt, cwd, write = false, run, env = process.env) {
  const args=["-p",prompt,"--output-format","stream-json","--verbose","--include-partial-messages","--permission-mode",write?"auto":"plan"];
  let raw;
  try { raw=(await exec("claude",args,cwd,45*60_000,run,line=>claudeLine(run,line),env)).out; }
  catch(error) { if(error.code!=="RELAY_STEER"&&!run?.cancelled){run.failedAgent="Claude";run.failureReason=simpleError(error.message);activity(run,"Claude","Failed · waiting for your decision");} error.friendlyMessage=simpleError(error.message); throw error; }
  const events=raw.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);
  return events.findLast(e=>e.type==="result")?.result||events.filter(e=>e.type==="assistant").flatMap(e=>e.message?.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");
}
async function codex(prompt, cwd, write = false, run, env = process.env) { const args=["exec","--json","--sandbox",write?"workspace-write":"read-only",prompt]; try{return parseCodex((await exec("codex",args,cwd,45*60_000,run,line=>codexLine(run,line),env)).out);}catch(error){if(error.code!=="RELAY_STEER"&&!run?.cancelled){run.failedAgent="Codex";run.failureReason=simpleError(error.message);activity(run,"Codex","Failed");}error.friendlyMessage=simpleError(error.message);throw error;} }
async function gemini(prompt,cwd,write=false,run,env=process.env){const args=["-p",prompt,"--output-format","stream-json"];if(write)args.push("--yolo");try{const raw=(await exec("gemini",args,cwd,45*60_000,run,line=>geminiLine(run,line),env)).out;const events=raw.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);return events.filter(e=>e.type==="message"&&e.role==="assistant").map(e=>e.content||e.text||"").join("\n")||events.findLast(e=>e.type==="result")?.response||raw;}catch(error){if(error.code!=="RELAY_STEER"&&!run?.cancelled){run.failedAgent="Gemini";run.failureReason=simpleError(error.message);activity(run,"Gemini","Failed");}error.friendlyMessage=simpleError(error.message);throw error;}}
async function copilot(prompt,cwd,write=false,run,env=process.env){const args=["-p",prompt,"-s","--no-ask-user","--no-remote",write?"--allow-all":"--plan"];if(!write)args.push("--allow-all-tools");try{if(!run.connected.copilot){run.connected.copilot=true;message(run,"Copilot","Connected");}activity(run,"Copilot",write?"Working in isolated branch":"Inspecting repository");const result=(await exec("copilot",args,cwd,45*60_000,run,undefined,env)).out.trim();if(result){message(run,"Copilot",result);activity(run,"Copilot","Turn completed");}return result;}catch(error){if(error.code!=="RELAY_STEER"&&!run?.cancelled){run.failedAgent="Copilot";run.failureReason=simpleError(error.message);activity(run,"Copilot","Failed");}error.friendlyMessage=simpleError(error.message);throw error;}}
function renderArgs(args,prompt){return (args||[]).map(value=>String(value).replaceAll("{prompt}",prompt));}
async function custom(connection,prompt,cwd,write,run,env){const args=renderArgs(write?connection.writeArgs:connection.readArgs,prompt);if(!connection.command||!args.length)throw new Error(`${connection.label} is missing a command or prompt arguments.`);activity(run,connection.label,write?"Working in isolated branch":"Inspecting repository");const result=(await exec(connection.command,args,cwd,45*60_000,run,undefined,env)).out.trim();if(result)message(run,connection.label,result);activity(run,connection.label,"Turn completed");return result;}
async function callAgent(name,prompt,cwd,write,run){const connection=findConnection(name);if(!connection)throw new Error(`Unknown connection: ${name}`);const env=connectionEnv(connection),provider=connection.provider,label=connection.label||name;let result;if(provider==="Claude")result=await claude(prompt,cwd,write,run,env);else if(provider==="Codex")result=await codex(prompt,cwd,write,run,env);else if(provider==="Copilot")result=await copilot(prompt,cwd,write,run,env);else if(provider==="Gemini")result=await gemini(prompt,cwd,write,run,env);else result=await custom(connection,prompt,cwd,write,run,env);recordTokenEstimate(run,label,prompt,result);persist(run,true);return result;}
async function recoveryContext(role,cwd,run){let checkpoint="No checkpoint was written before the interruption.";const file=run.handoffFiles?.[role];if(file&&existsSync(file))checkpoint=readFileSync(file,"utf8").slice(-16000);let status="",diff="";try{status=await git(cwd,"status","--short");diff=(await git(cwd,"diff","--stat")).slice(0,6000);}catch{}return `\n\nTAKEOVER CONTEXT\nYou are replacing an interrupted agent in the SAME isolated worktree. Preserve its valid changes and continue instead of restarting. Inspect the working tree before editing.\nCHECKPOINT:\n${checkpoint}\nGIT STATUS:\n${status||"clean"}\nDIFF SUMMARY:\n${diff||"none"}\nUpdate the checkpoint after your next coherent milestone.`;}
async function waitForTakeover(role,prompt,cwd,write,run,selected){run.status="needs_attention";run.pendingTakeover={role,failed:selected};addSecondary(run,`Recover ${role} work after ${selected} stopped: ${run.failureReason||"connection unavailable"}`,"recovery");message(run,"Relay",`${selected} paused. Choose a replacement to continue the same worktree.`,"handoff");return new Promise((resolveTakeover,rejectTakeover)=>{run.takeoverRejecter=rejectTakeover;run.takeoverResolver=async replacement=>{try{const continuation=await recoveryContext(role,cwd,run);run.roles[role]=replacement;run.failedAgents.push(selected);run.failedAgent=null;run.failureReason=null;run.pendingTakeover=null;run.status="running";message(run,"Relay",`${replacement} is taking over ${selected}'s ${role} work from the latest checkpoint.`,"handoff");resolveTakeover(await callWithBackup(role,`${prompt}\n\n${objectiveContext(run)}${continuation}`,cwd,write,run));}catch(error){rejectTakeover(error);}finally{run.takeoverResolver=null;run.takeoverRejecter=null;}};});}
async function callWithBackup(role,prompt,cwd,write,run){const selected=run.roles[role];try{return await callAgent(selected,prompt,cwd,write,run);}catch(error){if(run.cancelled||error.code==="RELAY_STEER")throw error;run.failedAgent=selected;run.failureReason=simpleError(error.message);const backup=run.backupAgent;if(!run.autoFailover||!backup||backup===selected||run.failedAgents.includes(backup))return waitForTakeover(role,prompt,cwd,write,run,selected);run.failedAgents.push(selected);message(run,"Relay",`${selected} became unavailable. ${backup} is resuming the same ${role} worktree from its checkpoint.`,"handoff");const continuation=await recoveryContext(role,cwd,run);run.roles[role]=backup;run.failedAgent=null;run.failureReason=null;return callAgent(backup,`${prompt}${continuation}`,cwd,write,run);}}
function taskText(value){if(typeof value==="string")return value;if(value==null)return "";return JSON.stringify(value,null,2);}
async function makeWorktree(repo, root, name, base) { const path = join(root, name); await git(repo, "worktree", "add", "-b", `relay/${name}`, path, base); return path; }
async function commitIfNeeded(path, message) { if (!(await git(path, "status", "--porcelain"))) return false; await git(path, "add", "-A"); await git(path, "commit", "-m", message); return true; }

function waitForPlanDecision(run){run.status="awaiting_plan";persist(run,true);return new Promise((resolve,reject)=>{run.planDecisionResolver=resolve;run.planDecisionRejecter=reject;});}
async function approvePlan(run,repo,initial){
  let split=initial;
  while(true){
    run.split=split;run.plan=split;message(run,"Relay",`PLAN READY\n${taskText(split)}`,"plan");
    const decision=await waitForPlanDecision(run);
    run.planDecisionResolver=null;run.planDecisionRejecter=null;
    if(decision.action==="approve"){run.phase={id:`phase-${Date.now()}`,summary:split.phaseSummary||split.summary||"Approved implementation phase",acceptanceCriteria:Array.isArray(split.acceptanceCriteria)?split.acceptanceCriteria:[],outOfScope:Array.isArray(split.outOfScope)?split.outOfScope:[],approvedAt:new Date().toISOString(),status:"active"};for(const item of (Array.isArray(split.deferredObjectives)?split.deferredObjectives:[]).slice(0,12))addSecondary(run,typeof item==="string"?item:taskText(item),"plan-deferred");run.status="running";message(run,"Relay","Phase plan approved. Its acceptance criteria are now frozen for review.","plan");persist(run,true);return split;}
    emit(run,"Relay","Revising the plan using your direction","handoff");
    const revised=await callWithBackup("primary",`Revise the current phase plan using the user's direction. Keep assignments non-overlapping, bounded, and evidence-driven. Do not expand the phase. Return ONLY JSON with keys phaseSummary, primaryTask, partnerTask, acceptanceCriteria, outOfScope, deferredObjectives, and decisionRules.\nCURRENT PLAN:\n${taskText(split)}\nUSER DIRECTION:\n${decision.instruction}`,repo,false,run);
    const match=revised.match(/\{[\s\S]*\}/);if(!match)throw new Error("Supervisor did not return a valid revised plan.");split=JSON.parse(match[0]);
  }
}

async function resumeInterrupted(run,steering="") {
  try{
    const working=[run.integrationPath,run.primaryPath,run.partnerPath].find(path=>path&&existsSync(path));
    if(!working)throw new Error("The saved worktree folder is no longer available. The messages and technical history are still preserved.");
    const direction=steering||run.steerRequested||"";run.steerRequested=null;run.status="running";run.recoverable=false;run.cancelled=false;run.failedAgent=null;run.failureReason=null;run.pendingTakeover=null;run.error=null;run.agreement=false;
    emit(run,"Relay","Resuming preserved session from its last durable checkpoint","handoff");persist(run,true);
    const siblingPaths=[run.primaryPath,run.partnerPath,run.integrationPath].filter((path,index,list)=>path&&path!==working&&existsSync(path)&&list.indexOf(path)===index);
    const context=await recoveryContext("primary",working,run);
    const recoveryPrompt=`Recover this interrupted Agent Relay session without restarting or discarding valid work.
${phaseContext(run)}
ACTIVE WORKTREE:
${working}
OTHER PRESERVED WORKTREES:
${siblingPaths.join("\n")||"none"}
USER STEERING DIRECTION:
${direction||"Continue the approved plan."}
Inspect every preserved worktree and its Git history/status. Reconcile valid committed or uncommitted work into the active worktree, resolve conflicts carefully, follow the user's steering direction, and finish only the approved phase. Do not reopen the full roadmap. Run focused tests and leave the active worktree in a coherent committed state. Do not touch main and do not push.${context}`;
    await callWithBackup("primary",recoveryPrompt,working,true,run);
    await commitIfNeeded(working,`Agent Relay: resume interrupted run ${run.id}`);
    run.integrationPath=working;run.integrationBranch=await git(working,"branch","--show-current");
    for(let round=1;round<=run.maxRounds;round++){
      run.round=round;emit(run,"Relay",`Running recovered-session verification round ${round}`,"live");
      const test=await exec("/bin/bash",["-lc",run.testCommand],working,20*60_000,run,line=>emit(run,"Tests",line,"live")).catch(error=>({out:"",err:error.message,failed:true}));
      run.transcript[`recoveryTests${round}`]=`${test.out}\n${test.err}`;
      run.lastTestPassed=!test.failed;const prompt=buildReviewPrompt(run,{testOutput:run.transcript[`recoveryTests${round}`],round,recovered:true});
      const [primaryReview,partnerReview]=await Promise.all([callWithBackup("primary",prompt,working,false,run),callWithBackup("partner",prompt,working,false,run)]);
      run.transcript[`recoveryPrimaryReview${round}`]=primaryReview;run.transcript[`recoveryPartnerReview${round}`]=partnerReview;
      const primaryResult=applyAuthoritativeGate(parseReview(primaryReview),{testsPassed:!test.failed}),partnerResult=applyAuthoritativeGate(parseReview(partnerReview),{testsPassed:!test.failed}),openFindings=recordReviewRound(run,[{agent:run.roles.primary,review:primaryResult},{agent:run.roles.partner,review:partnerResult}],round);
      emit(run,run.roles.primary,reviewSummary(primaryResult));emit(run,run.roles.partner,reviewSummary(partnerResult));
      const approved=!test.failed&&reviewAccepted(primaryResult)&&reviewAccepted(partnerResult)&&openFindings.length===0;
      if(approved){run.agreement=true;captureFollowups(run,[primaryResult,partnerResult]);run.phaseOutcome=[primaryResult.verdict,partnerResult.verdict].includes("FOLLOWUPS")?"approved_with_followups":"approved";break;}
      if(round===run.maxRounds)break;
      await callWithBackup("primary",`Repair only the open blockers for the frozen approved phase.\n${phaseContext(run)}\nOPEN FINDINGS:\n${taskText(openFindings)}\nAUTHORITATIVE TEST OUTPUT:\n${run.transcript[`recoveryTests${round}`]}\nPreserve valid existing work. Do not expand scope or revisit verified findings.`,working,true,run);
      await commitIfNeeded(working,`Agent Relay: recovered repair round ${round}`);
    }
    if(!run.agreement)throw new Error("The recovered session did not pass both reviews. Its branch and full history remain preserved.");
    run.status="completed";if(run.phase)run.phase.status=run.phaseOutcome||"approved";emit(run,"Relay",`Recovered phase ${run.phaseOutcome==="approved_with_followups"?"approved with follow-ups":"approved"}; ${run.integrationBranch} is ready`);persist(run,true);
  }catch(error){if(error.code==="RELAY_STEER"){const direction=run.steerRequested;run.status="steering";message(run,"Relay","Direction updated again. Continuing from the latest checkpoint.","handoff");persist(run,true);setTimeout(()=>resumeInterrupted(run,direction),0);return;}run.status=run.cancelled?"stopped":"failed";run.error=run.cancelled?"Run stopped safely.":(error.friendlyMessage||simpleError(error.message));run.recoverable=Boolean([run.integrationPath,run.primaryPath,run.partnerPath].some(path=>path&&existsSync(path)));emit(run,"Relay",run.error,run.cancelled?"stopped":"error");persist(run,true);}
}

async function coordinate(run) {
  let tempRoot;
  try {
    run.status = "running"; emit(run, "Relay", "Validating repository and native agent connections", "live");
    const repo = resolve(run.repoPath); if (!existsSync(join(repo, ".git"))) throw new Error("Choose a local Git repository folder.");
    for(const id of new Set([run.primaryAgent,run.partnerAgent,run.backupAgent].filter(Boolean))){const c=findConnection(id);if(!c)throw new Error(`Unknown connection: ${id}`);await exec(c.command,c.provider==="Custom"?(c.versionArgs||[]):["--version"],repo,15_000,undefined,undefined,connectionEnv(c));}
    if (await git(repo, "status", "--porcelain")) throw new Error("The main checkout has uncommitted changes. Commit or stash them first.");
    const base = await git(repo, "branch", "--show-current"); const baseSha = await git(repo, "rev-parse", "HEAD"); run.base = base; run.baseSha = baseSha;
    tempRoot = await mkdtemp(join(tmpdir(), `agent-relay-${run.id}-`));run.tempRoot=tempRoot;
    run.handoffFiles={primary:join(tempRoot,"primary-handoff.md"),partner:join(tempRoot,"partner-handoff.md")};
    const primaryPath = await makeWorktree(repo, tempRoot, `${run.id}-primary`, baseSha); const partnerPath = await makeWorktree(repo, tempRoot, `${run.id}-partner`, baseSha);run.primaryPath=primaryPath;run.partnerPath=partnerPath;persist(run,true);
    emit(run, "Relay", `Created isolated ${run.primaryAgent} and ${run.partnerAgent} worktrees`); emit(run, run.primaryAgent, "Independent architecture assessment started", "live"); emit(run, run.partnerAgent, "Independent risk and test assessment started", "live");
    const checkpointRule=(role)=>`Maintain a durable handoff at ${run.handoffFiles[role]}. After each coherent milestone, overwrite it with: objective, decisions, files inspected/changed, commands and results, remaining work, risks, and the exact next action. If context feels crowded or service limits approach, finish the smallest safe checkpoint, update this handoff, and stop cleanly.`;
    const brief = role => `${objectiveContext(run)}\nInspect independently without editing. Select the smallest valuable phase that can pass in this run. Identify evidence, risks, tests, file ownership, and explicitly deferred roadmap work. Stay under 900 words.\n${checkpointRule(role)}`;
    const [pa,sa] = await Promise.all([callWithBackup("primary",brief("primary"),primaryPath,false,run),callWithBackup("partner",brief("partner"),partnerPath,false,run)]);
    run.transcript.primaryAssessment=pa;run.transcript.partnerAssessment=sa;emit(run,run.roles.primary,"Assessment delivered");emit(run,run.roles.partner,"Assessment delivered");
    emit(run,"Relay",`${run.roles.primary} is splitting work using both assessments`,"live");
    const splitRaw=await callWithBackup("primary",`Create ONE bounded phase plan, not a plan for the entire roadmap. Freeze measurable acceptance criteria for this run, divide non-overlapping file ownership, and defer everything else. A phase should be small enough to implement and review within ${run.maxRounds} rounds. Only evidence-backed security, data-loss, destructive-migration, unmet frozen criteria, or authoritative failing tests may block. Return ONLY JSON with keys phaseSummary, primaryTask, partnerTask, acceptanceCriteria, outOfScope, deferredObjectives, and decisionRules.\n${objectiveContext(run)}\nPRIMARY ASSESSMENT:\n${pa.slice(0,7000)}\nPARTNER ASSESSMENT:\n${sa.slice(0,7000)}`,repo,false,run);
    const match=splitRaw.match(/\{[\s\S]*\}/);if(!match)throw new Error("Supervisor did not return a valid task split.");const split=await approvePlan(run,repo,JSON.parse(match[0]));
    emit(run,run.roles.primary,"Implementation assignment started","live");emit(run,run.roles.partner,"Implementation assignment started","live");
    const common = role => `${phaseContext(run)}\nWork only on your assignment and frozen acceptance criteria. Do not implement deferred roadmap work. Do not modify files outside your ownership unless essential; explain exceptions. Run focused tests. Do not push or merge. Keep the final handoff under 900 words.\n${checkpointRule(role)}`;
    const [pi,si]=await Promise.all([callWithBackup("primary",`${common("primary")}\nYour assignment:\n${taskText(split.primaryTask)}`,primaryPath,true,run),callWithBackup("partner",`${common("partner")}\nYour assignment:\n${taskText(split.partnerTask)}`,partnerPath,true,run)]);
    run.transcript.primaryImplementation=pi;run.transcript.partnerImplementation=si;
    const pc=await commitIfNeeded(primaryPath,`Agent Relay: primary implementation ${run.id}`);const sc=await commitIfNeeded(partnerPath,`Agent Relay: partner implementation ${run.id}`);
    emit(run,run.roles.primary,pc?"Changes committed to isolated branch":"No changes required");emit(run,run.roles.partner,sc?"Changes committed to isolated branch":"No changes required");
    const integration = join(tempRoot, `${run.id}-integration`); await git(repo, "worktree", "add", "-b", `relay/${run.id}-integration`, integration, baseSha); run.integrationBranch = `relay/${run.id}-integration`;run.integrationPath=integration;persist(run,true);
    if(pc)await git(integration,"merge","--no-edit",`relay/${run.id}-primary`);if(sc)await git(integration,"merge","--no-edit",`relay/${run.id}-partner`);
    emit(run, "Relay", "Both implementations combined on the integration branch");
    for (let round = 1; round <= run.maxRounds; round++) {
      run.round = round; emit(run, "Relay", `Running verification round ${round}`, "live");
      const test = await exec("/bin/bash", ["-lc", run.testCommand], integration, 20 * 60_000, run, line => emit(run,"Tests",line,"live")).catch(e => ({ out: "", err: e.message, failed: true })); run.transcript[`tests${round}`] = `${test.out}\n${test.err}`;run.lastTestPassed=!test.failed;
      const reviewPrompt = buildReviewPrompt(run,{baseSha,testOutput:run.transcript[`tests${round}`],round});
      const [pr,sr]=await Promise.all([callWithBackup("primary",reviewPrompt,integration,false,run),callWithBackup("partner",reviewPrompt,integration,false,run)]);run.transcript[`primaryReview${round}`]=pr;run.transcript[`partnerReview${round}`]=sr;
      const primaryResult=applyAuthoritativeGate(parseReview(pr),{testsPassed:!test.failed}),partnerResult=applyAuthoritativeGate(parseReview(sr),{testsPassed:!test.failed}),openFindings=recordReviewRound(run,[{agent:run.roles.primary,review:primaryResult},{agent:run.roles.partner,review:partnerResult}],round);
      emit(run,run.roles.primary,reviewSummary(primaryResult));emit(run,run.roles.partner,reviewSummary(partnerResult));
      const approved=!test.failed&&reviewAccepted(primaryResult)&&reviewAccepted(partnerResult)&&openFindings.length===0;
      if (approved) { run.agreement = true;captureFollowups(run,[primaryResult,partnerResult]);run.phaseOutcome=[primaryResult.verdict,partnerResult.verdict].includes("FOLLOWUPS")?"approved_with_followups":"approved";break; }
      if (round === run.maxRounds) break;
      emit(run, "Relay", `Sending both reviews back to ${run.roles.primary} for repair`, "live");
      await callWithBackup("primary",`Repair only the open blockers for the frozen approved phase.\n${phaseContext(run)}\nOPEN FINDINGS:\n${taskText(openFindings)}\nAUTHORITATIVE TEST OUTPUT:\n${run.transcript[`tests${round}`]}\nDo not expand scope, implement follow-ups, or revisit verified findings. Make the smallest safe fixes and run focused tests.`,integration,true,run);
      await commitIfNeeded(integration, `Agent Relay: repair round ${round}`);
    }
    if (!run.agreement) throw new Error("The agents did not reach agreement within the review limit. Integration branch preserved for inspection.");
    if(run.phase)run.phase.status=run.phaseOutcome||"approved";emit(run, "Relay", run.phaseOutcome==="approved_with_followups"?"Phase approved with follow-ups; authoritative tests passed":"Phase approved by both agents; authoritative tests passed");
    if (run.mergeMain) { if (await git(repo, "status", "--porcelain")) throw new Error("Main changed during the run; refusing automatic merge."); await git(repo, "merge", "--no-ff", run.integrationBranch, "-m", `Merge ${run.integrationBranch}`); emit(run, "Relay", `Merged safely into ${base}`); }
    run.status = "completed"; emit(run, "Relay", run.mergeMain ? "Team run completed and merged" : `Team run completed; ${run.integrationBranch} is ready`);
  } catch (error) { if(error.code==="RELAY_STEER"){const direction=run.steerRequested;run.status="steering";message(run,"Relay","Agents interrupted safely. Resuming from preserved work with your new direction.","handoff");persist(run,true);setTimeout(()=>resumeInterrupted(run,direction),0);return;}run.status = run.cancelled ? "stopped" : "failed"; run.error = run.cancelled ? "Run stopped safely." : (error.friendlyMessage||simpleError(error.message)); run.recoverable=Boolean([run.integrationPath,run.primaryPath,run.partnerPath].some(path=>path&&existsSync(path)));emit(run, "Relay", run.error, run.cancelled ? "stopped" : "error"); }
  finally { persist(run,true);if (tempRoot) { /* worktrees remain registered for inspection; cleanup is explicit */ } }
}

function json(res, code, body) { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(dashboard); }
  if (req.method === "GET" && req.url === "/api/settings") return json(res,200,publicConfig());
  if (req.method === "PUT" && req.url === "/api/settings") { let body=""; for await(const c of req)body+=c; try{return json(res,200,saveConfig(JSON.parse(body)));}catch(error){return json(res,400,{error:error.message});} }
  if (req.method === "GET" && req.url === "/api/health") { const items=publicConfig().connections;const checks={};for(const c of items)checks[c.id]=await exec(c.command,c.provider==="Custom"?(c.versionArgs||[]):["--version"],process.cwd(),5_000,undefined,undefined,connectionEnv(c)).then(()=>true).catch(()=>false);return json(res,200,{connections:checks,claude:checks.Claude,codex:checks.Codex,copilot:checks.Copilot,gemini:checks.Gemini}); }
  if(req.method==="GET"&&req.url==="/api/runs")return json(res,200,[...runs.values()].sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt))).map(run=>({id:run.id,status:run.status,goal:run.goal,primaryObjective:run.primaryObjective||run.goal,secondaryCount:(run.secondaryObjectives||[]).length,steeringCount:(run.steeringNotes||[]).length,repoPath:run.repoPath,createdAt:run.createdAt,updatedAt:run.updatedAt,recoverable:Boolean(run.recoverable),integrationBranch:run.integrationBranch,error:run.error})));
  if (req.method === "POST" && req.url === "/api/runs") { let body=""; for await (const c of req) body+=c; try { const input=JSON.parse(body);const primary=input.primaryAgent||"Claude",partner=input.partnerAgent||"Codex",backup=input.backupAgent||null,primaryObjective=String(input.primaryObjective||input.goal||"").trim();if(!primaryObjective)throw new Error("Enter a primary objective.");if(primary===partner)throw new Error("Primary and partner must be different agents.");const run={id:randomUUID().slice(0,8),repoPath:input.repoPath,goal:primaryObjective,primaryObjective,secondaryObjectives:[],steeringNotes:[],phase:null,phaseOutcome:null,findingLedger:[],tokenUsage:{},tokenTotal:0,lastTestPassed:false,primaryAgent:primary,partnerAgent:partner,backupAgent:backup,autoFailover:Boolean(input.autoFailover),roles:{primary,partner},failedAgents:[],maxRounds:Math.min(4,Math.max(1,Number(input.maxRounds)||3)),testCommand:input.testCommand||"npm test",mergeMain:Boolean(input.mergeMain),status:"queued",events:[],messages:[],activity:{Relay:"Starting",Claude:"Waiting",Codex:"Waiting",Copilot:"Waiting",Gemini:"Waiting",Tests:"Idle"},connected:{claude:false,codex:false,copilot:false,gemini:false},live:{claude:"",codex:"",copilot:"",gemini:""},transcript:{},children:new Set(),cancelled:false,createdAt:new Date().toISOString()}; runs.set(run.id,run);persist(run,true);coordinate(run); return json(res,202,{...run,children:undefined}); } catch(e){return json(res,400,{error:e.message});} }
  const resume=req.url?.match(/^\/api\/runs\/([\w-]+)\/resume$/);if(req.method==="POST"&&resume){const run=runs.get(resume[1]);if(!run)return json(res,404,{error:"Run not found"});if(["running","queued","needs_attention"].includes(run.status))return json(res,409,{error:"This session is already active."});let body="";for await(const c of req)body+=c;try{const input=body?JSON.parse(body):{};const primary=input.primaryAgent||run.roles?.primary||run.primaryAgent,partner=input.partnerAgent||run.roles?.partner||run.partnerAgent;if(primary===partner)throw new Error("Choose two different agents.");if(!findConnection(primary)||!findConnection(partner))throw new Error("Choose valid agent connections.");run.roles={primary,partner};run.primaryAgent=primary;run.partnerAgent=partner;run.backupAgent=input.backupAgent??run.backupAgent;run.autoFailover=Boolean(input.autoFailover);resumeInterrupted(run);return json(res,202,{status:"resuming",id:run.id});}catch(error){return json(res,400,{error:error.message});}}
  const planDecision=req.url?.match(/^\/api\/runs\/([\w-]+)\/plan$/);if(req.method==="POST"&&planDecision){const run=runs.get(planDecision[1]);if(!run)return json(res,404,{error:"Run not found"});if(!run.planDecisionResolver)return json(res,409,{error:"This run is not waiting for plan approval."});let body="";for await(const c of req)body+=c;try{const input=JSON.parse(body),action=input.action;if(!["approve","steer"].includes(action))throw new Error("Choose approve or steer.");const instruction=String(input.instruction||"").trim();if(action==="steer"&&!instruction)throw new Error("Tell the agents what to change in the plan.");if(action==="steer")addSteering(run,instruction);run.planDecisionResolver({action,instruction});return json(res,202,{status:action==="approve"?"approved":"revising"});}catch(error){return json(res,400,{error:error.message});}}
  const objective=req.url?.match(/^\/api\/runs\/([\w-]+)\/objectives$/);if(req.method==="POST"&&objective){const run=runs.get(objective[1]);if(!run)return json(res,404,{error:"Run not found"});let body="";for await(const c of req)body+=c;try{const item=addSecondary(run,JSON.parse(body).text,"user");if(!item)throw new Error("Enter a secondary objective.");return json(res,201,item);}catch(error){return json(res,400,{error:error.message});}}
  const steer=req.url?.match(/^\/api\/runs\/([\w-]+)\/steer$/);if(req.method==="POST"&&steer){const run=runs.get(steer[1]);if(!run)return json(res,404,{error:"Run not found"});let body="";for await(const c of req)body+=c;try{const instruction=String(JSON.parse(body).instruction||"").trim();if(!instruction)throw new Error("Enter a direction for the agents.");addSteering(run,instruction);if(run.planDecisionResolver){run.planDecisionResolver({action:"steer",instruction});return json(res,202,{status:"revising_plan"});}run.steerRequested=instruction;run.status="steering";emit(run,"Relay","Interrupting agents safely and saving their current work","handoff");persist(run,true);for(const pid of run.children){try{process.kill(-pid,"SIGTERM")}catch{}}return json(res,202,{status:"steering"});}catch(error){return json(res,400,{error:error.message});}}
  const takeover=req.url?.match(/^\/api\/runs\/([\w-]+)\/takeover$/);if(req.method==="POST"&&takeover){const run=runs.get(takeover[1]);if(!run)return json(res,404,{error:"Run not found"});if(!run.takeoverResolver)return json(res,409,{error:"This run is not waiting for a replacement."});let body="";for await(const c of req)body+=c;try{const replacement=JSON.parse(body).replacement;if(!findConnection(replacement))throw new Error("Choose a valid connection.");run.takeoverResolver(replacement);return json(res,202,{status:"resuming",replacement,retry:replacement===run.pendingTakeover?.failed});}catch(error){return json(res,400,{error:error.message});}}
  const stop=req.url?.match(/^\/api\/runs\/([\w-]+)\/stop$/); if(req.method==="POST"&&stop){const run=runs.get(stop[1]);if(!run)return json(res,404,{error:"Run not found"});run.cancelled=true;run.status="stopping";emit(run,"Relay","Stopping active agents and tests","live");if(run.takeoverRejecter)run.takeoverRejecter(new Error("Run stopped by user."));if(run.planDecisionRejecter)run.planDecisionRejecter(new Error("Run stopped by user."));for(const pid of run.children){try{process.kill(-pid,"SIGTERM")}catch{}}return json(res,202,{status:"stopping"});}
  const m=req.url?.match(/^\/api\/runs\/([\w-]+)$/); if(req.method==="GET"&&m) return runs.has(m[1])?json(res,200,runs.get(m[1])):json(res,404,{error:"Run not found"});
  json(res,404,{error:"Not found"});
});
server.listen(PORT,"127.0.0.1",()=>console.log(`Agent Relay is ready at http://127.0.0.1:${PORT}`));
