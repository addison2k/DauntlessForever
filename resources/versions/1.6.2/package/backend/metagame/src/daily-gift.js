// Feature-only Daily Ramsgate Gift; AGPL-3.0-only.
'use strict';
// By KombatKing (Dauntless Forever community), from his All-in-One R4. AGPL-3.0-only.
// Dauntless Forever: only the Daily Ramsgate Gift is offered; the free repeatable pack is switched off (DAILY_FREE_PACK=1 turns it on).
const {Router}=require('express'),{randomBytes,createHash}=require('node:crypto');
const {eq,sql}=require('drizzle-orm'),{GetDb}=require('./db'),{characters,inventory}=require('./db/schema');
const {HasUndauntedMetagameAuth}=require('./middleware/HasUndauntedMetagameAuth');
const router=Router(),tokens=new Map(),busy=new Set(),SKU='bundle_reward_login_daily',PACK='feature_25_chips_keys_premium';
const items=[{catalogId:'TOKEN_DAILY_PATROL_BONUS_PURCHASED',quantity:2},{catalogId:'TOKEN_BOUNTY_DRAFT',quantity:4}];
const packItems=[{catalogId:'CURRENCY_TOKEN_EXCHANGE_SPEED_UP',quantity:25},{catalogId:'TOKEN_DAILY_PATROL_BONUS_PURCHASED',quantity:25},{catalogId:'TOKEN_BOUNTY_DRAFT_PREMIUM',quantity:25}];
const tags=['fountain_daily_free_bundle','webstore','supplies_supplies'];
const packTags=['webstore','your_offers','supplies_supplies'];
const known=sku=>sku===SKU||(sku===PACK&&process.env.DAILY_FREE_PACK==='1');
const day=()=>new Date().toISOString().slice(0,10);
function init(tx){tx.run(sql`CREATE TABLE IF NOT EXISTS local_ramsgate_receipts_07 (account TEXT NOT NULL,sku TEXT NOT NULL,receipt TEXT NOT NULL,day TEXT NOT NULL,PRIMARY KEY(account,sku,receipt)) WITHOUT ROWID`);}
function used(tx,a){init(tx);return !!tx.get(sql`SELECT receipt FROM local_ramsgate_receipts_07 WHERE account=${a} AND sku=${SKU} AND day=${day()} LIMIT 1`);}
function auth(req,res){const a=req.AuthData?.userId;if(req.AuthData?.IsGameserver||typeof a!=='string'||!a.length){res.status(403).send();return null;}return a;}
async function character(a){const rows=await GetDb().query.characters.findMany({where:eq(characters.userId,a)});return rows.length===1?rows[0].characterId:null;}
function offer(remaining,sku=SKU){const daily=sku===SKU;return{id:sku,displayName:daily?'Daily Ramsgate Gift':'Ace Chips, Patrol Keys & Premium Bounty Tokens',displayDescription:daily?'2 Patrol Keys and 4 Bounty Tokens. Resets daily at 00:00 UTC.':'Free repeatable pack: 25 Ace Chips, 25 Patrol Keys, and 25 Premium Bounty Tokens.',displayPriority:daily?10:20,tags:daily?tags:packTags,platinumPrice:0,platinumSalePrice:null,cellDustPrice:null,prestigePrice:null,event01Price:null,steelMarksPrice:null,gildedMarksPrice:null,items:(daily?items:packItems).map(i=>({...i})),entitlements:[],maxAllowed:1,remaining,loadoutSlots:null,availableFrom:null,availableTo:null,timeAvailabilityReason:null,platformOfferId:null,missingEntitlementNames:null};}
async function remaining(a,sku=SKU){if(!await character(a))return 0;return sku===SKU?GetDb().transaction(tx=>used(tx,a)?0:1):1;}
function parseTags(value){if(Array.isArray(value))return value.flatMap(parseTags);if(typeof value!=='string')return [];try{const v=JSON.parse(value);if(Array.isArray(v))return v.flatMap(parseTags);}catch{}return value.split(/[,;|]/).map(x=>x.trim().toLowerCase()).filter(Boolean);}
router.get('/product/skus/public',HasUndauntedMetagameAuth,async(req,res,next)=>{
 const requested=parseTags(req.query.requiredTags);
 const selected=[SKU,...(process.env.DAILY_FREE_PACK==='1'?[PACK]:[])].filter(sku=>requested.every(t=>(sku===SKU?tags:packTags).includes(t)));
 if(!selected.length)return next();
 const a=auth(req,res);if(!a)return;
 try{
  const added=await Promise.all(selected.map(async sku=>offer(await remaining(a,sku),sku))),original=res.json;
  // Append only the two authorized offers. Preserve 0.2's other offers.
  res.json=function(data){if(!Array.isArray(data))return original.call(this,data);return original.call(this,[...data.filter(x=>!selected.includes(x?.id)),...added]);};
  return next();
 }catch{res.status(500).send();}
});
router.get('/product/sku/:skuId',HasUndauntedMetagameAuth,async(req,res,next)=>{const sku=req.params.skuId;if(!known(sku))return next();const a=auth(req,res);if(!a)return;try{res.json(offer(await remaining(a,sku),sku));}catch{res.status(500).send();}});
router.get('/token/:currency/:skuId',HasUndauntedMetagameAuth,async(req,res,next)=>{
 const sku=req.params.skuId;if(!known(sku))return next();const a=auth(req,res);if(!a)return;
 if(String(req.params.currency).toLowerCase()!=='platinum')return res.status(400).send();
 try{const c=await character(a);if(!c||!await remaining(a,sku))return res.status(409).send();
  for(const [k,v]of tokens)if(Date.now()-v.time>3600000)tokens.delete(k);
  if(tokens.size>=10000)return res.status(429).send();
  const token='daily_'+randomBytes(32).toString('hex');tokens.set(token,{a,c,sku,day:day(),time:Date.now(),done:false});res.json({purchaseToken:token});
 }catch{res.status(500).send();}
});
router.post('/notification/:currency',HasUndauntedMetagameAuth,async(req,res,next)=>{
 const token=[req.query.token,req.query.purchaseToken,req.body?.token,req.body?.purchaseToken].find(t=>typeof t==='string');
 if(!token?.startsWith('daily_'))return next();const a=auth(req,res);if(!a)return;
 if(String(req.params.currency).toLowerCase()!=='platinum')return res.status(400).send();
 const info=tokens.get(token);if(!info||info.a!==a)return res.status(403).send();if(info.done)return res.status(204).send();
 if(Date.now()-info.time>600000||(info.sku===SKU&&info.day!==day()))return res.status(410).send();if(busy.has(a))return res.status(409).send();busy.add(a);
 try{
  if(await character(a)!==info.c)return res.status(409).send();
  const receipt=createHash('sha256').update(token).digest('hex');
  GetDb().transaction(tx=>{
   init(tx);if(tx.get(sql`SELECT receipt FROM local_ramsgate_receipts_07 WHERE account=${a} AND sku=${info.sku} AND receipt=${receipt}`))return;
   if(info.sku===SKU&&used(tx,a))throw Error('Daily gift already claimed');
   let row=tx.query.inventory.findFirst({where:eq(inventory.characterId,info.c)}).sync();
   if(!row){row={characterId:info.c,stackedItems:'[]',instancedItems:'[]'};tx.insert(inventory).values(row).run();}
   const stacked=JSON.parse(row.stackedItems);
   for(const item of info.sku===SKU?items:packItems){const held=stacked.filter(x=>x.catalogId===item.catalogId);if(held.length>1)throw Error('Duplicate inventory stack');const old=held[0]?.quantity??0;
    if(!Number.isSafeInteger(old)||old<0||old+item.quantity>2147483647)throw Error('Invalid inventory quantity');
    if(held[0])held[0].quantity+=item.quantity;else stacked.push({...item});}
   tx.update(inventory).set({stackedItems:JSON.stringify(stacked)}).where(eq(inventory.characterId,info.c)).run();
   tx.run(sql`INSERT INTO local_ramsgate_receipts_07 VALUES (${a},${info.sku},${receipt},${day()})`);
  });info.done=true;res.status(204).send();
 }catch{res.status(409).send();}finally{busy.delete(a);}
});
module.exports={router,offer,items,packItems,parseTags};
