// Shared offline Trials schedule for metagame + deploy. AGPL-3.0-only.
// Fix by KombatKing (Dauntless Forever community), from his Consolidated Patches 0.2.
'use strict';
const path=require('node:path'),fs=require('node:fs');
const DAY=86400000,WEEK=7*DAY,ANCHOR=Date.UTC(2026,9,12);
function create(hard,elite){
 const rows=t=>Array.isArray(t)&&t[0]&&t[0].Rows?t[0].Rows:t;
 hard=rows(hard);elite=rows(elite);
 const valid=r=>r&&typeof r.SpecificBehemoth?.BehemothAsset?.AssetPathName==='string'&&r.SpecificBehemoth.BehemothAsset.AssetPathName.startsWith('/Game/');
 const suffixes=Object.keys(hard).filter(k=>/^Arena_MatchmakerHunt_Hard_\d{3}$/.test(k)&&valid(hard[k])&&valid(elite[k.replace('_Hard_','_Elite_')])).map(k=>k.slice(-3)).sort();
 if(!suffixes.length)throw Error('No matching Trials rows available');
 function current(now=new Date()){
  const time=now instanceof Date?now.getTime():Number(now);if(!Number.isFinite(time))throw Error('Invalid Trials date');
  const day=new Date(time),today=Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate()),start=today-((new Date(today).getUTCDay()+6)%7)*DAY,week=Math.floor((start-ANCHOR)/WEEK),suffix=suffixes[((week%suffixes.length)+suffixes.length)%suffixes.length];
  return{start:new Date(start).toISOString(),end:new Date(start+WEEK).toISOString(),hard:'Arena_MatchmakerHunt_Hard_'+suffix,elite:'Arena_MatchmakerHunt_Elite_'+suffix};
 }
 function schedule(now){const c=current(now);return [{Name:'Scheduled_Arena_Hunt_'+c.hard.slice(-3),StartTime:c.start,EndTime:c.end,IsRepeatable:false,RepeatableDetails:{EachDay:false,EachWeek:false},bShouldQueueTheSheduleItems:false,ScheduledItems:[{ID:c.hard,MaxCompletionPerInterval:-1},{ID:c.elite,MaxCompletionPerInterval:-1}]}];}
 function launch(hunt,now){if(!['CR19_PlayerHunt_Arena_Hard','CR19_PlayerHunt_Arena_Elite'].includes(hunt))throw Error('Unsupported Trials hunt: '+hunt);const c=current(now),isElite=hunt.endsWith('_Elite'),id=isElite?c.elite:c.hard,row=(isElite?elite:hard)[id];return{Behemoth:row.SpecificBehemoth.BehemothAsset.AssetPathName,TrialsHuntId:id};}
 return {current,schedule,launch,count:suffixes.length};
}
let instance;
function live(){if(!instance){const dir=path.resolve(__dirname,'../backend/deploy/dist/vendor');instance=create(JSON.parse(fs.readFileSync(path.join(dir,'trials_hard_table.json'))),JSON.parse(fs.readFileSync(path.join(dir,'trials_elite_table.json'))));}return instance;}
module.exports={create,schedule:now=>live().schedule(now),launch:(hunt,now)=>live().launch(hunt,now)};
