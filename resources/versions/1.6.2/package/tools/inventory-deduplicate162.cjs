// Dauntless Forever - Dauntless 1.6.2 offline package
// Duplicate cleanup by KombatKing (All-in-One R10, AGPL-3.0-only); Dauntless Forever changes: only your own account
// (data\player.key) unless --all, and run by "FIX duplicate items.bat" (tools\fix-duplicates.ps1).
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
//   node tools\inventory-deduplicate162.cjs check [--all]   lists extra copies of one-copy items, changes nothing
//   node tools\inventory-deduplicate162.cjs clean [--all]   removes them (full backup first), keeps the best copy and
//                                                          points equipped loadouts at the copy that stays
'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),DB=path.join(ROOT,'data/undaunted.db'),catalog=require('./import-singletons162.json');
const instanceOne=new Set(catalog.instanced),stackOne=new Set(catalog.stacked);
function parse(s){const x=JSON.parse(s||'[]');if(!Array.isArray(x))throw Error('Inventory is not an array');return x;}
function refs(value,out=new Set()){
 if(Array.isArray(value))for(const v of value)refs(v,out);
 else if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){
  if((k==='instance_id'||k==='instanceId')&&typeof v==='string')out.add(v);
  else refs(v,out);
 }else if(typeof value==='string'&&/^[\[{]/.test(value.trim())){try{refs(JSON.parse(value),out);}catch{}}
 return out;
}
function remap(value,map){
 if(Array.isArray(value))return value.map(v=>remap(v,map));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,(k==='instance_id'||k==='instanceId')&&typeof v==='string'&&map.has(v)?map.get(v):remap(v,map)]));
 if(typeof value==='string'&&/^[\[{]/.test(value.trim())){try{const parsed=JSON.parse(value),next=remap(parsed,map);return JSON.stringify(parsed)===JSON.stringify(next)?value:JSON.stringify(next);}catch{}}
 return value;
}
function level(item){try{return Number(JSON.parse(item.itemData||'{}').CurrentLevel)||0;}catch{return 0;}}
function plan(row,loadout){
 const inst=parse(row.instancedItems),stacks=parse(row.stackedItems),load=loadout?{loadouts:JSON.parse(loadout.loadouts||'[]'),persistent:JSON.parse(loadout.persistent||'{}')}:null;
 const ids=new Map();for(const item of inst){if(!item||!item.instanceId)continue;if(ids.has(item.instanceId)&&ids.get(item.instanceId)!==item.catalogId)throw Error('Ambiguous instance ID shared by different catalog items');ids.set(item.instanceId,item.catalogId);}
 const used=refs(load),groups=new Map(),map=new Map(),removed=new Set();let extraInstances=0,extraStackRows=0,normalizedStacks=0;
 for(const i of inst){if(!i||!instanceOne.has(i.catalogId))continue;if(typeof i.instanceId!=='string'||!i.instanceId)throw Error('Singleton has invalid instance ID');const g=groups.get(i.catalogId)||[];g.push(i);groups.set(i.catalogId,g);}
 for(const group of groups.values())if(group.length>1){
  const best=[...group].sort((a,b)=>level(b)-level(a))[0],keep=group.find(x=>used.has(x.instanceId))||best;
  if(best!==keep&&level(best)>level(keep)){const id=keep.instanceId;Object.assign(keep,best,{instanceId:id,updateVersion:Math.max(Number(keep.updateVersion)||0,Number(best.updateVersion)||0)+1});}
  for(const i of group)if(i!==keep){removed.add(i);extraInstances++;if(i.instanceId!==keep.instanceId)map.set(i.instanceId,keep.instanceId);}
 }
 const nextInst=inst.filter(i=>!removed.has(i)).map(i=>i&&typeof i.itemData==='string'?{...i,itemData:remap(i.itemData,map)}:i);
 const seen=new Map(),nextStack=[];
 for(const i of stacks){
  if(!i||!stackOne.has(i.catalogId)){nextStack.push(i);continue;}
  if(!Number.isSafeInteger(i.quantity)||i.quantity<0)throw Error('Invalid singleton stack quantity');
  if(seen.has(i.catalogId)){const kept=seen.get(i.catalogId);if(i.quantity>0)kept.quantity=1;extraStackRows++;continue;}
  const kept={...i,quantity:i.quantity>0?1:0};if(i.quantity>1)normalizedStacks++;seen.set(i.catalogId,kept);nextStack.push(kept);
 }
 const nextLoad=load?remap(load,map):null;
 if(nextLoad)for(const id of refs(nextLoad))if(map.has(id))throw Error('Unrepaired equipped instance reference');
 return {instancedItems:JSON.stringify(nextInst),stackedItems:JSON.stringify(nextStack),loadouts:nextLoad?JSON.stringify(nextLoad.loadouts):null,persistent:nextLoad?JSON.stringify(nextLoad.persistent):null,extraInstances,extraStackRows,normalizedStacks,changed:extraInstances+extraStackRows+normalizedStacks>0};
}
function backendUp(){return new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:61000});const done=v=>{s.destroy();resolve(v);};s.setTimeout(800,()=>done(false));s.on('connect',()=>done(true));s.on('error',()=>done(false));});}
// Your own account: the one data\player.key belongs to (same rule as tools\items.js). On a host the save also holds
// friends' accounts and characters that travelled here; those are left alone unless --all.
function myCharacters(db){
 const keyFile=path.join(ROOT,'data','player.key');const key=fs.existsSync(keyFile)?fs.readFileSync(keyFile,'utf8').trim():'';
 if(!key.startsWith('UUK_'))return null;
 const hash=crypto.createHash('sha256').update(key,'utf8').digest('hex');let row=null;
 try{row=db.prepare('SELECT userId FROM userapikeys WHERE keyHash = ?').get(hash);}catch{}
 if(!row){try{row=db.prepare('SELECT userId FROM userapikeystoregister WHERE key = ?').get(key);}catch{}}
 if(!row)return null;
 return new Set(db.prepare('SELECT characterId FROM characters WHERE userId = ?').all(row.userId).map(r=>r.characterId));
}
async function run(mode,all=false){
 if(!['check','clean'].includes(mode))throw Error('Choose check or clean');
 if(!fs.existsSync(DB))throw Error('No local save found');
 if(mode==='clean'&&await backendUp())throw Error('Close the game and all servers before cleaning inventory');
 const Database=require(path.join(ROOT,'backend/metagame/node_modules/better-sqlite3')),db=new Database(DB,{readonly:mode==='check',fileMustExist:true});
 try{
  const mine=all?null:myCharacters(db);
  if(!all&&!mine)throw Error('Could not tell which account is yours (data\\player.key). Run Set up again.');
  const loadouts=db.prepare('SELECT characterId,loadouts,persistent FROM loadouts').all(),rows=db.prepare('SELECT characterId,instancedItems,stackedItems FROM inventories').all().filter(r=>all||mine.has(r.characterId));
  const plans=rows.map((row,n)=>({characterId:row.characterId,index:n+1,...plan(row,loadouts.find(l=>l.characterId===row.characterId))}));
  const affected=plans.filter(p=>p.changed);let backup=null;
  if(mode==='clean'&&affected.length){
   const dir=path.join(ROOT,'backup/inventory-deduplicate162');fs.mkdirSync(dir,{recursive:true});backup=path.join(dir,'undaunted-'+Date.now()+'.db');
   await db.backup(backup);
   db.transaction(()=>{for(const p of affected){db.prepare('UPDATE inventories SET instancedItems=?,stackedItems=? WHERE characterId=?').run(p.instancedItems,p.stackedItems,p.characterId);if(p.loadouts!==null)db.prepare('UPDATE loadouts SET loadouts=?,persistent=? WHERE characterId=?').run(p.loadouts,p.persistent,p.characterId);}})();
  }
  return {ok:true,mode,accounts_scope:all?'all local character inventories':'your own account',characters_scanned:plans.length,characters_affected:affected.length,extra_instances:affected.reduce((n,p)=>n+p.extraInstances,0),extra_unlock_rows:affected.reduce((n,p)=>n+p.extraStackRows,0),unlock_quantities_above_one:affected.reduce((n,p)=>n+p.normalizedStacks,0),backup,ordinary_equipment_cells_materials_consumables:'preserved'};
 }finally{db.close();}
}
module.exports={plan,run};if(require.main===module)run(process.argv[2]||'check',process.argv.includes('--all')).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error('Inventory cleanup stopped: '+e.message);process.exitCode=1;});
