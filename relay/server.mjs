import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectionEnv, findConnection, publicConfig, saveConfig } from "./config.mjs";

const PORT = 4317;
const runs = new Map();
const dashboard = readFileSync(new URL("./dashboard.html", import.meta.url));

function exec(bin, args, cwd, timeout = 30 * 60_000, run, onLine, env = process.env) {
  return new Promise((resolveRun, reject) => {
    if (run?.cancelled) return reject(new Error("Run stopped by user."));
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
}
function message(run, agent, text, state = "message") {
  const clean=String(text).replace(/\s+/g," ").trim().slice(0,1200); if(!clean)return;
  const last=run.messages.at(-1); if(last?.agent===agent&&last?.text===clean)return;
  run.messages.push({at:new Date().toISOString(),agent,text:clean,state}); if(run.messages.length>120)run.messages.shift();
}
function activity(run, agent, text) { run.activity[agent]=String(text).replace(/\s+/g," ").trim().slice(0,180); run.updatedAt=new Date().toISOString(); }
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
  catch(error) { if(!run?.cancelled){run.failedAgent="Claude";run.failureReason=simpleError(error.message);activity(run,"Claude","Failed · waiting for your decision");} error.friendlyMessage=simpleError(error.message); throw error; }
  const events=raw.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);
  return events.findLast(e=>e.type==="result")?.result||events.filter(e=>e.type==="assistant").flatMap(e=>e.message?.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n");
}
async function codex(prompt, cwd, write = false, run, env = process.env) { const args=["exec","--json","--sandbox",write?"workspace-write":"read-only",prompt]; try{return parseCodex((await exec("codex",args,cwd,45*60_000,run,line=>codexLine(run,line),env)).out);}catch(error){if(!run?.cancelled){run.failedAgent="Codex";run.failureReason=simpleError(error.message);activity(run,"Codex","Failed");}error.friendlyMessage=simpleError(error.message);throw error;} }
async function gemini(prompt,cwd,write=false,run,env=process.env){const args=["-p",prompt,"--output-format","stream-json"];if(write)args.push("--yolo");try{const raw=(await exec("gemini",args,cwd,45*60_000,run,line=>geminiLine(run,line),env)).out;const events=raw.split("\n").filter(Boolean).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);return events.filter(e=>e.type==="message"&&e.role==="assistant").map(e=>e.content||e.text||"").join("\n")||events.findLast(e=>e.type==="result")?.response||raw;}catch(error){if(!run?.cancelled){run.failedAgent="Gemini";run.failureReason=simpleError(error.message);activity(run,"Gemini","Failed");}error.friendlyMessage=simpleError(error.message);throw error;}}
async function copilot(prompt,cwd,write=false,run,env=process.env){const args=["-p",prompt,"-s","--no-ask-user","--no-remote",write?"--allow-all":"--plan"];if(!write)args.push("--allow-all-tools");try{if(!run.connected.copilot){run.connected.copilot=true;message(run,"Copilot","Connected");}activity(run,"Copilot",write?"Working in isolated branch":"Inspecting repository");const result=(await exec("copilot",args,cwd,45*60_000,run,undefined,env)).out.trim();if(result){message(run,"Copilot",result);activity(run,"Copilot","Turn completed");}return result;}catch(error){if(!run?.cancelled){run.failedAgent="Copilot";run.failureReason=simpleError(error.message);activity(run,"Copilot","Failed");}error.friendlyMessage=simpleError(error.message);throw error;}}
function renderArgs(args,prompt){return (args||[]).map(value=>String(value).replaceAll("{prompt}",prompt));}
async function custom(connection,prompt,cwd,write,run,env){const args=renderArgs(write?connection.writeArgs:connection.readArgs,prompt);if(!connection.command||!args.length)throw new Error(`${connection.label} is missing a command or prompt arguments.`);activity(run,connection.label,write?"Working in isolated branch":"Inspecting repository");const result=(await exec(connection.command,args,cwd,45*60_000,run,undefined,env)).out.trim();if(result)message(run,connection.label,result);activity(run,connection.label,"Turn completed");return result;}
async function callAgent(name,prompt,cwd,write,run){const connection=findConnection(name);if(!connection)throw new Error(`Unknown connection: ${name}`);const env=connectionEnv(connection),provider=connection.provider;if(provider==="Claude")return claude(prompt,cwd,write,run,env);if(provider==="Codex")return codex(prompt,cwd,write,run,env);if(provider==="Copilot")return copilot(prompt,cwd,write,run,env);if(provider==="Gemini")return gemini(prompt,cwd,write,run,env);return custom(connection,prompt,cwd,write,run,env);}
async function recoveryContext(role,cwd,run){let checkpoint="No checkpoint was written before the interruption.";const file=run.handoffFiles?.[role];if(file&&existsSync(file))checkpoint=readFileSync(file,"utf8").slice(-16000);let status="",diff="";try{status=await git(cwd,"status","--short");diff=(await git(cwd,"diff","--stat")).slice(0,6000);}catch{}return `\n\nTAKEOVER CONTEXT\nYou are replacing an interrupted agent in the SAME isolated worktree. Preserve its valid changes and continue instead of restarting. Inspect the working tree before editing.\nCHECKPOINT:\n${checkpoint}\nGIT STATUS:\n${status||"clean"}\nDIFF SUMMARY:\n${diff||"none"}\nUpdate the checkpoint after your next coherent milestone.`;}
async function waitForTakeover(role,prompt,cwd,write,run,selected){run.status="needs_attention";run.pendingTakeover={role,failed:selected};message(run,"Relay",`${selected} paused. Choose a replacement to continue the same worktree.`,"handoff");return new Promise((resolveTakeover,rejectTakeover)=>{run.takeoverRejecter=rejectTakeover;run.takeoverResolver=async replacement=>{try{const continuation=await recoveryContext(role,cwd,run);run.roles[role]=replacement;run.failedAgents.push(selected);run.failedAgent=null;run.failureReason=null;run.pendingTakeover=null;run.status="running";message(run,"Relay",`${replacement} is taking over ${selected}'s ${role} work from the latest checkpoint.`,"handoff");resolveTakeover(await callWithBackup(role,`${prompt}${continuation}`,cwd,write,run));}catch(error){rejectTakeover(error);}finally{run.takeoverResolver=null;run.takeoverRejecter=null;}};});}
async function callWithBackup(role,prompt,cwd,write,run){const selected=run.roles[role];try{return await callAgent(selected,prompt,cwd,write,run);}catch(error){if(run.cancelled)throw error;run.failedAgent=selected;run.failureReason=simpleError(error.message);const backup=run.backupAgent;if(!run.autoFailover||!backup||backup===selected||run.failedAgents.includes(backup))return waitForTakeover(role,prompt,cwd,write,run,selected);run.failedAgents.push(selected);message(run,"Relay",`${selected} became unavailable. ${backup} is resuming the same ${role} worktree from its checkpoint.`,"handoff");const continuation=await recoveryContext(role,cwd,run);run.roles[role]=backup;run.failedAgent=null;run.failureReason=null;return callAgent(backup,`${prompt}${continuation}`,cwd,write,run);}}
function taskText(value){if(typeof value==="string")return value;if(value==null)return "";return JSON.stringify(value,null,2);}
async function makeWorktree(repo, root, name, base) { const path = join(root, name); await git(repo, "worktree", "add", "-b", `relay/${name}`, path, base); return path; }
async function commitIfNeeded(path, message) { if (!(await git(path, "status", "--porcelain"))) return false; await git(path, "add", "-A"); await git(path, "commit", "-m", message); return true; }

async function coordinate(run) {
  let tempRoot;
  try {
    run.status = "running"; emit(run, "Relay", "Validating repository and native agent connections", "live");
    const repo = resolve(run.repoPath); if (!existsSync(join(repo, ".git"))) throw new Error("Choose a local Git repository folder.");
    for(const id of new Set([run.primaryAgent,run.partnerAgent,run.backupAgent].filter(Boolean))){const c=findConnection(id);if(!c)throw new Error(`Unknown connection: ${id}`);await exec(c.command,c.provider==="Custom"?(c.versionArgs||[]):["--version"],repo,15_000,undefined,undefined,connectionEnv(c));}
    if (await git(repo, "status", "--porcelain")) throw new Error("The main checkout has uncommitted changes. Commit or stash them first.");
    const base = await git(repo, "branch", "--show-current"); const baseSha = await git(repo, "rev-parse", "HEAD"); run.base = base; run.baseSha = baseSha;
    tempRoot = await mkdtemp(join(tmpdir(), `agent-relay-${run.id}-`));
    run.handoffFiles={primary:join(tempRoot,"primary-handoff.md"),partner:join(tempRoot,"partner-handoff.md")};
    const primaryPath = await makeWorktree(repo, tempRoot, `${run.id}-primary`, baseSha); const partnerPath = await makeWorktree(repo, tempRoot, `${run.id}-partner`, baseSha);
    emit(run, "Relay", `Created isolated ${run.primaryAgent} and ${run.partnerAgent} worktrees`); emit(run, run.primaryAgent, "Independent architecture assessment started", "live"); emit(run, run.partnerAgent, "Independent risk and test assessment started", "live");
    const checkpointRule=(role)=>`Maintain a durable handoff at ${run.handoffFiles[role]}. After each coherent milestone, overwrite it with: objective, decisions, files inspected/changed, commands and results, remaining work, risks, and the exact next action. If context feels crowded or service limits approach, finish the smallest safe checkpoint, update this handoff, and stop cleanly.`;
    const brief = role => `Goal: ${run.goal}\nInspect the repository independently. Do not edit project files. Identify concrete tasks, risks, tests, and likely file ownership. Return a concise handoff for a supervisor.\n${checkpointRule(role)}`;
    const [pa,sa] = await Promise.all([callWithBackup("primary",brief("primary"),primaryPath,false,run),callWithBackup("partner",brief("partner"),partnerPath,false,run)]);
    run.transcript.primaryAssessment=pa;run.transcript.partnerAssessment=sa;emit(run,run.roles.primary,"Assessment delivered");emit(run,run.roles.partner,"Assessment delivered");
    emit(run,"Relay",`${run.roles.primary} is splitting work using both assessments`,"live");
    const splitRaw=await callWithBackup("primary",`You are the team supervisor. Split the goal into two non-overlapping implementation assignments with clear file ownership. Two agents must be able to work in parallel. Return ONLY JSON with keys primaryTask and partnerTask.\nGOAL:\n${run.goal}\nPRIMARY ASSESSMENT:\n${pa}\nPARTNER ASSESSMENT:\n${sa}`,repo,false,run);
    const match=splitRaw.match(/\{[\s\S]*\}/);if(!match)throw new Error("Supervisor did not return a valid task split.");const split=JSON.parse(match[0]);run.split=split;
    emit(run,run.roles.primary,"Implementation assignment started","live");emit(run,run.roles.partner,"Implementation assignment started","live");
    const common = role => `Overall goal: ${run.goal}\nWork only on your assignment. Do not modify files outside your ownership unless essential; explain exceptions. Run focused tests. Do not push or merge.\n${checkpointRule(role)}`;
    const [pi,si]=await Promise.all([callWithBackup("primary",`${common("primary")}\nYour assignment:\n${taskText(split.primaryTask)}`,primaryPath,true,run),callWithBackup("partner",`${common("partner")}\nYour assignment:\n${taskText(split.partnerTask)}`,partnerPath,true,run)]);
    run.transcript.primaryImplementation=pi;run.transcript.partnerImplementation=si;
    const pc=await commitIfNeeded(primaryPath,`Agent Relay: primary implementation ${run.id}`);const sc=await commitIfNeeded(partnerPath,`Agent Relay: partner implementation ${run.id}`);
    emit(run,run.roles.primary,pc?"Changes committed to isolated branch":"No changes required");emit(run,run.roles.partner,sc?"Changes committed to isolated branch":"No changes required");
    const integration = join(tempRoot, `${run.id}-integration`); await git(repo, "worktree", "add", "-b", `relay/${run.id}-integration`, integration, baseSha); run.integrationBranch = `relay/${run.id}-integration`;
    if(pc)await git(integration,"merge","--no-edit",`relay/${run.id}-primary`);if(sc)await git(integration,"merge","--no-edit",`relay/${run.id}-partner`);
    emit(run, "Relay", "Both implementations combined on the integration branch");
    for (let round = 1; round <= run.maxRounds; round++) {
      run.round = round; emit(run, "Relay", `Running verification round ${round}`, "live");
      const test = await exec("/bin/bash", ["-lc", run.testCommand], integration, 20 * 60_000, run, line => emit(run,"Tests",line,"live")).catch(e => ({ out: "", err: e.message, failed: true })); run.transcript[`tests${round}`] = `${test.out}\n${test.err}`;
      const reviewPrompt = `Review the integrated implementation for this goal: ${run.goal}\nTest result:\n${run.transcript[`tests${round}`]}\nInspect the diff from ${baseSha}. Do not edit. End with exactly VERDICT: APPROVE or VERDICT: REVISE, followed by concrete issues.`;
      const [pr,sr]=await Promise.all([callWithBackup("primary",reviewPrompt,integration,false,run),callWithBackup("partner",reviewPrompt,integration,false,run)]);run.transcript[`primaryReview${round}`]=pr;run.transcript[`partnerReview${round}`]=sr;
      const approved=!test.failed&&/VERDICT:\s*APPROVE/i.test(pr)&&/VERDICT:\s*APPROVE/i.test(sr);
      emit(run,run.roles.primary,/APPROVE/i.test(pr)?"Approved integrated result":"Requested revisions");emit(run,run.roles.partner,/APPROVE/i.test(sr)?"Approved integrated result":"Requested revisions");
      if (approved) { run.agreement = true; break; }
      if (round === run.maxRounds) break;
      emit(run, "Relay", `Sending both reviews back to ${run.roles.primary} for repair`, "live");
      await callWithBackup("primary",`Repair the integrated branch using both reviews. Goal: ${run.goal}\nPRIMARY REVIEW:\n${pr}\nPARTNER REVIEW:\n${sr}\nTEST OUTPUT:\n${run.transcript[`tests${round}`]}\nMake only necessary fixes and run focused tests.`,integration,true,run);
      await commitIfNeeded(integration, `Agent Relay: repair round ${round}`);
    }
    if (!run.agreement) throw new Error("The agents did not reach agreement within the review limit. Integration branch preserved for inspection.");
    emit(run, "Relay", "Both agents approved and tests passed");
    if (run.mergeMain) { if (await git(repo, "status", "--porcelain")) throw new Error("Main changed during the run; refusing automatic merge."); await git(repo, "merge", "--no-ff", run.integrationBranch, "-m", `Merge ${run.integrationBranch}`); emit(run, "Relay", `Merged safely into ${base}`); }
    run.status = "completed"; emit(run, "Relay", run.mergeMain ? "Team run completed and merged" : `Team run completed; ${run.integrationBranch} is ready`);
  } catch (error) { run.status = run.cancelled ? "stopped" : "failed"; run.error = run.cancelled ? "Run stopped safely." : (error.friendlyMessage||simpleError(error.message)); emit(run, "Relay", run.error, run.cancelled ? "stopped" : "error"); }
  finally { if (tempRoot) { /* worktrees remain registered for inspection; cleanup is explicit */ } }
}

function json(res, code, body) { res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(body)); }
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(dashboard); }
  if (req.method === "GET" && req.url === "/api/settings") return json(res,200,publicConfig());
  if (req.method === "PUT" && req.url === "/api/settings") { let body=""; for await(const c of req)body+=c; try{return json(res,200,saveConfig(JSON.parse(body)));}catch(error){return json(res,400,{error:error.message});} }
  if (req.method === "GET" && req.url === "/api/health") { const items=publicConfig().connections;const checks={};for(const c of items)checks[c.id]=await exec(c.command,c.provider==="Custom"?(c.versionArgs||[]):["--version"],process.cwd(),5_000,undefined,undefined,connectionEnv(c)).then(()=>true).catch(()=>false);return json(res,200,{connections:checks,claude:checks.Claude,codex:checks.Codex,copilot:checks.Copilot,gemini:checks.Gemini}); }
  if (req.method === "POST" && req.url === "/api/runs") { let body=""; for await (const c of req) body+=c; try { const input=JSON.parse(body);const primary=input.primaryAgent||"Claude",partner=input.partnerAgent||"Codex",backup=input.backupAgent||null;if(primary===partner)throw new Error("Primary and partner must be different agents.");const run={id:randomUUID().slice(0,8),repoPath:input.repoPath,goal:input.goal,primaryAgent:primary,partnerAgent:partner,backupAgent:backup,autoFailover:Boolean(input.autoFailover),roles:{primary,partner},failedAgents:[],maxRounds:Math.min(4,Math.max(1,Number(input.maxRounds)||3)),testCommand:input.testCommand||"npm test",mergeMain:Boolean(input.mergeMain),status:"queued",events:[],messages:[],activity:{Relay:"Starting",Claude:"Waiting",Codex:"Waiting",Copilot:"Waiting",Gemini:"Waiting",Tests:"Idle"},connected:{claude:false,codex:false,copilot:false,gemini:false},live:{claude:"",codex:"",copilot:"",gemini:""},transcript:{},children:new Set(),cancelled:false,createdAt:new Date().toISOString()}; runs.set(run.id,run); coordinate(run); return json(res,202,{...run,children:undefined}); } catch(e){return json(res,400,{error:e.message});} }
  const takeover=req.url?.match(/^\/api\/runs\/([\w-]+)\/takeover$/);if(req.method==="POST"&&takeover){const run=runs.get(takeover[1]);if(!run)return json(res,404,{error:"Run not found"});if(!run.takeoverResolver)return json(res,409,{error:"This run is not waiting for a replacement."});let body="";for await(const c of req)body+=c;try{const replacement=JSON.parse(body).replacement;if(!findConnection(replacement))throw new Error("Choose a valid connection.");run.takeoverResolver(replacement);return json(res,202,{status:"resuming",replacement,retry:replacement===run.pendingTakeover?.failed});}catch(error){return json(res,400,{error:error.message});}}
  const stop=req.url?.match(/^\/api\/runs\/([\w-]+)\/stop$/); if(req.method==="POST"&&stop){const run=runs.get(stop[1]);if(!run)return json(res,404,{error:"Run not found"});run.cancelled=true;run.status="stopping";emit(run,"Relay","Stopping active agents and tests","live");if(run.takeoverRejecter)run.takeoverRejecter(new Error("Run stopped by user."));for(const pid of run.children){try{process.kill(-pid,"SIGTERM")}catch{}}return json(res,202,{status:"stopping"});}
  const m=req.url?.match(/^\/api\/runs\/([\w-]+)$/); if(req.method==="GET"&&m) return runs.has(m[1])?json(res,200,runs.get(m[1])):json(res,404,{error:"Run not found"});
  json(res,404,{error:"Not found"});
});
server.listen(PORT,"127.0.0.1",()=>console.log(`Agent Relay is ready at http://127.0.0.1:${PORT}`));
