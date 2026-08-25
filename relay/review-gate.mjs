function clean(value,max=12000){return String(value??"").replace(/\0/g,"").trim().slice(0,max);}
function compact(value,max){const text=clean(value,max+80);return text.length>max?`${text.slice(0,max)}\n[…truncated; full objective remains saved in session history]`:text;}

export function estimateTokens(value){return Math.max(0,Math.ceil(String(value??"").length/4));}

export function recordTokenEstimate(run,agent,prompt,result){
  run.tokenUsage=run.tokenUsage||{};
  const item=run.tokenUsage[agent]||{input:0,output:0,total:0,calls:0,estimated:true};
  item.input+=estimateTokens(prompt);item.output+=estimateTokens(result);item.total=item.input+item.output;item.calls+=1;item.estimated=true;
  run.tokenUsage[agent]=item;
  run.tokenTotal=Object.values(run.tokenUsage).reduce((sum,value)=>sum+(value.total||0),0);
}

export function compactObjectiveContext(run,{includePrimary=true}={}){
  const primary=includePrimary?compact(run.primaryObjective||run.goal||"",4200):"Saved in the session record; execute only the approved phase below.";
  const secondary=(run.secondaryObjectives||[]).slice(-6).map((item,index)=>`${index+1}. ${compact(item.text,700)}`).join("\n")||"none";
  const steering=(run.steeringNotes||[]).slice(-6).map((item,index)=>`${index+1}. ${compact(item.text,700)}`).join("\n")||"none";
  return `PRIMARY OBJECTIVE:\n${primary}\nSECONDARY OBJECTIVES (latest):\n${secondary}\nSTEERING NOTES (latest):\n${steering}`;
}

export function phaseContext(run){
  const phase=run.phase||{};
  return `APPROVED PHASE (the only review scope):\n${compact(phase.summary||run.split?.summary||"Complete the approved assignments",2400)}\nACCEPTANCE CRITERIA:\n${(phase.acceptanceCriteria||run.split?.acceptanceCriteria||[]).map((item,index)=>`${index+1}. ${compact(item,700)}`).join("\n")||"Use the approved plan."}\nOUT OF SCOPE / DEFERRED:\n${(phase.outOfScope||run.split?.outOfScope||[]).map(item=>`- ${compact(item,500)}`).join("\n")||"Anything outside the approved plan."}`;
}

function jsonReview(text){
  const source=String(text||"");
  for(let start=source.indexOf("{");start>=0;start=source.indexOf("{",start+1))for(let end=source.lastIndexOf("}");end>start;end=source.lastIndexOf("}",end-1))try{const value=JSON.parse(source.slice(start,end+1));if(value&&value.verdict)return value;}catch{}
  return null;
}

function unwrapAgentOutput(value){
  const messages=[];
  for(const line of String(value||"").split("\n")){try{const event=JSON.parse(line);if(event?.type==="item.completed"&&event.item?.type==="agent_message"&&event.item.text)messages.push(event.item.text);if(event?.type==="result"&&typeof event.result==="string")messages.push(event.result);}catch{}}
  return messages.length?messages.join("\n"):String(value||"");
}

function normalizeVerdict(value){
  const text=String(value||"").toUpperCase().replace(/[^A-Z]+/g,"_");
  if(text.includes("APPROVE_WITH_FOLLOWUPS")||text==="FOLLOWUPS")return "FOLLOWUPS";
  if(text.includes("APPROVE"))return "APPROVE";
  return "REVISE";
}

export function parseReview(text){
  const raw=clean(unwrapAgentOutput(text),50000),structured=jsonReview(raw);
  if(structured){
    const verdict=normalizeVerdict(structured.verdict);
    const blockers=Array.isArray(structured.blockers)?structured.blockers.map((item,index)=>({id:clean(item.id||`blocker-${index+1}`,80),criterion:clean(item.criterion,500),evidence:clean(item.evidence||item.issue,2400)})).filter(item=>item.evidence):[];
    const followups=Array.isArray(structured.followups)?structured.followups.map(item=>clean(typeof item==="string"?item:item.text,1200)).filter(Boolean):[];
    return {verdict:blockers.length?"REVISE":verdict,blockers,followups,raw};
  }
  const verdictMatch=raw.match(/VERDICT:\s*(APPROVE_WITH_FOLLOWUPS|APPROVE|FOLLOWUPS|REVISE)/i),verdict=normalizeVerdict(verdictMatch?.[1]||"REVISE");
  if(verdict!=="REVISE")return {verdict,blockers:[],followups:[],raw};
  const tail=raw.slice(verdictMatch?.index||0).replace(/^VERDICT:[^\n]*/i,"").trim();
  return {verdict:"REVISE",blockers:tail?[{id:"legacy-review",criterion:"Approved phase",evidence:compact(tail,5000)}]:[{id:"missing-verdict",criterion:"Review format",evidence:"Reviewer did not provide an actionable approval verdict."}],followups:[],raw};
}

const NON_BLOCKING_METADATA=/commit(?:-| )message|git metadata|cannot lock (?:ref|index)|index\.lock|operation not permitted|read[- ]only|workspace permission|sandbox|commit signing|gpg|branch name|tag name/i;

export function applyAuthoritativeGate(review,{testsPassed=false}={}){
  if(!testsPassed)return review;
  const blockers=[],followups=[...(review.followups||[])];
  for(const blocker of review.blockers||[]){
    const evidence=`${blocker.id||""} ${blocker.criterion||""} ${blocker.evidence||""}`;
    if(NON_BLOCKING_METADATA.test(evidence))followups.push(`Non-blocking environment or repository-metadata item: ${blocker.evidence}`);
    else blockers.push(blocker);
  }
  const verdict=blockers.length?"REVISE":followups.length?"FOLLOWUPS":"APPROVE";
  return {...review,verdict,blockers,followups};
}

function findingKey(item){return clean(item.id,80)!=="legacy-review"?clean(item.id,80):clean(item.evidence,180).toLowerCase().replace(/[^a-z0-9]+/g,"-").slice(0,72);}

export function recordReviewRound(run,reviews,round){
  run.findingLedger=Array.isArray(run.findingLedger)?run.findingLedger:[];
  const activeKeys=new Set();
  for(const {agent,review} of reviews)for(const blocker of review.blockers){
    const key=findingKey(blocker);activeKeys.add(key);
    let finding=run.findingLedger.find(item=>item.key===key);
    if(!finding){finding={key,id:blocker.id,criterion:blocker.criterion,evidence:blocker.evidence,status:"open",firstRound:round,lastRound:round,agents:[agent]};run.findingLedger.push(finding);}
    else{finding.status="open";finding.lastRound=round;finding.evidence=blocker.evidence;if(!finding.agents.includes(agent))finding.agents.push(agent);}
  }
  for(const finding of run.findingLedger)if(finding.status==="open"&&!activeKeys.has(finding.key))finding.status="verified";
  return run.findingLedger.filter(item=>item.status==="open");
}

export function reviewPrompt(run,{baseSha,testOutput,round,recovered=false}={}){
  return `Perform a concise ${recovered?"recovered ":""}phase-gate review. Do not edit files.\n${phaseContext(run)}\nAUTHORITATIVE RELAY TEST RESULT:\n${compact(testOutput,5000)}\nInspect the current diff${baseSha?` from ${baseSha}`:" and history"}. Review ONLY the approved phase and its frozen acceptance criteria. The larger primary objective is a roadmap, not this phase's gate. Relay's test result overrides a model sandbox's inability to execute a command. Read-only Git metadata, inability to rewrite commits, commit-message quality, signing, branch naming, and other environment limitations are always FOLLOW-UPS, never blockers. Do not repeat a resolved finding without new code or test evidence. Reversible preferences and future enhancements are follow-ups, not blockers. Only a demonstrated security vulnerability, data-loss/destructive-migration risk, behaviorally unmet frozen acceptance criterion, or failing authoritative test may block. Keep the response under 700 words. Return ONLY JSON:\n{"verdict":"APPROVE|APPROVE_WITH_FOLLOWUPS|REVISE","blockers":[{"id":"stable-short-id","criterion":"number or name","evidence":"file/test/command evidence"}],"followups":["non-blocking future work"]}\nRound: ${round}.`;
}
