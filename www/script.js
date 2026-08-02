const EXT = ['.mp3','.flac','.wav','.ogg','.m4a','.aac','.wma','.opus','.aiff'];
const DB_NAME = 'music-player-db';
const STORE = 'handles';
const LS_KEY = 'music-player-state-v1';

let roots = [];
let queue = [], qi = -1, playing = false;
let onlyFav = false;
const fav = new Set();
const closed = new Set();
const audio = document.getElementById('audio');
let modalCb = null;
let dirHandles = {};

const HEART_SVG = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path class="back" d="M12 21s-6.7-4.35-9.33-7.6C.8 11.2.5 8.5 2.2 6.6 3.7 4.9 6.2 4.6 8 5.8c1.1.7 1.8 1.7 2 2.2.2-.5.9-1.5 2-2.2 1.8-1.2 4.3-.9 5.8.8 1.7 1.9 1.4 4.6-.47 6.8C18.7 16.65 12 21 12 21z"/><path class="front" d="M12 21s-6.7-4.35-9.33-7.6C.8 11.2.5 8.5 2.2 6.6 3.7 4.9 6.2 4.6 8 5.8c1.1.7 1.8 1.7 2 2.2.2-.5.9-1.5 2-2.2 1.8-1.2 4.3-.9 5.8.8 1.7 1.9 1.4 4.6-.47 6.8C18.7 16.65 12 21 12 21z"/></svg>';

function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
function isAudio(n){ n=n.toLowerCase(); return EXT.some(function(e){ return n.endsWith(e); }); }
function tid(node, path){ if(!node._fid) node._fid = uid(); return 'fid:' + node._fid; }
function nkey(node, path){ return path + '/' + node.name + (node.id||''); }
function toast(m){
  var el=document.getElementById('toast'); el.textContent=m; el.classList.add('show');
  clearTimeout(toast.t); toast.t=setTimeout(function(){ el.classList.remove('show'); }, 2200);
}
function collect(node){
  if(node.type==='track') return [node];
  var o=[]; (node.children||[]).forEach(function(c){ o=o.concat(collect(c)); }); return o;
}
function count(node){ return collect(node).length; }

function assignFids(node){
  if(node.type==='track' && !node._fid) node._fid = uid();
  (node.children||[]).forEach(assignFids);
}

function allTrackIds(node, path){
  if(node.type==='track') return [tid(node, path)];
  var k=nkey(node,path), ids=[];
  (node.children||[]).forEach(function(c){ ids=ids.concat(allTrackIds(c,k)); });
  return ids;
}

function favState(node, path){
  var ids = allTrackIds(node, path);
  if(!ids.length) return 'empty';
  var n = ids.filter(function(id){ return fav.has(id); }).length;
  if(n===0) return 'empty';
  if(n===ids.length) return 'full';
  return 'half';
}

function heartEl(state){ return '<span class="h '+state+'">'+HEART_SVG+'</span>'; }

function setFavAll(node, path, on){
  allTrackIds(node, path).forEach(function(id){
    if(on) fav.add(id); else fav.delete(id);
  });
  saveState();
}

function toggleFav(node, path){
  var st = favState(node, path);
  setFavAll(node, path, st !== 'full');
  render();
}

function filterTree(node, path){
  if(node.type==='track') return fav.has(tid(node,path)) ? node : null;
  var k=nkey(node,path);
  var kids=(node.children||[]).map(function(c){ return filterTree(c,k); }).filter(Boolean);
  if(!kids.length) return null;
  return Object.assign({}, node, {children: kids});
}

function closeDeep(node, path, minD, d){
  d=d||0; if(node.type==='track') return;
  var k=nkey(node,path); if(d>=minD) closed.add(k);
  (node.children||[]).forEach(function(c){ closeDeep(c,k,minD,d+1); });
}

/* PERSISTENCE */
function openDB(){
  return new Promise(function(resolve, reject){
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function(){
      var db = req.result;
      if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error); };
  });
}

async function saveHandle(id, handle){
  try {
    var db = await openDB();
    await new Promise(function(res, rej){
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, id);
      tx.oncomplete = res; tx.onerror = function(){ rej(tx.error); };
    });
  } catch(e){}
}

async function loadHandle(id){
  try {
    var db = await openDB();
    return await new Promise(function(res, rej){
      var tx = db.transaction(STORE, 'readonly');
      var r = tx.objectStore(STORE).get(id);
      r.onsuccess = function(){ res(r.result || null); };
      r.onerror = function(){ rej(r.error); };
    });
  } catch(e){ return null; }
}

async function deleteHandle(id){
  try {
    var db = await openDB();
    await new Promise(function(res, rej){
      var tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = res; tx.onerror = function(){ rej(tx.error); };
    });
  } catch(e){}
}

function serializeNode(node){
  if(node.type==='track'){
    if(!node._fid) node._fid = uid();
    return { name: node.name, type: 'track', duration: node.duration||'—', _fid: node._fid };
  }
  return {
    name: node.name, type: 'folder', id: node.id,
    children: (node.children||[]).map(serializeNode)
  };
}

function saveState(){
  try {
    var data = {
      roots: roots.map(serializeNode),
      fav: Array.from(fav),
      closed: Array.from(closed),
      onlyFav: onlyFav,
      volume: Math.round((audio.volume||0.8)*100),
      volW: (function(){ var w=document.getElementById('vol-wrap'); if(!w) return 48; return parseFloat(getComputedStyle(w).getPropertyValue('--vol-w'))||48; })(),
      rootIds: roots.map(function(r){ return r.id; })
    };
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch(e){}
}

async function loadState(){
  var raw = localStorage.getItem(LS_KEY);
  if(!raw) return;
  try {
    var data = JSON.parse(raw);
    onlyFav = !!data.onlyFav;
    if(typeof data.volume === 'number'){
      audio.volume = data.volume/100;
      var range = document.getElementById('vol-range');
      if(range) range.value = String(data.volume);
    }
    (data.fav||[]).forEach(function(id){
      if(id && String(id).indexOf('fid:') === 0) fav.add(id);
    });
    (data.closed||[]).forEach(function(k){ closed.add(k); });

    var loaded = [];
    for(var i=0;i<(data.roots||[]).length;i++){
      var meta = data.roots[i];
      var id = meta.id || uid();
      var handle = await loadHandle(id);
      var tree = null;
      if(handle){
        dirHandles[id] = handle;
        try {
          var perm = 'granted';
          if(handle.queryPermission) perm = await handle.queryPermission({mode:'read'});
          if(perm === 'granted'){
            tree = await fromHandle(handle);
            if(tree){
              tree.id = id;
              mergeFids(tree, meta, '');
              await saveHandle(id, handle);
            }
          }
        } catch(e){}
      }
      if(!tree){
        tree = JSON.parse(JSON.stringify(meta));
        tree.id = id;
      }
      loaded.push(tree);
    }
    roots = loaded;
  } catch(e){}
}

async function ensureRootAccess(root){
  if(!root || !root.id) return false;
  var hasFiles = collect(root).some(function(t){ return !!t.file; });
  if(hasFiles) return true;

  var handle = dirHandles[root.id] || await loadHandle(root.id);
  if(!handle) return false;

  try {
    var perm = 'granted';
    if(handle.queryPermission) perm = await handle.queryPermission({mode:'read'});
    if(perm !== 'granted' && handle.requestPermission){
      perm = await handle.requestPermission({mode:'read'});
    }
    if(perm !== 'granted') return false;

    var tree = await fromHandle(handle);
    if(!tree) return false;
    var meta = serializeNode(root);
    tree.id = root.id;
    mergeFids(tree, meta, '');
    var idx = roots.findIndex(function(r){ return r.id === root.id; });
    if(idx >= 0) roots[idx] = tree;
    dirHandles[root.id] = handle;
    await saveHandle(root.id, handle);
    saveState();
    render();
    return true;
  } catch(e){ return false; }
}

function findRootOf(node){
  for(var i=0;i<roots.length;i++){
    if(roots[i] === node || (node && node.id && roots[i].id === node.id) || containsNode(roots[i], node)) return roots[i];
  }
  return roots[0] || null;
}
function containsNode(parent, target){
  if(parent === target) return true;
  if(!parent || !target) return false;
  if(parent.type==='track' && target.type==='track' && parent._fid && parent._fid === target._fid) return true;
  var ch = parent.children || [];
  for(var i=0;i<ch.length;i++){ if(containsNode(ch[i], target)) return true; }
  return false;
}
function resolveLiveNode(node, root){
  if(!node || !root) return node;
  if(node.type==='track' && node._fid){
    var found = null;
    function walk(n){
      if(found) return;
      if(n.type==='track' && n._fid === node._fid) found = n;
      (n.children||[]).forEach(walk);
    }
    walk(root);
    return found || node;
  }
  return node;
}

function mergeFids(live, meta, path){
  if(!meta) return;
  if(live.type==='track'){
    if(meta.type==='track' && meta._fid) live._fid = meta._fid;
    else if(!live._fid) live._fid = uid();
    return;
  }
  if(live.type==='folder' && meta.children){
    (live.children||[]).forEach(function(c){
      var m = (meta.children||[]).find(function(x){ return x.name===c.name && x.type===c.type; });
      mergeFids(c, m, path+'/'+live.name);
    });
  }
}

async function fromHandle(h){
  var node={name:h.name,type:'folder',children:[]};
  for await (var e of h.values()){
    if(e.kind==='directory'){ var c=await fromHandle(e); if(c) node.children.push(c); }
    else if(e.kind==='file' && isAudio(e.name)){
      var f=await e.getFile();
      node.children.push({name:e.name,type:'track',file:f,url:null,duration:'—',_fid:uid()});
    }
  }
  node.children=node.children.filter(function(c){ return c.type==='track'||(c.children&&c.children.length); });
  return node.children.length?node:null;
}

function fromInput(){
  return new Promise(function(res){
    var inp=document.createElement('input');
    inp.type='file'; inp.webkitdirectory=true; inp.multiple=true;
    inp.onchange=function(){
      if(!inp.files||!inp.files.length){ res(null); return; }
      res(fromFileList(inp.files));
    };
    inp.click();
  });
}

function fromFileList(files){
  var rootName=files[0].webkitRelativePath.split('/')[0]||'Pasta';
  var root={name:rootName,type:'folder',children:[]};
  function ensure(parts){
    var cur=root;
    for(var i=0;i<parts.length;i++){
      var p=parts[i];
      var n=(cur.children||[]).find(function(c){ return c.type==='folder'&&c.name===p; });
      if(!n){ n={name:p,type:'folder',children:[]}; cur.children=cur.children||[]; cur.children.push(n); }
      cur=n;
    }
    return cur;
  }
  for(var i=0;i<files.length;i++){
    var f=files[i]; if(!isAudio(f.name)) continue;
    var parts=f.webkitRelativePath.split('/');
    var folders=parts.slice(1,-1);
    var parent=folders.length?ensure(folders):root;
    parent.children=parent.children||[];
    parent.children.push({name:f.name,type:'track',file:f,url:null,duration:'—',_fid:uid()});
  }
  function prune(n){
    if(n.type==='track') return n;
    n.children=(n.children||[]).map(prune).filter(Boolean);
    return n.children.length?n:null;
  }
  return prune(root);
}

async function addPlaylist(){
  var tree=null, handle=null;
  if(window.showDirectoryPicker){
    try{
      handle = await window.showDirectoryPicker();
      tree = await fromHandle(handle);
    } catch(e){ return; }
  } else {
    tree = await fromInput();
  }
  if(!tree){ toast('Nenhum áudio encontrado'); return; }
  assignFids(tree);
  var root=Object.assign({id:uid()}, tree);
  closeDeep(root,'',1);
  roots.push(root);
  if(handle){
    dirHandles[root.id]=handle;
    await saveHandle(root.id, handle);
  }
  saveState();
  toast('"'+root.name+'" · '+count(root)+' faixa(s)');
  render();
}

async function ensureUrl(t){
  if(t.url) return t.url;
  if(t.file){ t.url=URL.createObjectURL(t.file); return t.url; }
  return null;
}

// Otimização para troca contínua em Background (Mobile)
async function prepareNextTrack() {
  if (qi < queue.length - 1) {
    const nextTrack = queue[qi + 1];
    if (nextTrack) await ensureUrl(nextTrack);
  }
}

async function playNow(){
  if(qi<0||!queue[qi]) return;
  
  ensureAudioGraph();
  if(audioCtx && audioCtx.state==='suspended'){
    try { await audioCtx.resume(); } catch(e){}
  }
  
  var track = queue[qi];
  var url = await ensureUrl(track);
  if(!url){ toast('Sem acesso ao arquivo'); return; }
  
  try {
    audio.src = url;
    prepareNextTrack(); // Pré-aloca a próxima URL
    await audio.play();
    playing = true;
  } catch(e){
    try {
      audio.play();
      playing = true;
    } catch(err){
      playing = false;
    }
  }
  renderPlayer();
  renderContent();
  updateMediaSession();
}

async function playFolder(n){
  var root = findRootOf(n);
  if(root){
    await ensureRootAccess(root);
    root = roots.find(function(r){ return r.id === root.id; }) || root;
    n = resolveLiveNode(n, root);
  }
  var t = collect(n).filter(function(x){ return !!x.file; });
  if(!t.length){ toast('Sem acesso aos arquivos'); return; }
  queue = t; qi = 0; playNow();
}

async function playTrack(n){
  var root = findRootOf(n);
  if(root){
    await ensureRootAccess(root);
    root = roots.find(function(r){ return r.id === root.id; }) || root;
    n = resolveLiveNode(n, root);
  }
  if(!n.file){ toast('Sem acesso a este arquivo'); return; }
  queue = [n]; qi = 0; playNow();
}

function next(){
  if(qi < queue.length-1){
    qi++; playNow();
  } else {
    playing=false; try { audio.pause(); } catch(e){}
    renderPlayer(); updateMediaSession();
  }
}

function prev(){
  if(qi>0){ qi--; playNow(); }
}

function toggle(){
  if(!queue.length) return;
  if(playing){ audio.pause(); playing=false; }
  else {
    if(!audio.src&&queue[qi]) playNow();
    else audio.play().then(function(){ playing=true; renderPlayer(); }).catch(function(){});
  }
  renderPlayer();
}

function stop(){
  audio.pause(); audio.removeAttribute('src'); playing=false; queue=[]; qi=-1;
  document.getElementById('progress-bar').style.width='0%'; render();
}

audio.setAttribute('playsinline', '');
audio.setAttribute('webkit-playsinline', '');
audio.preload = 'auto';

// Listener para transição contínua no celular
audio.addEventListener('ended', function(){
  if(qi < queue.length - 1){
    qi++;
    playNow();
  } else {
    playing = false;
    renderPlayer();
    updateMediaSession();
  }
});

audio.addEventListener('timeupdate', function(){
  if(audio.duration) document.getElementById('progress-bar').style.width=((audio.currentTime/audio.duration)*100)+'%';
  updateMediaSessionPosition();
});
audio.addEventListener('play', function(){
  playing=true; renderPlayer();
  if(audioCtx && audioCtx.state==='suspended') audioCtx.resume();
  updateMediaSession();
});
audio.addEventListener('pause', function(){ playing=false; renderPlayer(); updateMediaSession(); });

function updateMediaSession(){
  if(!('mediaSession' in navigator)) return;
  try {
    var t = queue[qi];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t ? t.name : 'Music Player',
      artist: 'Music Player',
      album: t && t.name ? t.name : ''
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  } catch(e){}
}
function updateMediaSessionPosition(){
  if(!('mediaSession' in navigator) || !audio.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: audio.currentTime
    });
  } catch(e){}
}

if('mediaSession' in navigator){
  try {
    navigator.mediaSession.setActionHandler('play', function(){ if(!playing) toggle(); });
    navigator.mediaSession.setActionHandler('pause', function(){ if(playing) toggle(); });
    navigator.mediaSession.setActionHandler('previoustrack', function(){ prev(); });
    navigator.mediaSession.setActionHandler('nexttrack', function(){ next(); });
    navigator.mediaSession.setActionHandler('stop', function(){ stop(); });
  } catch(e){}
}

document.getElementById('progress-wrap').onclick=function(e){
  if(!audio.duration) return;
  var r=e.currentTarget.getBoundingClientRect();
  audio.currentTime=((e.clientX-r.left)/r.width)*audio.duration;
};

function openMenu(e, node, path, parentArr){
  e.stopPropagation();
  var st=favState(node, path);
  var pop=document.getElementById('menu-pop');
  pop.innerHTML='';
  var b1=document.createElement('button');
  b1.innerHTML=heartEl(st==='full'?'full':(st==='half'?'half':'empty'))+' <span>'+(st==='full'?'Remover dos favoritos':'Favoritar')+'</span>';
  b1.onclick=function(){ hideMenu(); toggleFav(node, path); };
  var b2=document.createElement('button');
  b2.className='red';
  b2.textContent='✕  Remover';
  b2.onclick=function(){ hideMenu(); confirmRm(node, parentArr, path); };
  pop.appendChild(b1); pop.appendChild(b2);
  pop.classList.add('open');
  var x=e.clientX, y=e.clientY;
  pop.style.left='0px'; pop.style.top='0px';
  var w=pop.offsetWidth, h=pop.offsetHeight;
  pop.style.left=Math.max(8, Math.min(x, window.innerWidth-w-8))+'px';
  pop.style.top=Math.max(8, Math.min(y, window.innerHeight-h-8))+'px';
}
function hideMenu(){ document.getElementById('menu-pop').classList.remove('open'); }
document.addEventListener('click', function(){ hideMenu(); });

function confirmRm(node, parentArr, path){
  document.getElementById('modal-title').textContent='Remover?';
  document.getElementById('modal-msg').textContent='Remover "'+node.name+'"'+(node.type==='folder'?' e todo o conteúdo?':'?');
  modalCb=function(){
    setFavAll(node, path, false);
    if(parentArr){
      var i=parentArr.indexOf(node);
      if(i>=0) parentArr.splice(i,1);
    } else {
      if(node.id){ deleteHandle(node.id); delete dirHandles[node.id]; }
      roots=roots.filter(function(r){ return r!==node; });
    }
    saveState(); toast('Removido'); render();
  };
  document.getElementById('modal').classList.add('open');
}
document.getElementById('modal-cancel').onclick=function(){ document.getElementById('modal').classList.remove('open'); modalCb=null; };
document.getElementById('modal-ok').onclick=function(){
  document.getElementById('modal').classList.remove('open');
  if(modalCb) modalCb(); modalCb=null;
};

function globalState(){
  if(!roots.length) return 'empty';
  var total=0, favN=0;
  function walk(node, path){
    if(node.type==='track'){
      total++; if(fav.has(tid(node, path))) favN++; return;
    }
    var k=nkey(node, path);
    (node.children||[]).forEach(function(c){ walk(c, k); });
  }
  roots.forEach(function(r){ walk(r, ''); });
  if(total===0 || favN===0) return 'empty';
  if(favN>=total) return 'full';
  return 'half';
}

function updateFilterBtn(){
  var btn=document.getElementById('fav-filter');
  if(!btn) return;
  btn.classList.toggle('on', onlyFav);
  var st = globalState();
  btn.innerHTML = heartEl(st);
}

document.getElementById('fav-filter').onclick=function(e){
  e.stopPropagation(); onlyFav = !onlyFav; saveState(); render();
};

function render(){
  var tb=document.getElementById('toolbar');
  tb.innerHTML='';
  var b=document.createElement('button');
  b.className='primary'; b.textContent='+ Criar playlist'; b.onclick=addPlaylist;
  tb.appendChild(b);

  var content=document.getElementById('content');
  content.innerHTML='';
  if(!roots.length){
    content.innerHTML='<div class="empty"><div class="big">📂</div><p>Toque em <strong>+ Criar playlist</strong> e escolha uma pasta.</p></div>';
    updateFilterBtn(); renderPlayer(); return;
  }

  var list=roots;
  if(onlyFav){
    list=roots.map(function(r){ return filterTree(r,''); }).filter(Boolean);
    if(!list.length){
      content.innerHTML='<div class="empty"><div class="big">🤍</div><p>Nenhum favorito.</p></div>';
      updateFilterBtn(); renderPlayer(); return;
    }
  }

  list.forEach(function(node){
    var orig=roots.find(function(r){ return r.id===node.id; }) || node;
    content.appendChild(drawNode(node, '', null, orig));
  });
  updateFilterBtn(); renderPlayer();
}

function renderContent(){ render(); }

function drawNode(node, path, parentArr, orig){
  orig=orig||node;
  var wrap=document.createElement('div');
  var key=nkey(orig, path);
  var kids=onlyFav ? (node.children||[]) : (orig.children||[]);
  var hasKids=kids.length>0;
  var isClosed=closed.has(key);
  var st=favState(orig, path);

  var row=document.createElement('div');
  row.className='tree-item '+(node.type||'folder');
  if(node.type==='track' && queue[qi]===orig) row.classList.add('playing');

  var twist=document.createElement('span');
  twist.className='twist';
  twist.textContent=hasKids?(isClosed?'▶':'▼'):'';
  row.appendChild(twist);

  var icon=document.createElement('span');
  icon.className='icon';
  icon.textContent=node.type==='track'?'🎵':'📁';
  row.appendChild(icon);

  var name=document.createElement('span');
  name.className='name';
  name.textContent=node.name;
  row.appendChild(name);

  if(node.type!=='track'){
    var meta=document.createElement('span');
    meta.className='meta';
    meta.textContent=count(onlyFav?node:orig);
    row.appendChild(meta);
  }

  var hbtn=document.createElement('span');
  hbtn.className='row-heart';
  hbtn.innerHTML=heartEl(st);
  hbtn.onclick=function(e){ e.stopPropagation(); toggleFav(orig, path); };
  row.appendChild(hbtn);

  var mbtn=document.createElement('span');
  mbtn.className='row-menu';
  mbtn.textContent='⋮';
  mbtn.onclick=function(e){
    e.stopPropagation();
    var isRoot=roots.indexOf(orig)>=0;
    openMenu(e, orig, path, isRoot?null:parentArr);
  };
  row.appendChild(mbtn);

  if(node.type==='track'){
    icon.onclick=name.onclick=function(e){ e.stopPropagation(); playTrack(orig); };
  } else {
    function nav(e){
      e.stopPropagation();
      if(!hasKids) return;
      if(closed.has(key)) closed.delete(key); else closed.add(key);
      saveState(); render();
    }
    icon.onclick=twist.onclick=nav;
    name.onclick=function(e){ e.stopPropagation(); playFolder(orig); };
  }

  wrap.appendChild(row);

  if(hasKids){
    var ch=document.createElement('div');
    ch.className='children'+(isClosed?' hide':'');
    kids.forEach(function(c){
      var oc=(orig.children||[]).find(function(x){ return x.name===c.name && x.type===c.type; })||c;
      ch.appendChild(drawNode(c, key, orig.children, oc));
    });
    wrap.appendChild(ch);
  }
  return wrap;
}

function renderPlayer(){
  var now=document.getElementById('now-playing');
  var src=document.getElementById('now-source');
  var bp=document.getElementById('btn-play');
  if(qi>=0&&queue[qi]){
    now.textContent=queue[qi].name;
    src.textContent=playing?'▶ Tocando':'❚❚ Pausado';
  } else { now.textContent='Nenhuma faixa'; src.textContent='—'; }
  bp.textContent=playing?'❚❚':'▶';
  document.getElementById('btn-prev').disabled=qi<=0;
  document.getElementById('btn-next').disabled=qi>=queue.length-1||!queue.length;
}

document.getElementById('btn-play').onclick=toggle;
document.getElementById('btn-next').onclick=next;
document.getElementById('btn-prev').onclick=prev;

/* Volume */
(function(){
  var wrap = document.getElementById('vol-wrap');
  var box = document.getElementById('vol-box');
  var ball = document.getElementById('vol-ball');
  var range = document.getElementById('vol-range');
  var resize = document.getElementById('vol-resize');
  if(!wrap||!box||!ball||!range) return;
  var open = false;
  if(typeof audio.volume !== 'number') audio.volume = 0.8;

  try {
    var raw = localStorage.getItem(LS_KEY);
    if(raw){
      var d = JSON.parse(raw);
      if(d.volW) wrap.style.setProperty('--vol-w', d.volW + 'px');
      if(typeof d.volume === 'number'){ range.value = d.volume; audio.volume = d.volume/100; }
    }
  } catch(e){}

  range.value = Math.round((audio.volume||0.8)*100);

  function syncIcon(){
    var v = +range.value;
    if(v === 0) ball.textContent = '🔇';
    else if(v < 40) ball.textContent = '🔈';
    else if(v < 75) ball.textContent = '🔉';
    else ball.textContent = '🔊';
  }

  ball.addEventListener('click', function(e){
    e.stopPropagation(); open = !open; box.classList.toggle('open', open);
  });

  range.addEventListener('input', function(){
    audio.volume = (+range.value) / 100;
    syncIcon(); saveState();
  });

  document.addEventListener('click', function(e){
    if(!open) return;
    if(e.target.closest && e.target.closest('#vol-wrap')) return;
    open = false; box.classList.remove('open');
  });
  syncIcon();
})();

/* Web Audio API / Espacial */
var audioCtx = null, mediaSource = null, panNode = null, wetGain = null, dryGain = null, convolver = null;
var spatialMode = 'natural', spatialSpeed = 40, spatialDepth = 85, spatialReverb = 25, panRAF = null, panPhase = 0;

function ensureAudioGraph(){
  if(audioCtx) return;
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    audioCtx = new AC();
    mediaSource = audioCtx.createMediaElementSource(audio);

    dryGain = audioCtx.createGain();
    wetGain = audioCtx.createGain();
    panNode = audioCtx.createStereoPanner();
    convolver = audioCtx.createConvolver();
    convolver.buffer = makeImpulse(audioCtx, 2.2, 2.0);

    mediaSource.connect(dryGain);
    dryGain.connect(audioCtx.destination);

    mediaSource.connect(panNode);
    panNode.connect(wetGain);
    panNode.connect(audioCtx.destination);

    wetGain.connect(convolver);
    convolver.connect(audioCtx.destination);

    applySpatialSettings();
  } catch(e) {}
}

function makeImpulse(ctx, seconds, decay){
  var rate = ctx.sampleRate, len = rate * seconds, buf = ctx.createBuffer(2, len, rate);
  for(var c=0;c<2;c++){
    var data = buf.getChannelData(c);
    for(var i=0;i<len;i++){ data[i] = (Math.random()*2-1) * Math.pow(1 - i/len, decay); }
  }
  return buf;
}

function baseSpeed(){
  var map = { natural:0, '3d':0.35, '8d':0.7, '16d':1.15, '24d':1.7 };
  return map[spatialMode] || 0;
}

function applySpatialSettings(){
  if(!audioCtx) return;
  var isNat = spatialMode === 'natural', depth = spatialDepth / 100, rev = spatialReverb / 100;
  if(isNat){
    dryGain.gain.value = 1; wetGain.gain.value = 0;
    if(panNode) panNode.pan.value = 0;
    stopPanAnim();
  } else {
    dryGain.gain.value = 0.35; wetGain.gain.value = 0.15 + rev * 0.55;
    startPanAnim(depth);
  }
}

function startPanAnim(depth){
  stopPanAnim();
  var last = performance.now();
  function tick(now){
    var dt = (now - last) / 1000; last = now;
    var spd = baseSpeed() * (0.25 + spatialSpeed/100 * 1.75);
    panPhase += dt * spd * Math.PI * 2;
    var pan = Math.sin(panPhase) * depth;
    if(panNode) panNode.pan.value = Math.max(-1, Math.min(1, pan));
    panRAF = requestAnimationFrame(tick);
  }
  panRAF = requestAnimationFrame(tick);
}
function stopPanAnim(){
  if(panRAF){ cancelAnimationFrame(panRAF); panRAF = null; }
  if(panNode) panNode.pan.value = 0;
}

audio.addEventListener('play', function(){
  ensureAudioGraph();
  if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  applySpatialSettings();
});

/* Configurações */
(function(){
  var MIN=28, MAX=72, STEP=4;
  var wrap = document.getElementById('vol-wrap');
  var btn = document.getElementById('btn-settings');
  var modal = document.getElementById('settings-modal');
  var label = document.getElementById('vol-w-label');
  if(!wrap||!btn||!modal) return;

  function getW(){ return parseFloat(getComputedStyle(wrap).getPropertyValue('--vol-w')) || 48; }
  function setW(w){
    w = Math.min(MAX, Math.max(MIN, Math.round(w)));
    wrap.style.setProperty('--vol-w', w + 'px');
    if(label) label.textContent = w + ' px';
    saveState();
  }

  btn.addEventListener('click', function(e){
    e.stopPropagation(); modal.classList.add('open');
  });
  document.getElementById('settings-close').onclick = function(){ modal.classList.remove('open'); };

  document.querySelectorAll('.spatial-btn').forEach(function(b){
    b.addEventListener('click', function(){
      spatialMode = b.getAttribute('data-mode');
      ensureAudioGraph();
      if(audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      applySpatialSettings();
    });
  });
})();

async function boot(){
  try { if(navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch(e){}
  try { await loadState(); } catch(e){}
  render();
}

document.addEventListener('visibilitychange', function(){
  if(document.visibilityState === 'hidden') saveState();
  else if(document.visibilityState === 'visible' && audioCtx && audioCtx.state === 'suspended' && playing) {
    audioCtx.resume();
  }
});

/* Service Worker Inline para PWA */
if ('serviceWorker' in navigator) {
  const swCode = `
    self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
    self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
    self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => caches.match(e.request))));
  `;
  const blob = new Blob([swCode], { type: 'application/javascript' });
  navigator.serviceWorker.register(URL.createObjectURL(blob)).catch(function(){});
}

boot();
