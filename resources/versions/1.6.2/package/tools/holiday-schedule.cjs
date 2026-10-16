'use strict';
// Holiday calendar by KombatKing (Dauntless Forever community), from his All-in-One R4. AGPL-3.0-only.
// Calendar and native schedule names for Dauntless 1.6.2. AGPL-3.0-only.
const ROOT='/Game/Maps/ramsgate/ramsgate_01_persistent',PREFIX='/Game/Features/HuntPass/';
const flag=n=>PREFIX+n+'.'+n+'_C';
const FLAGS={spring:flag('city_event_Springtide_bpff'),saints:flag('city_event_SaintsBond_bpff'),dark:flag('city_event_dark_harvest_bpff'),frost:flag('enable_city_event_frostfall_bpff'),stall:flag('city_event_stall_bpff'),springGameplay:'/Script/Archon.SpringEvent2020Feature'};
function date(now=new Date()){const d=new Date(now);if(!Number.isFinite(d.getTime()))throw Error('Invalid holiday schedule date');return d;}
// Gregorian Easter (Meeus/Jones/Butcher). Month is 1-based.
function easterMonth(year){const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);return Math.floor((h+l-7*m+114)/31);}
function definitions(year){return[
 {id:'Saints_Bond_2021',title:"Saint's Bond",month:2,flag:FLAGS.saints,map:'/Game/Maps/ramsgate/events/city_01_Event_SaintsBond_2021',available:true,hunts:[]},
 {id:'Spring_Event_2020',title:'Springtide',month:easterMonth(year),flag:FLAGS.spring,map:'/Game/Maps/ramsgate/events/city_01_springtide_2021',available:true,hunts:['CR19_PlayerHunt_Event_Spring_2020']},
 {id:'Dark_Harvest',title:'Dark Harvest',month:10,flag:FLAGS.dark,map:'/Game/Maps/ramsgate/events/city_01_event_dark_harvest',available:false,hunts:['PlayerHunt_Event_Dark_Harvest_01','PlayerHunt_Event_Dark_Harvest_Hard_01']},
 {id:'Ramsgiving',title:'Ramsgiving',month:11,flag:null,map:null,available:false,hunts:[]},
 {id:'Frostfall',title:'Frostfall',month:12,flag:FLAGS.frost,map:'/Game/Maps/ramsgate/events/city_01_event_frostfall',available:true,hunts:[]}
 ];}
function entries(now){const d=date(now),year=d.getUTCFullYear();return definitions(year).map(e=>({...e,start:new Date(Date.UTC(year,e.month-1,1)).toISOString(),end:new Date(Date.UTC(year,e.month,1)).toISOString()}));}
function active(now){const d=date(now),time=d.getTime();return entries(d).filter(e=>time>=Date.parse(e.start)&&time<Date.parse(e.end));}
function schedule(now){return entries(now).map(e=>({Name:e.id,StartTime:e.start,EndTime:e.end,IsRepeatable:false,RepeatableDetails:{EachDay:false,EachWeek:false},bShouldQueueTheSheduleItems:false,ScheduledItems:[...new Set([e.id,...e.hunts,...(e.id==='Dark_Harvest'?['Dark_Harvest_Effigy','Dark_Harvest_Stump','MatchmakerHunt_Event_Dark_Harvest_01','MatchmakerHunt_Event_Dark_Harvest_Hard_01']:[])])].map(ID=>({ID,MaxCompletionPerInterval:-1}))}));}
function ramsgate(now,manualOn='',manualOff=''){
 const managed=new Set(Object.values(FLAGS)),split=s=>String(s||'').split(',').map(x=>x.trim()).filter(Boolean),on=new Set(split(manualOn).filter(f=>!managed.has(f))),off=new Set(split(manualOff).filter(f=>!managed.has(f)));
 for(const f of managed)off.add(f);
 const events=active(now);
 for(const e of events){if(e.flag&&e.available){on.add(e.flag);off.delete(e.flag);}if(e.id==='Spring_Event_2020'){on.add(FLAGS.springGameplay);off.delete(FLAGS.springGameplay);}}
 if(events.length){on.add(FLAGS.stall);off.delete(FLAGS.stall);}
 // Explicit unrelated manual off values take precedence, matching existing flag behavior.
 for(const f of off)on.delete(f);
 return ROOT+(on.size?'?OverridenFeaturesOn='+[...on].join(','):'')+(off.size?'?OverridenFeaturesOff='+[...off].join(','):'');
}
module.exports={schedule,active,entries,easterMonth,ramsgate,FLAGS};
