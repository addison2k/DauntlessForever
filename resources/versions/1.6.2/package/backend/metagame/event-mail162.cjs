'use strict';
// By KombatKing (Dauntless Forever community), from his All-in-One R4. AGPL-3.0-only.
// Dauntless 1.6.2 event inbox support. AGPL-3.0-only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const TITLES={Saints_Bond_2021:"Saint's Bond has begun",Spring_Event_2020:'Springtide has begun',Dark_Harvest:'Dark Harvest has begun',Ramsgiving:'Ramsgiving has begun',Frostfall:'Frostfall has begun'};
const BODIES={
 Saints_Bond_2021:"Saint's Bond has arrived in Ramsgate. Celebrate friendship and the bonds between Slayers during this month's festivities.",
 Spring_Event_2020:'Springtide has arrived! Look for the seasonal event in the hunt menu and join the celebration in Ramsgate.',
 Dark_Harvest:'The Unseen are stirring. Dark Harvest has begun, and Unseen Summons awaits in the event hunt menu. Face the Shrowd and watch the ritual braziers. Explore Ramsgate for seasonal mysteries.',
 Ramsgiving:'Happy Ramsgiving, Slayer! The Ramsgiving season has arrived. Celebrate with Ramsgate throughout November.',
 Frostfall:'Frostfall has arrived! Celebrate the winter season with the people of Ramsgate throughout December.'
};
function account(value){if(typeof value!=='string'||!value||value.length>256)throw Error('Authenticated account ID required.');return value;}
function stamp(value){const d=new Date(value===undefined?Date.now():value);if(!Number.isFinite(d.getTime()))throw Error('Invalid mailbox time.');return d.toISOString();}
function atomic(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';try{fs.writeFileSync(tmp,bytes,{flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
function create(root,options={}){
 root=path.resolve(root);const dir=path.join(root,'data/mailbox'),calendar=options.calendar||(()=>require(path.join(root,'tools/holiday-schedule.cjs'))),clock=options.clock||(()=>new Date());
 function filename(uid){return path.join(dir,crypto.createHash('sha256').update(account(uid)).digest('hex')+'.json');}
 function transaction(uid,fn){const file=filename(uid);fs.mkdirSync(dir,{recursive:true});const lock=file+'.lock';let fd;try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code==='EEXIST')throw Object.assign(Error('Mailbox is busy. Retry the request.'),{status:503});throw e;}
  try{const previous=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;const state=previous===null?{version:1,account_id:uid,messages:[]}:JSON.parse(previous);
   if(state.version!==1||state.account_id!==uid||!Array.isArray(state.messages)||state.messages.some(m=>!m||typeof m.message_id!=='string'||!['unread','read','deleted'].includes(m.status))||new Set(state.messages.map(m=>m.message_id)).size!==state.messages.length)throw Error('Mailbox data is invalid; no reset was performed.');
   const result=fn(state),next=JSON.stringify(state,null,2)+'\n';if(previous!==next)atomic(file,next);return result;
  }finally{fs.closeSync(fd);fs.rmSync(lock,{force:true});}}
 function message(id,title,body,now){return {message_id:id,message_category:'events',message_treatment:'default',can_delete:true,menu_background:'',menu_title:title,title,title_image:'',subtitle_text:'Ramsgate Notice Board',body_background:'',body,image:'',cta_text:'',cta_action:[],promotional:false,status:'unread',timestamp:stamp(now),parcelStatus:'',sku:''};}
 function once(state,m){if(state.messages.some(row=>row.message_id===m.message_id))return false;state.messages.push(m);return true;}
 function list(uid){const now=stamp(clock()),events=calendar().active(now);return transaction(account(uid),s=>{for(const e of events){if(!TITLES[e.id])continue;const id='holiday:'+e.id+':'+e.start,body=BODIES[e.id]+'\n\nEvent period (UTC): '+e.start.slice(0,10)+' to '+e.end.slice(0,10)+' (end date exclusive).';once(s,message(id,TITLES[e.id],body,now));}return {messages:s.messages.filter(m=>m.status!=='deleted').map(m=>({...m,cta_action:[...m.cta_action]})).sort((a,b)=>b.timestamp.localeCompare(a.timestamp))};});}
 function mark(uid,ids,status){if(!Array.isArray(ids)||ids.length>200||ids.some(v=>typeof v!=='string'||v.length>256))throw Object.assign(Error('message_ids must be a list of message IDs.'),{status:400});return transaction(account(uid),s=>{let changed=0;const wanted=new Set(ids);for(const m of s.messages)if(wanted.has(m.message_id)&&m.status!=='deleted'&&m.status!==status){m.status=status;changed++;}return {message_ids:ids,updated:changed};});}
 function sendTest(uid){return transaction(account(uid),s=>{const id='server-test:event-mail-162:v1',inserted=once(s,message(id,'Server mail test','This is a test message from your Dauntless Forever server. Event mail is now supported. Reading or deleting this message should remain saved after restarting the game.',clock()));return {account_id:uid,message_id:id,inserted};});}
 function inspect(uid){return transaction(account(uid),s=>({account_id:uid,messages:s.messages.map(m=>({...m}))}));}
 return {list,markRead:(u,ids)=>mark(u,ids,'read'),markDeleted:(u,ids)=>mark(u,ids,'deleted'),sendTest,inspect,filename};
}
function routes(router,auth,root){const mail=create(root);function run(fn){return(req,res)=>{const uid=req.AuthData&&req.AuthData.userId;if(typeof uid!=='string'||!uid)return res.status(401).json({code:'unauthorized',message:'Authenticated player required.',payload:null});try{return res.status(200).json({code:null,message:'OK',payload:fn(mail,uid,req)});}catch(e){console.error('Event mailbox:',e.code||e.message);return res.status(e.status||500).json({code:'mailbox_error',message:e.status?e.message:'Mailbox could not be loaded; saved data retained.',payload:null});}};}
 router.get('/all/',auth,run((m,u)=>m.list(u)));
 router.post('/mailbox/markAsRead',auth,run((m,u,r)=>m.markRead(u,r.body&&r.body.message_ids)));
 router.post('/mailbox/markAsDeleted',auth,run((m,u,r)=>m.markDeleted(u,r.body&&r.body.message_ids)));
 return mail;
}
module.exports={create,routes};
