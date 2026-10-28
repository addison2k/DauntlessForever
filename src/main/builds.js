// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// Builds: read-only game catalogs + separate, local-only build drafts. Never opens a save for writing.
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./paths');
const MAX_BYTES = 1024 * 1024;
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
const normalize = (value) => String(value || '').slice(0, 100);
function catalog(v) {
  if (!v || !['1.14.7','1.6.2'].includes(v.id)) return { ok:false, error:'Unsupported version.' };
  // Installed server package can be newer than bundled. Fall back to bundled if not installed.
  const files = ['1.14.7','1.6.2'].includes(v.id) ? v.id === '1.14.7' ? 'gear-1147.json' : 'gear-162.json' : '';
  const pick = (name) => {
    for (const dir of [v.dataDir, path.join(v.bundledDir, 'package')]) {
      const p = path.join(dir, 'tools', name); if (fs.existsSync(p)) return p;
    }
    return null;
  };
  const f = pick(files); const raw = f ? readJson(f) : null;
  const gear = Array.isArray(raw) ? raw : raw && raw.items;
  if (!Array.isArray(gear)) return { ok:false, error:'Build catalog is not installed.' };
  const accepted = new Set(['Weapons','Armour','Lanterns','Weapon parts','Omnicells']);
  const items = gear.filter(g => Array.isArray(g) && accepted.has(g[2])).map(g => ({id:normalize(g[0]),name:normalize(g[1]),type:g[2]}));
  const cells = [];
  if (v.id === '1.14.7') {
    const c = pick('catalog-1147.json'); const all = c ? readJson(c) : null;
    for (const item of (all && all.items || [])) if (item && item.group === 'Cells' && !/TEST|DEBUG|PLACEHOLDER/i.test(item.id))
      cells.push({id:normalize(item.id),name:normalize(item.name),type:'Cells'});
  } else {
    const c = pick('catalog162-ids.txt');
    if (c) for (const id of fs.readFileSync(c, 'utf8').split(/\r?\n/)) if (/^CELL_[A-Z0-9_]{3,75}$/.test(id) && !/TEST|DEBUG|PLACEHOLDER/.test(id))
      cells.push({id, name:id.replace(/^CELL_/, '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, ch => ch.toUpperCase()),type:'Cells'});
  }
  return {ok:true,version:v.id,items,cells};
}
const savedFile = () => path.join(P.dataRoot(), 'saved-builds.json');
function load() {
  const d = readJson(savedFile()); return d && Array.isArray(d.builds) ? d.builds.slice(0,200) : [];
}
function valid(d) {
  if (!d || typeof d !== 'object' || !['1.14.7','1.6.2'].includes(d.version)) return null;
  const slots = {};
  for (const key of ['weapon','head','chest','arms','legs','lantern','omnicell','part']) {
    const value = d.slots && d.slots[key]; slots[key] = /^[A-Za-z0-9_\-]{3,100}$/.test(String(value||'')) ? value : '';
  }
  const cells = Array.isArray(d.cells) ? d.cells.slice(0,6).map(x => /^[A-Za-z0-9_\-]{3,100}$/.test(String(x)) ? x : '') : [];
  return {id:/^[a-zA-Z0-9-]{8,80}$/.test(String(d.id)) ? d.id : require('crypto').randomUUID(),name:String(d.name||'My build').slice(0,90),notes:String(d.notes||'').slice(0,280),version:d.version,slots,cells,locks:Array.isArray(d.locks)?d.locks.filter(x=>['weapon','head','chest','arms','legs','lantern','omnicell','part',...Array.from({length:6},(_,i)=>'cell'+i)].includes(x)).slice(0,14):[],likes:Math.min(1,Math.max(0,Number(d.likes)||0)),createdAt:Number(d.createdAt)||Date.now()};
}
function local(action, arg) {
  if (action === 'list') return {ok:true,builds:load()};
  if (action !== 'put' && action !== 'delete' && action !== 'like') return {ok:false,error:'Unknown action.'};
  const builds = load();
  if (action === 'put') { const item=valid(arg); if(!item) return {ok:false,error:'Invalid build.'};const i=builds.findIndex(x=>x.id===item.id);if(i>=0){item.createdAt=builds[i].createdAt;item.likes=builds[i].likes;builds[i]=item;}else if(builds.length<200)builds.unshift(item);else return {ok:false,error:'Local build limit reached.'}; }
  else { const i=builds.findIndex(x=>x.id===arg);if(i<0)return {ok:false,error:'Build not found.'};if(action==='delete')builds.splice(i,1);else builds[i].likes=builds[i].likes ? 0 : 1; }
  const text=JSON.stringify({schema:1,builds},null,2);if(Buffer.byteLength(text)>MAX_BYTES)return {ok:false,error:'Storage limit reached.'};
  try {fs.mkdirSync(P.dataRoot(),{recursive:true});const temp=savedFile()+'.tmp';fs.writeFileSync(temp,text,{encoding:'utf8',mode:0o600});fs.renameSync(temp,savedFile());return {ok:true,builds};}
  catch {return {ok:false,error:'Could not save builds.'};}
}
module.exports={catalog,local,valid};
