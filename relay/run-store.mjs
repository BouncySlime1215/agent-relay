import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stateRoot = process.env.AGENT_RELAY_STATE || join(homedir(), ".agent-relay", "runs");

function safeRun(run) {
  const value={};
  for(const [key,item] of Object.entries(run)){
    if(["takeoverResolver","takeoverRejecter","planDecisionResolver","planDecisionRejecter"].includes(key))continue;
    value[key]=item instanceof Set?[...item]:item;
  }
  return value;
}

export function saveRunState(run) {
  mkdirSync(stateRoot,{recursive:true,mode:0o700});
  const file=join(stateRoot,`${run.id}.json`),temp=`${file}.tmp`;
  writeFileSync(temp,`${JSON.stringify(safeRun(run),null,2)}\n`,{mode:0o600});
  renameSync(temp,file);
}

export function loadRunStates() {
  if(!existsSync(stateRoot))return [];
  return readdirSync(stateRoot).filter(name=>name.endsWith(".json")).flatMap(name=>{
    try{
      const run=JSON.parse(readFileSync(join(stateRoot,name),"utf8"));
      run.primaryObjective=run.primaryObjective||run.goal||"";
      run.secondaryObjectives=Array.isArray(run.secondaryObjectives)?run.secondaryObjectives:[];
      run.steeringNotes=Array.isArray(run.steeringNotes)?run.steeringNotes:[];
      run.findingLedger=Array.isArray(run.findingLedger)?run.findingLedger:[];
      run.tokenUsage=run.tokenUsage&&typeof run.tokenUsage==="object"?run.tokenUsage:{};
      run.tokenTotal=Number(run.tokenTotal)||Object.values(run.tokenUsage).reduce((sum,item)=>sum+(Number(item?.total)||0),0);
      run.phase=run.phase&&typeof run.phase==="object"?run.phase:null;
      run.projectTimeline=Array.isArray(run.projectTimeline)?run.projectTimeline:[];
      run.currentBuildTimeline=Array.isArray(run.currentBuildTimeline)?run.currentBuildTimeline:[];
      run.lastTestPassed=Boolean(run.lastTestPassed||run.agreement);
      if(["running","queued","stopping","needs_attention","awaiting_plan","steering"].includes(run.status)){
        if(run.secondaryObjectives.at(-1)?.source!=="restart")run.secondaryObjectives.push({id:`restart-${Date.now()}`,text:"Resume preserved work after Agent Relay restart",source:"restart",at:new Date().toISOString()});
        run.status="interrupted";
        run.error="Agent Relay restarted. All saved history and worktrees were preserved.";
        run.recoverable=true;
      }
      run.children=new Set();run.cancelled=false;run.takeoverResolver=null;run.takeoverRejecter=null;run.planDecisionResolver=null;run.planDecisionRejecter=null;
      run.events=Array.isArray(run.events)?run.events:[];run.messages=Array.isArray(run.messages)?run.messages:[];
      run.activity=run.activity||{};run.transcript=run.transcript||{};run.roles=run.roles||{primary:run.primaryAgent,partner:run.partnerAgent};
      return [run];
    }catch{return [];}
  }).sort((a,b)=>String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)));
}
