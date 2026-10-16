// Trials shop for Dauntless Forever 1.6.2. AGPL-3.0-only.
// Lady Luck / Trials shop by KombatKing (Dauntless Forever community), from his Consolidated Patches 0.2.
'use strict';
const {Router}=require('express'),{eq,sql}=require('drizzle-orm'),{randomBytes,createHash}=require('node:crypto');
const {GetDb}=require('./db'),{characters,inventory}=require('./db/schema');
const {HasUndauntedMetagameAuth}=require('./middleware/HasUndauntedMetagameAuth');
const {logger}=require('./logger');
const catalog=require('./trials-shop162-catalog.json'),bySku=new Map(catalog.map(o=>[o.id,o]));
const router=Router(),marks={steelmarks:'CURRENCY_MARKS_STEEL',gildedmarks:'CURRENCY_MARKS_GILDED'};
// Dauntless Forever: the 1.6.2 client names the currencies markssteel / marksgilded in /token and /notification.
const currencyAlias={markssteel:'steelmarks',marksgilded:'gildedmarks',currencymarkssteel:'steelmarks',currencymarksgilded:'gildedmarks'};
const currency=s=>{const c=String(s).replace(/[_\s-]/g,'').toLowerCase();return currencyAlias[c]||c;};
const hash=s=>createHash('sha256').update(s).digest('hex');
class ShopError extends Error{constructor(message,status=409){super(message);this.status=status;}}
function init(tx){tx.run(sql`CREATE TABLE IF NOT EXISTS local_trials_shop_tokens_162 (token_hash TEXT PRIMARY KEY,account TEXT NOT NULL,character_id TEXT NOT NULL,sku TEXT NOT NULL,currency TEXT NOT NULL,price INTEGER NOT NULL,issued_ms INTEGER NOT NULL,completed INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`);}
function account(req){const a=req.AuthData?.userId;if(req.AuthData?.IsGameserver||typeof a!=='string'||!a.length)throw new ShopError('Player login required',403);return a;}
async function character(a){const rows=await GetDb().query.characters.findMany({where:eq(characters.userId,a)});if(rows.length!==1)throw new ShopError('Exactly one owned character is required');return rows[0].characterId;}
function readInventory(row){
 const value=row?{stacked:JSON.parse(row.stackedItems),instanced:JSON.parse(row.instancedItems)}:{stacked:[],instanced:[]};
 if(!Array.isArray(value.stacked)||!Array.isArray(value.instanced))throw Error('Invalid saved inventory');
 const ids=new Set(),instances=new Set();
 for(const i of value.stacked){if(typeof i?.catalogId!=='string'||ids.has(i.catalogId)||!Number.isSafeInteger(i.quantity)||i.quantity<0||i.quantity>2147483647)throw Error('Invalid saved stack');ids.add(i.catalogId);}
 for(const i of value.instanced){if(typeof i?.catalogId!=='string'||typeof i?.instanceId!=='string'||instances.has(i.instanceId))throw Error('Invalid saved instance');instances.add(i.instanceId);}
 return value;
}
function saved(tx,c){return tx.query.inventory.findFirst({where:eq(inventory.characterId,c)}).sync();}
function quantity(inv,id){return inv.stacked.find(i=>i.catalogId===id)?.quantity??0;}
function owns(inv,item){return item.kind==='instanced'?inv.instanced.some(i=>i.catalogId===item.catalogId):quantity(inv,item.catalogId)>=item.quantity;}
function remaining(o,inv){return o.repeatable?1:o.items.every(i=>owns(inv,i))?0:1;}
function publicOffer(o,inv){return{id:o.id,displayName:o.displayName,displayDescription:o.displayDescription,displayPriority:o.displayPriority,tags:[...o.tags],platinumPrice:null,platinumSalePrice:null,cellDustPrice:null,prestigePrice:null,event01Price:null,steelMarksPrice:o.currency==='steelmarks'?o.price:null,gildedMarksPrice:o.currency==='gildedmarks'?o.price:null,items:o.items.map(({catalogId,quantity})=>({catalogId,quantity})),entitlements:[],maxAllowed:1,remaining:o.championOnly?0:remaining(o,inv),loadoutSlots:null,availableFrom:null,availableTo:null,timeAvailabilityReason:null,platformOfferId:null,missingEntitlementNames:o.championOnly?['Trials Champion — verified Top 100 leaderboard unlock']:null};}
function parseTags(v){if(Array.isArray(v))return v.flatMap(parseTags);if(typeof v!=='string')return[];try{const x=JSON.parse(v);if(Array.isArray(x))return x.flatMap(parseTags);}catch{}return v.split(/[,;|]/).map(t=>t.trim().toLowerCase()).filter(Boolean);}
function fail(res,e){if(!(e instanceof ShopError))logger.error('[TrialsShop162] '+e.message);return res.status(e.status||500).json({code:'trials_shop_error',message:e instanceof ShopError?e.message:'Trials shop could not complete this request'});}
async function ownedInventory(req){const a=account(req),c=await character(a),row=await GetDb().query.inventory.findFirst({where:eq(inventory.characterId,c)});return{a,c,inv:readInventory(row)};}
router.get('/product/skus/public',HasUndauntedMetagameAuth,async(req,res,next)=>{
 const tags=parseTags(req.query.requiredTags);if(!tags.every(t=>t==='ladyluckstore'))return next();
 try{const{inv}=await ownedInventory(req),added=catalog.map(o=>publicOffer(o,inv)),original=res.json;
  res.json=function(data){return original.call(this,Array.isArray(data)?[...data.filter(o=>!bySku.has(o?.id)),...added]:data);};return next();
 }catch(e){logger.warn('[TrialsShop162] offers not added: '+e.message);return next();} // Dauntless Forever: old reply instead of an error
});
router.get('/product/sku/:skuId',HasUndauntedMetagameAuth,async(req,res,next)=>{
 const o=bySku.get(req.params.skuId);if(!o)return next();try{const{inv}=await ownedInventory(req);return res.json(publicOffer(o,inv));}catch(e){return fail(res,e);}
});
async function balances(req,res,next){
 try{const{inv}=await ownedInventory(req),original=res.json,amounts=Object.fromEntries(Object.values(marks).flatMap(id=>[[id,quantity(inv,id)],['id_'+id.toLowerCase(),quantity(inv,id)]]));
  res.json=function(data){if(!data||typeof data!=='object'||Array.isArray(data))return original.call(this,data);return original.call(this,req.method==='POST'?{...data,balances:{...data.balances,...amounts}}:{...data,...amounts});};return next();
 }catch(e){return next();} // Dauntless Forever: balances always answer, with or without the marks
}
router.get('/balance',HasUndauntedMetagameAuth,balances);
router.post('/reconcile',HasUndauntedMetagameAuth,balances);
router.get('/token/:currency/:skuId',HasUndauntedMetagameAuth,async(req,res,next)=>{
 const o=bySku.get(req.params.skuId);if(!o)return next();
 try{const a=account(req),c=await character(a),cur=currency(req.params.currency);if(cur!==o.currency)throw new ShopError('This offer requires '+o.currency,400);if(o.championOnly)throw new ShopError('Champion rewards require verified Top 100 leaderboard support',403);
  const token='trials162_'+randomBytes(32).toString('hex'),now=Date.now();
  GetDb().transaction(tx=>{init(tx);const inv=readInventory(saved(tx,c));if(!remaining(o,inv))throw new ShopError('Already owned');if(quantity(inv,marks[cur])<o.price)throw new ShopError('Not enough Trials marks');
   // Completed receipts survive restart; old tokens cannot be redeemed after ten minutes.
   tx.run(sql`DELETE FROM local_trials_shop_tokens_162 WHERE issued_ms < ${now-7*86400000}`);
   const n=tx.get(sql`SELECT COUNT(*) AS n FROM local_trials_shop_tokens_162 WHERE account=${a} AND completed=0 AND issued_ms >= ${now-600000}`).n;if(n>=50)throw new ShopError('Too many pending purchases',429);
   tx.run(sql`INSERT INTO local_trials_shop_tokens_162 (token_hash,account,character_id,sku,currency,price,issued_ms) VALUES (${hash(token)},${a},${c},${o.id},${cur},${o.price},${now})`);
  });return res.json({purchaseToken:token});
 }catch(e){return fail(res,e);}
});
router.post('/notification/:currency',HasUndauntedMetagameAuth,async(req,res,next)=>{
 const token=[req.query.token,req.query.purchaseToken,req.body?.token,req.body?.purchaseToken].find(t=>typeof t==='string');if(!token?.startsWith('trials162_'))return next();
 try{const a=account(req),c=await character(a),cur=currency(req.params.currency),key=hash(token);
  GetDb().transaction(tx=>{init(tx);const info=tx.get(sql`SELECT * FROM local_trials_shop_tokens_162 WHERE token_hash=${key}`);if(!info||info.account!==a||info.character_id!==c)throw new ShopError('Purchase does not belong to this character',403);if(info.currency!==cur)throw new ShopError('Purchase currency mismatch',400);if(info.completed)return;
   if(Date.now()-info.issued_ms>600000)throw new ShopError('Purchase token expired',410);
   const o=bySku.get(info.sku);if(!o||o.currency!==cur||o.price!==info.price||o.championOnly)throw new ShopError('Offer changed or is locked');
   const row=saved(tx,c);if(!row)throw new ShopError('Saved inventory missing');const inv=readInventory(row);if(!remaining(o,inv))throw new ShopError('Already owned');
   const held=inv.stacked.find(i=>i.catalogId===marks[cur]);if(!held||held.quantity<o.price)throw new ShopError('Not enough Trials marks');held.quantity-=o.price;
   for(const item of o.items){if(!o.repeatable&&owns(inv,item))continue;if(item.kind==='instanced'){inv.instanced.push({catalogId:item.catalogId,instanceId:item.catalogId,itemData:null,updateVersion:0});}
    else{const stack=inv.stacked.find(i=>i.catalogId===item.catalogId),n=(stack?.quantity??0)+item.quantity;if(!Number.isSafeInteger(n)||n>2147483647)throw new ShopError('Inventory stack limit reached');if(stack)stack.quantity=n;else inv.stacked.push({catalogId:item.catalogId,quantity:n});}}
   tx.update(inventory).set({stackedItems:JSON.stringify(inv.stacked),instancedItems:JSON.stringify(inv.instanced)}).where(eq(inventory.characterId,c)).run();
   tx.run(sql`UPDATE local_trials_shop_tokens_162 SET completed=1 WHERE token_hash=${key}`);
  });return res.status(204).send();
 }catch(e){return fail(res,e);}
});
module.exports={router,catalog,publicOffer,readInventory,parseTags};
