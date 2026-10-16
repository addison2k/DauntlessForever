// AGPL-3.0-only. Mega 400 reward selection, bundle expansion and catch-up grants.
'use strict';
// By KombatKing (Dauntless Forever community), from his All-in-One R4. Dauntless Forever uses only grant() for the
// separate Mega Hunt Pass (Expanded) season file; selectConfig() is not called, so the Mega Hunt Pass itself never changes.
const crypto=require('node:crypto');
const replacement=require('./mega400-rewards.json'),original=require('./original-mega.json');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const baseline=digest(original.rewards),revision=replacement._mega400_revision;
function selectConfig(cfg){
 if(cfg.levels!==400||digest(cfg.rewards)!==baseline)return cfg;
 return {...cfg,rewards:replacement.rewards,bundles:replacement.bundles,
  cosmetic_ids:replacement.cosmetic_ids,instanced_ids:replacement.instanced_ids,_mega400_revision:revision};
}
function expand(cfg,list){
 const out=[];
 for(const [id,qty] of list||[]){
  if(!Number.isSafeInteger(qty)||qty<=0)throw Error('Invalid Mega reward quantity');
  const pack=cfg.bundles[id];
  if(pack){if(pack.length!==5||new Set(pack.map(x=>x[0])).size!==5)throw Error('Invalid five-dye bundle');
   for(const [dye,n]of pack)out.push([dye,n*qty]);
  }else out.push([id,qty]);
 }
 return out;
}
function plan(cfg,s,level,prestige,held){
 const cosmetics=new Set(cfg.cosmetic_ids),instancedIds=new Set(cfg.instanced_ids);
 const stackedHeld=new Set(JSON.parse(held?.stackedItems||'[]').filter(x=>x.quantity>0).map(x=>x.catalogId));
 const instancedHeld=new Set(JSON.parse(held?.instancedItems||'[]').map(x=>x.catalogId));
 const all=new Map(),from=s.granted_level||0,fromP=s.granted_prestige||0;
 const migrating=s.mega400_revision!==revision;
 function add(list,onlyCosmetic=false,times=1){
  for(const [id,n]of expand(cfg,list)){
   if(onlyCosmetic&&!cosmetics.has(id))continue;
   if(cosmetics.has(id)){
    if((instancedIds.has(id)?instancedHeld:stackedHeld).has(id))continue;
    all.set(id,1);
   }else all.set(id,(all.get(id)||0)+n*times);
  }
 }
 // A rearranged reward below an already-paid rank is eligible for cosmetics only.
 // Currency, cores, stones and prestige are never back-paid during migration.
 for(let n=1;n<=level;n++){
  const row=cfg.rewards[String(n)]||{};
  if(n>from||migrating){add(row.free,n<=from);add(row.premium,n<=from);}
 }
 if(prestige>fromP&&cfg.prestige){add(cfg.prestige.free,false,prestige-fromP);add(cfg.prestige.premium,false,prestige-fromP);}
 return {stacked:[...all].filter(([id])=>!instancedIds.has(id)).map(([catalogId,quantity])=>({catalogId,quantity})),
  instanced:[...all].filter(([id])=>instancedIds.has(id)).map(([catalogId])=>({catalogId,instanceId:catalogId,itemData:null,updateVersion:0})),
  migrating,needed:level>from||prestige>fromP||migrating};
}
async function grant(ctx){
 const {accountId,cfg,load,state,position,save,db,eq,schema,transaction,logger}=ctx;
 const s=state(load()),{level,prestige}=position(s.xp);
 if(level<=(s.granted_level||0)&&prestige<=(s.granted_prestige||0)&&s.mega400_revision===revision)return;
 const chars=await db.query.characters.findMany({where:eq(schema.characters.userId,accountId)});
 if(!chars.length){logger.warn('Mega400: no character; grants will retry.');return;}
 const character=[...chars].sort((a,b)=>a.lastModifiedDate<b.lastModifiedDate?1:a.lastModifiedDate>b.lastModifiedDate?-1:0)[0];
 const held=await db.query.inventory.findFirst({where:eq(schema.inventory.characterId,character.characterId)});
 const p=plan(cfg,s,level,prestige,held);
 if(p.stacked.length||p.instanced.length){
  const result=await transaction(accountId,character.characterId,`mega400-${Date.now()}`,p.instanced,p.stacked,[],[],[]);
  // The inventory API uses a DB transaction. Never mark a failed batch paid or
  // fall back to partial single-item grants, which can lose rewards on retry.
  if(!result.success){logger.error('Mega400: grant failed; no progress receipt advanced. '+result.error);return;}
 }
 const file=load(),cur=state(file);
 const next={...cur,granted_level:Math.max(cur.granted_level||0,level),granted_prestige:Math.max(cur.granted_prestige||0,prestige),mega400_revision:revision};
 save(file,next);
 logger.info(`Mega400: paid through tier ${level}; ${p.stacked.length+p.instanced.length} item types; catch-up ${p.migrating?'yes':'no'}.`);
}
module.exports={selectConfig,expand,plan,grant,revision};
