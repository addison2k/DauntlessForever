// Dauntless Forever - launcher
// Copyright (C) 2026 Addison2k. https://github.com/addison2k/DauntlessForever
// Licence: AGPL-3.0-only. Keep this notice: the licence requires it.
// Builds v1: local editor / local library / catalogue / READ-ONLY inventory comparison.
'use strict';
(() => {
  const el = id => document.getElementById(id);
  const slotTypes = ['weapon','head','chest','arms','legs','lantern','omnicell','part'];
  const dictionary = {
    es: {
      'Builds':'Builds','New':'Nuevo','Create, compare and share your setups':'Crea, compara y comparte configuraciones',
      'Version':'Versi\u00f3n','Character':'Personaje','Refresh inventory':'Actualizar inventario',
      'Builder':'Constructor','Catalog':'Cat\u00e1logo','My builds':'Mis builds',
      'Build name':'Nombre de la build','Notes':'Notas','Weapon':'Arma','Head':'Cabeza','Chest':'Pecho','Arms':'Brazos',
      'Legs':'Piernas','Lantern':'Linterna','Omnicell':'Omnic\u00e9lula','Weapon part':'Pieza de arma','Cells':'C\u00e9lulas',
      'No selection':'Sin seleccionar','Choose':'Elegir','Remove':'Quitar','Search item or ID':'Buscar objeto o ID',
      'Save build':'Guardar build','Duplicate':'Duplicar','Clear builder':'Limpiar constructor','Copy share code':'Copiar c\u00f3digo',
      'Select an item':'Selecciona un objeto','Search gear or cells':'Buscar equipo o celulas',
      'All types':'Todos los tipos','Owned only':'Solo en posesi\u00f3n','All equipment':'Todo el equipo','Missing only':'Solo faltantes',
      'None':'Ninguno','Unknown':'Sin comprobar','Owned':'Disponible','Missing':'Falta','Required':'Necesario',
      'No character data':'No hay datos de personaje','Read-only inventory':'Inventario de solo lectura',
      'Not checked':'Sin comprobar','Equipment and cells are estimates until verified by the game.':'El equipo y las celulas se comparan con el inventario; las bonificaciones requieren verificacion.',
      'Local collection':'Colecci\u00f3n local','These are saved on this PC only. Public rankings and votes require an official community service.':'Estas builds solo se guardan en esta PC. Los rankings y votos publicos necesitan un servicio comunitario oficial.',
      'Import share code':'Importar c\u00f3digo','Export collection':'Exportar coleccion','Most liked':'Mas votadas','Newest':'Mas recientes',
      'Open in builder':'Abrir en constructor','Local like':'Voto local','Delete':'Eliminar','No builds saved yet.':'Aun no tienes builds guardadas.',
      'Share code copied.':'Codigo copiado.','Build saved locally.':'Build guardada localmente.','Build deleted.':'Build eliminada.',
      'Could not read the inventory.':'No se pudo leer el inventario.','Catalog unavailable.':'Catalogo no disponible.',
      'Select a saved character to compare items.':'Selecciona un personaje guardado para comparar equipo.',
      'Choose an item from the catalog.':'Elige un objeto del catalogo.','Unknown item':'Objeto desconocido',
      'No matching items.':'No hay objetos coincidentes.','Import':'Importar','Paste the shared build JSON':'Pega el JSON de la build compartida',
      'Invalid share code.':'Codigo de build invalido.','Imported to your local collection.':'Importada a tu coleccion local.',
      'Build opened.':'Build abierta.','No catalog entries for this slot.':'No hay entradas disponibles para este espacio.',
      'Local library exported.':'Coleccion local exportada.','Select a build to edit':'Elige una build para editar',
      'Version-specific catalog':'Catalogo por version','Only local votes':'Solo votos locales','Gear':'Equipo',
      'Not provided by save reader':'No disponible en el lector de partida',
      'This page never writes to any game save. Community uploads and global votes are not active.':'Esta pagina nunca modifica partidas. La publicacion comunitaria y los votos globales aun no estan activos.',
      'No save or setup detected':'No se detecto partida o configuracion','Saved build':'Build guardada','Select':'Seleccionar',
      'No build in editor.':'El constructor esta vacio.','Could not copy. Select and copy the share code below.':'No se pudo copiar. Selecciona y copia el codigo mostrado.',
      'Copied':'Copiado','Delete this build?':'Eliminar esta build?','Your build is not published online.':'Tu build no se ha publicado en linea.'
    },
    fr: {
      'Builds':'Builds','New':'Nouveau','Create, compare and share your setups':'Creez, comparez et partagez vos builds',
      'Version':'Version','Character':'Personnage','Refresh inventory':'Actualiser l\u0027inventaire','Builder':'Constructeur','Catalog':'Catalogue','My builds':'Mes builds',
      'Build name':'Nom du build','Notes':'Notes','Weapon':'Arme','Head':'Tete','Chest':'Torse','Arms':'Bras','Legs':'Jambes',
      'Lantern':'Lanterne','Omnicell':'Omnicellule','Weapon part':'Piece d\u0027arme','Cells':'Cellules','No selection':'Aucun choix','Choose':'Choisir','Remove':'Retirer',
      'Search item or ID':'Rechercher objet ou ID','Save build':'Enregistrer','Duplicate':'Dupliquer','Clear builder':'Effacer le build',
      'Copy share code':'Copier le code','Select an item':'Selectionner un objet','Search gear or cells':'Rechercher equipement ou cellules',
      'All types':'Tous les types','Owned only':'Possedes seulement','All equipment':'Tout','Missing only':'Manquants uniquement',
      'None':'Aucun','Unknown':'Inconnu','Owned':'Possede','Missing':'Manquant','Required':'Requis','No character data':'Aucun personnage',
      'Read-only inventory':'Inventaire en lecture seule','Not checked':'Non verifie','Equipment and cells are estimates until verified by the game.':'Les bonus doivent etre verifies dans le jeu.',
      'Local collection':'Collection locale','These are saved on this PC only. Public rankings and votes require an official community service.':'Les builds restent sur ce PC. Le classement et les votes publics exigent un service communautaire.',
      'Import share code':'Importer un code','Export collection':'Exporter la collection','Most liked':'Plus aimes','Newest':'Plus recents','Open in builder':'Ouvrir','Local like':'Vote local','Delete':'Supprimer','No builds saved yet.':'Aucun build enregistre.',
      'Share code copied.':'Code copie.','Build saved locally.':'Build sauvegarde localement.','Build deleted.':'Build supprime.',
      'Could not read the inventory.':'Impossible de lire l\u0027inventaire.','Catalog unavailable.':'Catalogue indisponible.',
      'Select a saved character to compare items.':'Selectionnez un personnage pour comparer.', 'Choose an item from the catalog.':'Choisissez un objet du catalogue.',
      'Unknown item':'Objet inconnu','No matching items.':'Aucun resultat.','Import':'Importer','Paste the shared build JSON':'Collez le JSON partage','Invalid share code.':'Code invalide.','Imported to your local collection.':'Importe dans la collection locale.','Build opened.':'Build ouvert.',
      'No catalog entries for this slot.':'Aucun objet pour cet emplacement.','Local library exported.':'Collection locale exportee.',
      'Select a build to edit':'Choisir un build','Version-specific catalog':'Catalogue par version','Only local votes':'Votes locaux seulement','Gear':'Equipement',
      'Not provided by save reader':'Non fourni par le lecteur de sauvegarde','This page never writes to any game save. Community uploads and global votes are not active.':'Cette page ne modifie jamais les sauvegardes. Publication et votes globaux non actifs.',
      'No save or setup detected':'Sauvegarde non trouvee','Saved build':'Build enregistre','Select':'Choisir','No build in editor.':'Constructeur vide.',
      'Could not copy. Select and copy the share code below.':'Copie impossible. Copiez le code ci-dessous.','Copied':'Copie','Delete this build?':'Supprimer ce build?','Your build is not published online.':'Votre build n\u0027est pas publie en ligne.'
    },
    de: {
      'Builds':'Builds','New':'Neu','Create, compare and share your setups':'Builds erstellen, vergleichen und teilen',
      'Version':'Version','Character':'Charakter','Refresh inventory':'Inventar aktualisieren','Builder':'Baukasten','Catalog':'Katalog','My builds':'Meine Builds',
      'Build name':'Build-Name','Notes':'Notizen','Weapon':'Waffe','Head':'Kopf','Chest':'Brust','Arms':'Arme','Legs':'Beine',
      'Lantern':'Laterne','Omnicell':'Omnizelle','Weapon part':'Waffenteil','Cells':'Zellen','No selection':'Nicht ausgewaehlt',
      'Choose':'Auswaehlen','Remove':'Entfernen','Search item or ID':'Gegenstand oder ID suchen',
      'Save build':'Build speichern','Duplicate':'Duplizieren','Clear builder':'Baukasten leeren','Copy share code':'Freigabecode kopieren',
      'Select an item':'Gegenstand waehlen','Search gear or cells':'Ausrustung oder Zellen suchen','All types':'Alle Typen',
      'Owned only':'Nur eigene','All equipment':'Alles','Missing only':'Nur fehlende','None':'Keine','Unknown':'Unbekannt',
      'Owned':'Vorhanden','Missing':'Fehlt','Required':'Benoetigt','No character data':'Keine Charakterdaten',
      'Read-only inventory':'Inventar nur lesbar','Not checked':'Nicht geprueft','Equipment and cells are estimates until verified by the game.':'Boni muessen im Spiel ueberprueft werden.',
      'Local collection':'Lokale Sammlung','These are saved on this PC only. Public rankings and votes require an official community service.':'Builds werden nur lokal gespeichert. Oeffentliche Ranglisten benoetigen einen Community-Dienst.',
      'Import share code':'Code importieren','Export collection':'Sammlung exportieren','Most liked':'Beliebteste','Newest':'Neueste',
      'Open in builder':'Im Baukasten oeffnen','Local like':'Lokaler Vote','Delete':'Loeschen','No builds saved yet.':'Noch keine Builds gespeichert.',
      'Share code copied.':'Code kopiert.','Build saved locally.':'Build lokal gespeichert.','Build deleted.':'Build geloescht.',
      'Could not read the inventory.':'Inventar konnte nicht gelesen werden.','Catalog unavailable.':'Katalog nicht verfuegbar.',
      'Select a saved character to compare items.':'Charakter auswaehlen, um Ausruestung zu vergleichen.',
      'Choose an item from the catalog.':'Gegenstand aus Katalog waehlen.','Unknown item':'Unbekannter Gegenstand',
      'No matching items.':'Keine Treffer.','Import':'Importieren','Paste the shared build JSON':'Geteilten Build-JSON einfuegen',
      'Invalid share code.':'Ungueltiger Code.','Imported to your local collection.':'Lokal importiert.','Build opened.':'Build geoeffnet.',
      'No catalog entries for this slot.':'Keine Eintraege fuer diesen Platz.','Local library exported.':'Lokale Sammlung exportiert.',
      'Select a build to edit':'Build zum Bearbeiten waehlen','Version-specific catalog':'Versionsspezifischer Katalog','Only local votes':'Nur lokale Stimmen','Gear':'Ausrustung',
      'Not provided by save reader':'Nicht vom Speicherleser verfuegbar',
      'This page never writes to any game save. Community uploads and global votes are not active.':'Diese Seite aendert nie Spielstaende. Community-Uploads und globale Abstimmungen sind nicht aktiv.',
      'No save or setup detected':'Spielstand nicht gefunden','Saved build':'Build gespeichert','Select':'Waehlen',
      'No build in editor.':'Der Baukasten ist leer.','Could not copy. Select and copy the share code below.':'Kopieren fehlgeschlagen. Code unten manuell kopieren.','Copied':'Kopiert','Delete this build?':'Build loeschen?','Your build is not published online.':'Build ist nicht online veroeffentlicht.'
    }
  };
  const extraTranslations = {
  "es": {
    "Build suggestions": "Sugerencias de build",
    "Fill open slots with available gear. Locked pieces stay as they are.": "Completa los espacios con objetos disponibles. Las piezas fijadas no se cambian.",
    "Suggest a build": "Sugerir build",
    "Weapon type": "Tipo de arma",
    "Element": "Elemento",
    "Preferred name / cell": "Nombre o celula preferida",
    "Allow missing gear": "Permitir equipo faltante",
    "Lock a slot to keep it unchanged": "Fija cada pieza que quieras conservar",
    "Equipment": "Equipamiento",
    "Build summary": "Resumen de la build",
    "Selected cells": "Celulas elegidas",
    "Perk values and damage are not calculated until catalog stats are verified.": "Las ventajas y el dano no se calculan sin estadisticas verificadas.",
    "Illustration - not a live 3D model": "Vista ilustrativa, no es el personaje 3D real",
    "No owned equipment found. Choose a character or allow missing items.": "No se encontraron objetos confirmados. Selecciona un personaje o permite faltantes.",
    "Suggestion based on inventory, not on verified damage or perks.": "Sugerencia basada en inventario, no en dano ni ventajas comprobadas.",
    "No slots could be completed. Check your filters and locks.": "No se pudo completar ningun espacio. Revisa filtros y bloqueos.",
    "Lock": "Fijar",
    "Unlock": "Liberar",
    "Suggested": "Sugerido",
    "Any": "Cualquiera",
    "Hammer": "Martillo",
    "Sword": "Espada",
    "Axe": "Hacha",
    "Chain Blades": "Espadas encadenadas",
    "War Pike": "Pica de guerra",
    "Repeaters": "Repetidoras",
    "Aether Strikers": "Punios aethericos"
  },
  "fr": {
    "Build suggestions": "Suggestions de builds",
    "Fill open slots with available gear. Locked pieces stay as they are.": "Complete les emplacements avec les objets disponibles. Les pieces verrouillees ne changent pas.",
    "Suggest a build": "Suggerer un build",
    "Weapon type": "Type d arme",
    "Element": "Element",
    "Preferred name / cell": "Nom ou cellule preferee",
    "Allow missing gear": "Autoriser les pieces manquantes",
    "Lock a slot to keep it unchanged": "Verrouillez les pieces a conserver",
    "Equipment": "Equipement",
    "Build summary": "Resume du build",
    "Selected cells": "Cellules selectionnees",
    "Perk values and damage are not calculated until catalog stats are verified.": "Bonus et degats non calcules sans statistiques verifiees.",
    "Illustration - not a live 3D model": "Silhouette illustrative; pas le modele 3D",
    "No owned equipment found. Choose a character or allow missing items.": "Aucun equipement possede trouve. Choisissez un personnage ou autorisez les objets manquants.",
    "Suggestion based on inventory, not on verified damage or perks.": "Suggestion basee sur l inventaire; degats et bonus non verifies.",
    "No slots could be completed. Check your filters and locks.": "Aucun emplacement rempli. Verifiez les filtres.",
    "Lock": "Verrouiller",
    "Unlock": "Deverrouiller",
    "Suggested": "Suggere",
    "Any": "Tous",
    "Hammer": "Marteau",
    "Sword": "Epee",
    "Axe": "Hache",
    "Chain Blades": "Lames en chaine",
    "War Pike": "Pique de guerre",
    "Repeaters": "Revolvers",
    "Aether Strikers": "Poings aetheriques"
  },
  "de": {
    "Build suggestions": "Build-Vorschlaege",
    "Fill open slots with available gear. Locked pieces stay as they are.": "Freie Plaetze mit vorhandener Ausruestung fuellen. Gesperrte Teile bleiben erhalten.",
    "Suggest a build": "Build vorschlagen",
    "Weapon type": "Waffentyp",
    "Element": "Element",
    "Preferred name / cell": "Bevorzugter Name / Zelle",
    "Allow missing gear": "Fehlende Ausruestung erlauben",
    "Lock a slot to keep it unchanged": "Gesperrte Teile bleiben unveraendert",
    "Equipment": "Ausruestung",
    "Build summary": "Build-Uebersicht",
    "Selected cells": "Ausgewaehlte Zellen",
    "Perk values and damage are not calculated until catalog stats are verified.": "Perks und Schaden werden ohne gepruefte Werte nicht berechnet.",
    "Illustration - not a live 3D model": "Illustration, kein echtes 3D-Modell",
    "No owned equipment found. Choose a character or allow missing items.": "Keine eigene Ausruestung gefunden. Waehle einen Charakter oder erlaube fehlende Objekte.",
    "Suggestion based on inventory, not on verified damage or perks.": "Vorschlag nach Inventar, nicht nach geprueftem Schaden oder Perks.",
    "No slots could be completed. Check your filters and locks.": "Keine freien Plaetze belegt. Filter pruefen.",
    "Lock": "Sperren",
    "Unlock": "Entsperren",
    "Suggested": "Vorgeschlagen",
    "Any": "Alle",
    "Hammer": "Hammer",
    "Sword": "Schwert",
    "Axe": "Axt",
    "Chain Blades": "Kettenklingen",
    "War Pike": "Kriegspike",
    "Repeaters": "Repetierer",
    "Aether Strikers": "Aetherfaeuste"
  }
};
  for(const lang of Object.keys(extraTranslations))Object.assign(dictionary[lang],extraTranslations[lang]);
  const tr = key => (dictionary[window.I18N && I18N.lang()] || {})[key] || key;
  const fieldNames = {weapon:'Weapon',head:'Head',chest:'Chest',arms:'Arms',legs:'Legs',lantern:'Lantern',omnicell:'Omnicell',part:'Weapon part'};
  let catalog = [], cells = [], owned = null, characters = [], saved = [], editor = blank('1.14.7'), tab = 'editor', filterSlot = 'weapon', loaded=false, icons = window.DFBuildIconIndex || {};
  function blank(version) { return {id:'',name:'',notes:'',version,slots:Object.fromEntries(slotTypes.map(x=>[x,''])),cells:['','','','','',''],locks:[]}; }
  const node=(tag,cls,text) => {const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const print=(id,text)=>{const e=el(id);if(e)e.textContent=text;};
  function note(s) { print('build-message',s); }
  function version() { return el('build-version').value; }
  function matchSlot(it,k) {
    if(k==='weapon')return it.type==='Weapons';
    if(k==='lantern')return it.type==='Lanterns';
    if(k==='omnicell')return it.type==='Omnicells';
    if(k==='part')return it.type==='Weapon parts';
    if(it.type!=='Armour')return false;
    const s=(it.id+' '+it.name).toUpperCase();
    if(k==='head')return /(_HELM|_HEAD|_MASK|_HOOD| HELM| HELMET| MASK| HOOD| CASQUE| CROWN| VISAGE| GAZE| EPIPHANY| CANOPY| EYE OF)/.test(s);
    if(k==='chest')return /(_CHEST|_TORSO|_BODY|_PLATE| PLATE| CHEST| CUIRASS| CLOAK| BREASTPLATE| ROBE| MANTLE| RESOLVE| BOLE)/.test(s);
    if(k==='arms')return /(_ARMS|_HANDS|_GLOVES| GAUNTLET| GLOVE| GRIP| BRACER| HAND| GRASP| MIGHT| BRANCHES)/.test(s);
    if(k==='legs')return /(_LEGS|_FEET|_BOOTS|_GREAVES| BOOT| GREAVE| STRIDE| TREAD| MARCH| ROOTS)/.test(s);
    return false;
  }
  // Self-contained, original placeholder symbols. No third-party game art.
  const fallbackLetters = {weapon:'W',head:'H',chest:'C',arms:'A',legs:'L',lantern:'N',omnicell:'O',part:'P',cell:'+'};
  function iconFor(it,slot) {
    const kind = (slot||'').replace(/cell[0-9]/,'cell');
    const letter = fallbackLetters[kind] || '?';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'+
      '<rect x="2" y="2" width="60" height="60" rx="10" fill="#203642" stroke="#64aab4" stroke-width="2"/>'+
      '<text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold" font-size="30" fill="#edf6fa">'+letter+'</text></svg>';
    return 'data:image/svg+xml,'+encodeURIComponent(svg);
  }
  function itemIcon(it,slot){const img=node('img','builds-item-image');img.loading='lazy';img.alt='';img.src=iconFor(it,slot);return img;}
  function currentLocks(){return new Set(Array.isArray(editor.locks)?editor.locks:[]);}
  function toggleLock(key){snapshot();const locks=currentLocks();locks.has(key)?locks.delete(key):locks.add(key);editor.locks=[...locks];showEditor();}
  function isTemp(it){return /^(\[temp\]|\[test\]|\[debug\])/i.test(it.name)||/(TEST|DEBUG|PLACEHOLDER)/.test(it.id);}
  const weaponPrefixes={hammer:'WP_IH_',sword:'WP_EB_',axe:'WP_GA_',chainblades:'WP_CB_',warpike:'WP_MS_',repeaters:'WP_DP_',strikers:'WP_AC_'};
  function weaponMatches(it,filter){return filter==='any'||(it.id||'').startsWith(weaponPrefixes[filter]||'!')||it.name.toLowerCase().includes(({hammer:'hammer',sword:'sword',axe:'axe',chainblades:'chain blades',warpike:'war pike',repeaters:'repeaters',strikers:'aether strikers'})[filter]||'!!!!!');}
  function relevance(it,slot,element,prefer){
    const v=(it.name+' '+it.id).toLowerCase();let score=0;
    if(getOwned(it)===true)score+=10000;
    if(element!=='any' && v.includes(element))score+=350;
    if(prefer && v.includes(prefer))score+=500;
    if(/RECRUIT|TRAINING|DEFAULT/i.test(v))score-=100;
    score+=Math.min(it.name.length,35)/3;
    return score;
  }
  function recommendBuild(){
    snapshot();const allowMissing=el('build-allow-missing').checked;
    if(!owned&&!allowMissing){note(tr('No owned equipment found. Choose a character or allow missing items.'));return;}
    const element=el('build-element-filter').value,wt=el('build-weapon-filter').value,prefer=el('build-preference').value.trim().toLowerCase();
    const locked=currentLocks();const used=new Set([...Object.values(editor.slots),...editor.cells].filter(Boolean));let n=0;
    for(const key of slotTypes){
      if(locked.has(key))continue;
      // Part compatibility cannot be inferred safely from the current catalog.
      if(key==='part')continue;
      const candidates=catalog.filter(it=>matchSlot(it,key)&&!isTemp(it)&&!used.has(it.id)&&(allowMissing||getOwned(it)===true)&&(key!=='weapon'||weaponMatches(it,wt)));
      candidates.sort((a,b)=>relevance(b,key,element,prefer)-relevance(a,key,element,prefer)||a.id.localeCompare(b.id));
      if(candidates.length){if(editor.slots[key])used.delete(editor.slots[key]);editor.slots[key]=candidates[0].id;used.add(candidates[0].id);n++;}
    }
    // Cells are not verified by the existing save reader. Do not pretend they are owned.
    // Only fill them with unverified suggestions when explicitly allowed.
    if(allowMissing){const cellChoices=cells.filter(x=>!isTemp(x)).sort((a,b)=>relevance(b,'cell',element,prefer)-relevance(a,'cell',element,prefer)||a.id.localeCompare(b.id));
      for(let i=0;i<6;i++){if(locked.has('cell'+i))continue;const choice=cellChoices.find(x=>!used.has(x.id));if(choice){if(editor.cells[i])used.delete(editor.cells[i]);editor.cells[i]=choice.id;used.add(choice.id);n++;}}
    }
    showEditor();print('build-recommend-explain',tr(n?'Suggestion based on inventory, not on verified damage or perks.':'No slots could be completed. Check your filters and locks.'));
  }
  function showSummary() {
    print('build-preview-name',characters.find(x=>x.id===el('build-character').value)?.name||'Slayer');
    print('build-preview-version',version());
    for(const key of ['head','chest','arms','legs']){const img=el('build-avatar-img-'+key);const it=itemFor(editor.slots[key]);if(img){img.src=iconFor(it,key);img.parentElement.title=it?it.name:tr(fieldNames[key]);img.parentElement.classList.toggle('is-equipped',!!it);}}
    const list=el('build-perks-list');list.replaceChildren();
    for(let i=0;i<6;i++) {const it=itemFor(editor.cells[i]);if(!it)continue;
      const row=node('div','builds-perk-row');row.append(itemIcon(it,'cell'+i),node('span','',it.name),node('small','',status(it)));list.append(row);
    }
    if(!list.children.length)list.append(node('p','builds-perks-empty',tr('No selection')));
  }
  function itemFor(id) {return catalog.concat(cells).find(x=>x.id===id);}
  function getOwned(it) {
    if (!it || !owned) return null;
    if (owned.gearSet && owned.gearSet.has(it.id)) return true;
    if (owned.items && Number(owned.items[it.id])>0) return true;
    if (it.type==='Cells') return null; // Some builds store cells inside gearData, not exposed by the read-only inventory helper.
    return false;
  }
  function mark(it) {const yes=getOwned(it);return yes===null?'?':yes?'\u2713':'!';}
  function status(it) {const yes=getOwned(it);return yes===null?tr('Unknown'):yes?tr('Owned'):tr('Missing');}
  function setLabels() {
    const texts={'build-nav-label':'Builds','build-title':'Builds','build-subtitle':'Create, compare and share your setups','build-version-label':'Version','build-character-label':'Character',
      'build-refresh':'Refresh inventory','build-tab-editor':'Builder','build-tab-catalog':'Catalog','build-tab-community':'My builds',
      'build-name-label':'Build name','build-notes-label':'Notes','build-cells-heading':'Cells','build-cells-hint':'Equipment and cells are estimates until verified by the game.',
      'build-save':'Save build','build-duplicate':'Duplicate','build-clear':'Clear builder','build-share':'Copy share code',
      'build-community-explanation':'These are saved on this PC only. Public rankings and votes require an official community service.',
      'build-import':'Import share code','build-local-export':'Export collection',
      'build-disclaimer':'This page never writes to any game save. Community uploads and global votes are not active.',
      'build-recommend-title':'Build suggestions','build-recommend-desc':'Fill open slots with available gear. Locked pieces stay as they are.','build-recommend':'Suggest a build',
      'build-weapon-filter-label':'Weapon type','build-element-filter-label':'Element','build-preference-label':'Preferred name / cell',
      'build-allow-missing-label':'Allow missing gear','build-equipment-title':'Equipment','build-lock-help':'Lock a slot to keep it unchanged',
      'build-summary-title':'Build summary','build-perks-title':'Selected cells','build-summary-hint':'Perk values and damage are not calculated until catalog stats are verified.',
      'build-avatar-hint':'Illustration - not a live 3D model'};
    for(const [id,value] of Object.entries(texts))print(id,tr(value));
    print('build-nav-new',tr('New'));
    el('build-preference').placeholder=tr('Preferred name / cell');
    for(const o of el('build-weapon-filter').options)o.textContent=tr({'any':'Any','hammer':'Hammer','sword':'Sword','axe':'Axe','chainblades':'Chain Blades','warpike':'War Pike','repeaters':'Repeaters','strikers':'Aether Strikers'}[o.value]);
    for(const o of el('build-element-filter').options)o.textContent=tr(o.value==='any'?'Any':o.value.charAt(0).toUpperCase()+o.value.slice(1));
    el('build-search').placeholder=tr('Search item or ID');el('build-catalog-search').placeholder=tr('Search gear or cells');el('build-import-text').placeholder=tr('Paste the shared build JSON');
    const type=el('build-catalog-type'),ot=type.value;type.replaceChildren();
    for(const v of ['All types','Weapons','Armour','Lanterns','Weapon parts','Omnicells','Cells'])type.add(new Option(tr(v),v));type.value=ot||'All types';
    const own=el('build-catalog-owned'),ov=own.value;own.replaceChildren();for(const v of ['All equipment','Owned only','Missing only'])own.add(new Option(tr(v),v));own.value=ov||'All equipment';
    const sort=el('build-sort'),sv=sort.value;sort.replaceChildren();for(const v of ['Newest','Most liked'])sort.add(new Option(tr(v),v));sort.value=sv||'Newest';
  }
  function elementRow(it,onClick) {
    const b=node('button','builds-result');b.type='button';
    b.append(itemIcon(it,it.type==='Cells'?'cell0':it.type==='Lanterns'?'lantern':it.type==='Omnicells'?'omnicell':it.type==='Weapons'?'weapon':'head'),node('span','builds-result-name',it.name),node('span','builds-result-id',it.id),node('span','builds-result-own',mark(it)+' '+status(it)));
    b.onclick=onClick;return b;
  }
  function showEditor() {
    el('build-name').value=editor.name;el('build-notes').value=editor.notes;
    const host=el('build-slots');host.replaceChildren();const locks=currentLocks();
    for(const k of slotTypes){
      const it=itemFor(editor.slots[k]);const wrap=node('div','builds-slot-wrap'+(locks.has(k)?' locked':''));
      const b=node('button','builds-slot'+(it?' filled':''));b.type='button';
      const thumb=node('span','builds-slot-icon');thumb.append(itemIcon(it,k));b.append(thumb);
      const block=node('span','builds-slot-meta');block.append(node('strong','',tr(fieldNames[k])),node('span','',it?it.name:tr('Choose')));b.append(block,node('span','builds-slot-status',it?mark(it):'+'));
      b.onclick=()=>openSelector(k);
      const lock=node('button','builds-lock'+(locks.has(k)?' active':''));lock.type='button';lock.title=tr(locks.has(k)?'Unlock':'Lock');lock.setAttribute('aria-label',lock.title+' '+tr(fieldNames[k]));lock.onclick=()=>toggleLock(k);
      wrap.append(b,lock);host.append(wrap);
    }
    const cellsHost=el('build-cell-slots');cellsHost.replaceChildren();
    for(let i=0;i<6;i++){const k='cell'+i,it=itemFor(editor.cells[i]),wrap=node('div','builds-cell-wrap'+(locks.has(k)?' locked':''));const b=node('button','builds-cell-slot'+(it?' filled':''));b.type='button';b.append(itemIcon(it,k),node('span','',it?it.name:tr('Choose')),node('span','',it?mark(it):'+'));b.onclick=()=>openSelector(k);
      const lock=node('button','builds-lock'+(locks.has(k)?' active':''));lock.type='button';lock.title=tr(locks.has(k)?'Unlock':'Lock');lock.setAttribute('aria-label',lock.title+' '+tr('Cells')+' '+String(i+1));lock.onclick=()=>toggleLock(k);wrap.append(b,lock);cellsHost.append(wrap);
    }
    showSummary();
    const chosen=slotTypes.map(x=>editor.slots[x]).concat(editor.cells).filter(Boolean),have=chosen.filter(x=>getOwned(itemFor(x))===true).length,missing=chosen.filter(x=>getOwned(itemFor(x))===false).length;
    print('build-owned-report',tr('Read-only inventory')+'  |  '+tr('Owned')+': '+have+'  |  '+tr('Missing')+': '+missing+'  |  '+tr('Unknown')+': '+(chosen.length-have-missing));
  }
  function openSelector(slot) {snapshot();filterSlot=slot;el('build-selector').hidden=false;print('build-selector-title',slot.startsWith('cell')?tr('Cells'):tr(fieldNames[slot]));el('build-search').value='';drawSelector();el('build-selector').scrollIntoView({block:'nearest'});}
  function drawSelector() {
    const q=el('build-search').value.trim().toLowerCase();const k=filterSlot,arr=k.startsWith('cell')?cells:catalog.filter(it=>matchSlot(it,k));const list=el('build-options');list.replaceChildren();
    const reset=node('button','builds-result',tr('Remove'));reset.onclick=()=>{assign('');};list.append(reset);
    const filtered=arr.filter(it=>!q||(it.name+' '+it.id).toLowerCase().includes(q)).slice(0,100);
    for(const it of filtered)list.append(elementRow(it,()=>assign(it.id)));
    if(!filtered.length)list.append(node('p','small',tr('No matching items.')));
  }
  function assign(id) {if(filterSlot.startsWith('cell'))editor.cells[Number(filterSlot.slice(4))]=id;else editor.slots[filterSlot]=id;el('build-selector').hidden=true;showEditor();}
  function renderCatalog() {
    const q=el('build-catalog-search').value.trim().toLowerCase(),type=el('build-catalog-type').value,own=el('build-catalog-owned').value;
    const arr=catalog.concat(cells).filter(it=>(type==='All types'||it.type===type)&&(!q||(it.name+' '+it.id).toLowerCase().includes(q))&&(own==='All equipment'||(own==='Owned only'?getOwned(it)===true:getOwned(it)===false)));
    const box=el('build-catalog-list');box.replaceChildren();for(const it of arr.slice(0,180))box.append(elementRow(it,()=>{tab='editor';showTab();openSelector(it.type==='Cells'?'cell0':it.type==='Weapons'?'weapon':it.type==='Lanterns'?'lantern':it.type==='Omnicells'?'omnicell':it.type==='Weapon parts'?'part':'head');}));
    if(!arr.length)box.append(node('p','small',tr('No matching items.')));
  }
  function showTab() {
    for(const k of ['editor','catalog','community']){el('build-panel-'+k).hidden=k!==tab;const b=el('build-tab-'+k);b.classList.toggle('is-active',k===tab);b.setAttribute('aria-selected',String(k===tab));}
    if(tab==='catalog')renderCatalog();if(tab==='community')showSaved();if(tab==='editor')showEditor();
  }
  function updateCharacters(data) {
    characters=(data && data.save && data.save.characters)||[];const sel=el('build-character'),prev=sel.value;sel.replaceChildren();sel.add(new Option(tr('None'),'none'));
    for(const x of characters)sel.add(new Option(x.name||x.id,x.id));sel.value=characters.some(x=>x.id===prev)?prev:(characters[0]&&characters[0].id)||'none';refreshOwned();
  }
  function refreshOwned() {const ch=characters.find(x=>x.id===el('build-character').value);owned=ch?{items:ch.items||{},gearSet:new Set((ch.gear||[]).map(x=>x.id))}:null;showEditor();if(tab==='catalog')renderCatalog();}
  async function readCatalog() {
    note('');owned=null;characters=[];const ver=version();let r=null;
    try {r=await window.launcher.buildsCatalog(ver);}catch{}
    if(!r || !r.ok){catalog=[];cells=[];note(tr('Catalog unavailable.'));}else{catalog=r.items||[];cells=r.cells||[];}
    try {const ch=await window.launcher.items(ver);updateCharacters(ch);if(!ch || !ch.save || !ch.save.ok)note(tr('Select a saved character to compare items.'));}
    catch {updateCharacters(null);note(tr('Could not read the inventory.'));}
    showTab();
  }
  function snapshot() {editor.name=el('build-name').value.slice(0,90);editor.notes=el('build-notes').value.slice(0,280);return JSON.parse(JSON.stringify(editor));}
  async function save() {
    const d=snapshot();d.id=d.id||('build-'+Date.now()+'-'+Math.random().toString(16).slice(2));d.version=version();
    const r=await window.launcher.buildsLocal('put',d);if(r&&r.ok){saved=r.builds;editor=d;note(tr('Build saved locally.'));}else note(r&&r.error||'Error');
  }
  async function loadLocal() {const r=await window.launcher.buildsLocal('list');saved=r&&r.builds||[];}
  function showSaved() {
    const box=el('build-community-list');box.replaceChildren();const sorted=[...saved].sort((a,b)=>el('build-sort').value==='Most liked'?(b.likes||0)-(a.likes||0):(b.createdAt||0)-(a.createdAt||0));
    if(!sorted.length)box.append(node('p','small',tr('No builds saved yet.')));
    for(const d of sorted){const row=node('div','builds-saved-card');const info=node('div','builds-saved-details');info.append(node('strong','',d.name||tr('Saved build')),node('span','',d.version+'  |  '+Object.values(d.slots||{}).filter(Boolean).length+' '+tr('Gear')+'  |  '+tr('Local like')+': '+(d.likes||0)));row.append(info);
      const actions=node('div','builds-saved-actions');
      const open=node('button','ghost',tr('Open in builder'));open.onclick=async()=>{el('build-version').value=d.version;await readCatalog();editor={...blank(d.version),...JSON.parse(JSON.stringify(d)),cells:(d.cells||[]).concat(['','','','','','']).slice(0,6),locks:Array.isArray(d.locks)?d.locks:[]};tab='editor';showTab();note(tr('Build opened.'));};
      const like=node('button','ghost',tr('Local like')+' '+(d.likes?'\u2665':'\u2661'));like.onclick=async()=>{const r=await window.launcher.buildsLocal('like',d.id);if(r&&r.ok){saved=r.builds;showSaved();}};
      const del=node('button','ghost',tr('Delete'));del.onclick=async()=>{if(!window.confirm(tr('Delete this build?')))return;const r=await window.launcher.buildsLocal('delete',d.id);if(r&&r.ok){saved=r.builds;showSaved();note(tr('Build deleted.'));}};
      actions.append(open,like,del);row.append(actions);box.append(row);
    }
  }
  function share(data) {return JSON.stringify({format:'dauntless-forever-build-v1',build:{name:data.name,notes:data.notes,version:data.version,slots:data.slots,cells:data.cells,locks:data.locks||[]}});}
  function copy(value) {const fallback=()=>{const ta=el('build-import-text');ta.hidden=false;ta.value=value;ta.select();note(tr('Could not copy. Select and copy the share code below.'));};if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(()=>note(tr('Share code copied.'))).catch(fallback);else fallback();}
  async function importCode() {
    const ta=el('build-import-text');ta.hidden=false;if(!ta.value.trim()){ta.focus();return;}
    let parsed=null;try{parsed=JSON.parse(ta.value);if(parsed.format!=='dauntless-forever-build-v1')throw 0;parsed=parsed.build;if(!parsed||!['1.14.7','1.6.2'].includes(parsed.version)||typeof parsed.slots!=='object')throw 0;}catch {note(tr('Invalid share code.'));return;}
    const d={...blank(parsed.version),name:String(parsed.name||'Imported build').slice(0,90),notes:String(parsed.notes||'').slice(0,280)};for(const k of slotTypes){const v=parsed.slots[k];if(typeof v==='string'&&/^[A-Za-z0-9_-]{3,100}$/.test(v))d.slots[k]=v;}
    if(Array.isArray(parsed.cells))for(let i=0;i<6;i++){const v=parsed.cells[i];if(typeof v==='string'&&/^[A-Za-z0-9_-]{3,100}$/.test(v))d.cells[i]=v;}
    d.locks=Array.isArray(parsed.locks)?parsed.locks.filter(x=>slotTypes.includes(x)||/^cell[0-5]$/.test(x)):[];
    d.id='build-'+Date.now()+'-'+Math.random().toString(16).slice(2);const r=await window.launcher.buildsLocal('put',d);if(r&&r.ok){saved=r.builds;ta.value='';ta.hidden=true;note(tr('Imported to your local collection.'));showSaved();}
  }
  function wire() {
    el('build-version').onchange=()=>{editor=blank(version());print('build-recommend-explain','');readCatalog();};
    el('build-character').onchange=refreshOwned;el('build-refresh').onclick=readCatalog;
    for(const b of document.querySelectorAll('.builds-tab'))b.onclick=()=>{if(tab==='editor')snapshot();tab=b.dataset.buildTab;el('build-selector').hidden=true;showTab();};
    el('build-search').oninput=drawSelector;el('build-selector-close').onclick=()=>{el('build-selector').hidden=true;};
    for(const id of ['build-catalog-search','build-catalog-type','build-catalog-owned']){el(id).addEventListener(id==='build-catalog-search'?'input':'change',renderCatalog);}
    el('build-recommend').onclick=recommendBuild;
    el('build-save').onclick=save;el('build-duplicate').onclick=()=>{snapshot();editor.id='';editor.name=(editor.name||'My build')+' (copy)';showEditor();};
    el('build-clear').onclick=()=>{editor=blank(version());print('build-recommend-explain','');showEditor();};el('build-share').onclick=()=>copy(share(snapshot()));
    el('build-import').onclick=importCode;el('build-local-export').onclick=()=>copy(JSON.stringify(saved.map(d=>JSON.parse(share(d))),null,2));
    el('build-sort').onchange=showSaved;
  }
  async function init() {if(loaded)return;loaded=true;wire();setLabels();await loadLocal();await readCatalog();}
  document.addEventListener('page:shown',e=>{if(e.detail==='builds')init();});
  window.addEventListener('df-lang',()=>{if(loaded){setLabels();showTab();}});
})();
