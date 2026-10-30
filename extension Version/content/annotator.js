// 原型标注工具 · Chrome/Edge MV3 扩展版 v1.0
// 架构：内容脚本注入所有 frame（all_frames + match_origin_as_fallback，隔离世界，免疫页面 CSP）。
//   top frame = Master：唯一 UI（浮窗/清单/编辑弹窗/toast/只读回显条）、chrome.storage 持久化、
//   frame 注册表与消息路由（window.postMessage + token 握手，跨域 iframe 可达）。
//   子 frame = Child：本地渲染属于自己的标注（f 路径匹配本帧），本地点选/悬停/预览回滚，
//   派生数据（选择器/摘要/样式快照）在本帧算好后经 postMessage 上报 Master。
//   针脚在各帧文档内以本地坐标渲染，彻底免去跨帧坐标换算。
// 休眠策略：页面无标注且未激活时仅挂一个消息监听，零 DOM 接触。
(function(){
'use strict';
if(window.__PROTO_ANNO_EXT__)return;
window.__PROTO_ANNO_EXT__=true;

var isTop=(window===window.top);
var KEY_PREFIX='proto-anno::';
var KEY=KEY_PREFIX+location.href.split('#')[0];

/* ================= 共享数据模型（书签版 v0.6.3 逐字移植） ================= */

var annos=[],seq=0,elMap={};
var on=false,toastT,dialogOpen=false,activeCancel=null,pendingPick=null,suppressPickClick=0,suppressPickX=0,suppressPickY=0;
var WEIGHTS=[['300','细 300'],['400','常规 400'],['500','中等 500'],['600','半粗 600'],['700','加粗 700'],['800','特粗 800']];
var PROPS=[{k:'fontSize',label:'字号',css:'font-size'},{k:'fontWeight',label:'字重',css:'font-weight'},{k:'color',label:'文字色',css:'color'},{k:'backgroundColor',label:'背景色',css:'background-color'},{k:'borderRadius',label:'圆角',css:'border-radius'},{k:'width',label:'宽',css:'width'},{k:'height',label:'高',css:'height'}];

function esc(s){return String(s).replace(/[<>&]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c];});}
function markUi(el){if(el&&el.setAttribute)el.setAttribute('data-proto-anno-ui','1');return el;}
function isElementNode(x){return !!(x&&x.nodeType===1);}
function isToolUi(t){return !!(isElementNode(t)&&t.closest&&t.closest('[data-proto-anno-ui="1"]'));}
function cleanStr(s,max){return String(s==null?'':s).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max||500);}
function cleanStyleValue(k,v){if(v==null)return null;v=cleanStr(v,90);if(k==='color'||k==='backgroundColor')return /^#[0-9a-fA-F]{6}$/.test(v)?v:null;if(k==='fontWeight')return /^(normal|bold|[1-9]00)$/.test(v)?normWeight(v):'400';if(k==='fontSize'||k==='borderRadius'||k==='width'||k==='height')return /^\d{1,4}(\.\d{1,2})?px$/.test(v)?v:'0px';return v;}
function cleanStyleObj(o){if(!o||typeof o!=='object')return null;var r={};PROPS.forEach(function(p){r[p.k]=cleanStyleValue(p.k,o[p.k]);});r.text=o.text==null?null:cleanStr(o.text,1200);r.value=o.value==null?null:cleanStr(o.value,1200);return r;}
function cleanInlineVal(v){v=cleanStr(v,120);return /[;{}<>]/.test(v)?'':v;}
function cleanInlineBase(o){if(!o||typeof o!=='object')return null;var r={};PROPS.forEach(function(p){var x=o[p.k];r[p.k]={v:'',pri:''};if(x&&typeof x==='object'){r[p.k].v=cleanInlineVal(x.v);r[p.k].pri=x.pri==='important'?'important':'';}});return r;}
function cleanAnno(a,i){if(!a||typeof a!=='object')return null;var base=cleanStyleObj(a.base),now=cleanStyleObj(a.now);if(!base||!now)return null;var n=parseInt(a.n,10);if(!isFinite(n)||n<1)n=i+1;var mode=a.mode==='tweak'?'tweak':'note';var type=(a.type&&typeof a.type==='object')?{key:cleanStr(a.type.key,24),label:cleanStr(a.type.label,32),tag:cleanStr(a.type.tag,24)}:null;var fsrc=Array.isArray(a.f)?a.f:[],fout=[];for(var fi=0;fi<fsrc.length&&fi<8;fi++){var fv=parseInt(fsrc[fi],10);if(isFinite(fv)&&fv>=0)fout.push(fv);else break;}return {n:n,x:parseInt(a.x,10)||0,y:parseInt(a.y,10)||0,f:fout,sel:cleanStr(a.sel,500),ctx:cleanStr(a.ctx||'页面',80),summ:cleanStr(a.summ,160),type:type,mode:mode,text:cleanStr(a.text,1200),base:base,now:now,inlineBase:cleanInlineBase(a.inlineBase)};}
function sanitizeAnnos(v){if(!Array.isArray(v))return[];var out=[],used={};v.forEach(function(a,i){var c=cleanAnno(a,i);if(!c)return;while(used[c.n])c.n++;used[c.n]=true;out.push(c);});return out;}
function byN(n){var a=null;annos.forEach(function(x){if(x.n===n)a=x;});return a;}
function cssEsc(s){return (window.CSS&&CSS.escape)?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&');}
function selOf(el){if(!el||el.nodeType!==1)return'';if(el.id)return'#'+cssEsc(el.id);var p=[],c=el,guard=0;while(c&&c.nodeType===1&&c!==document.documentElement&&guard<30){if(c.id){p.unshift('#'+cssEsc(c.id));break;}var s=c.tagName.toLowerCase();var par=c.parentElement;if(par){var sib=Array.prototype.filter.call(par.children,function(x){return x.tagName===c.tagName;});if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(c)+1)+')';}p.unshift(s);c=par;guard++;}return p.join('>');}
function resolveEl(a){
  if(a.f&&a.f.length)return null;   // 子帧标注的元素归子帧管，top 侧永远解析不到
  var e=elMap[a.n];
  if(e&&e.isConnected)return e;
  try{return a.sel?document.querySelector(a.sel):null;}catch(err){return null;}
}
function visibleAnchor(el){var cur=el,g=0;while(cur&&cur.nodeType===1&&g<12){var r=cur.getBoundingClientRect();var cs=getComputedStyle(cur);if(r.width>0&&r.height>0&&cs.visibility!=='hidden'&&cs.display!=='none')return cur;cur=cur.parentElement;g++;}return null;}
function ctxOf(el){var b=el.closest&&el.closest('[data-board]');if(b)return b.getAttribute('data-board');var pa=el.closest&&el.closest('.panel,.kpi-card,section,header,footer');if(pa){var hh=pa.querySelector('h1,h2,h3,.panel-h,.text-xs');if(hh)return hh.textContent.trim().replace(/\s+/g,' ').slice(0,16);}return '页面';}
function summOf(el){return (el.textContent||'').trim().replace(/\s+/g,' ').slice(0,26)||('<'+el.tagName.toLowerCase()+'>');}
function crumbLabel(el){if(!el||!el.tagName)return '?';var s=el.tagName.toLowerCase();if(el.id)return s+'#'+el.id;var cn=(typeof el.className==='string')?el.className.trim().split(/\s+/).filter(function(x){return x&&x.indexOf('pa-')!==0;})[0]:'';return cn?s+'.'+cn:s;}
function chainOf(el){var chain=[];if(el){var cc=el,gd=0;while(cc&&cc.nodeType===1&&cc!==document.body&&cc!==document.documentElement&&gd<7){chain.unshift(cc);cc=cc.parentElement;gd++;}}return chain;}

function pxv(v){var n=parseFloat(v);return isNaN(n)?0:Math.round(n);}
function rgbToHex(c){var m=String(c).match(/[\d.]+/g);if(!m)return null;if(m.length>=4&&parseFloat(m[3])===0)return null;function h(n){n=Math.round(+n).toString(16);return n.length<2?'0'+n:n;}return '#'+h(m[0])+h(m[1])+h(m[2]);}
function normWeight(w){if(w==='normal')return '400';if(w==='bold')return '700';return String(w);}
function isFormValueEl(el){if(!el||el.nodeType!==1)return false;var t=el.tagName;if(t==='TEXTAREA')return true;if(t==='INPUT'){var ty=(el.type||'text').toLowerCase();return ['text','search','url','tel','email','password','number'].indexOf(ty)>=0;}return false;}
function readStyle(el){if(!el||el.nodeType!==1)return {fontSize:null,fontWeight:null,color:null,backgroundColor:null,borderRadius:null,width:null,height:null,text:null,value:null};var cs=getComputedStyle(el);return {fontSize:pxv(cs.fontSize)+'px',fontWeight:normWeight(cs.fontWeight),color:rgbToHex(cs.color)||'#000000',backgroundColor:rgbToHex(cs.backgroundColor),borderRadius:pxv(cs.borderRadius)+'px',width:pxv(cs.width)+'px',height:pxv(cs.height)+'px',text:(el.children.length===0)?(el.textContent||''):null,value:isFormValueEl(el)?String(el.value==null?'':el.value):null};}
function readInlineStyle(el){var s={};PROPS.forEach(function(p){s[p.k]=el&&el.nodeType===1?{v:el.style.getPropertyValue(p.css),pri:el.style.getPropertyPriority(p.css)}:{v:'',pri:''};});return s;}
function restoreInlineStyle(el,snap){if(!el||!snap)return;PROPS.forEach(function(p){var x=snap[p.k]||{v:'',pri:''};if(x.v)el.style.setProperty(p.css,x.v,x.pri||'');else el.style.removeProperty(p.css);});}
function restoreAnnoStyle(el,a){if(a&&a.inlineBase){restoreInlineStyle(el,a.inlineBase);return;}if(!a||!a.base||!a.now)return;PROPS.forEach(function(p){if(String(a.now[p.k])!==String(a.base[p.k])){var v=a.base[p.k];if(v==null)el.style.removeProperty(p.css);else el.style[p.k]=v;}});}
function elType(el){var t=el.tagName.toLowerCase();if(t==='img'||t==='svg'||t==='video'||t==='picture'||t==='canvas')return {key:'image',label:'图片/媒体',tag:t};if(t==='button'||el.getAttribute('role')==='button'||/(^|[\s_-])(btn|button)([\s_-]|$)/i.test(el.className||''))return {key:'button',label:'按钮',tag:t};if(t==='a')return {key:'button',label:'链接',tag:t};if(t==='input'||t==='textarea'||t==='select')return {key:'input',label:'输入控件',tag:t};if(el.children.length===0&&(el.textContent||'').trim())return {key:'text',label:'文字',tag:t};return {key:'box',label:'容器/区块',tag:t};}
function fieldsFor(type,editable,editableValue){var f={text:false,value:false,fontSize:false,fontWeight:false,color:false,backgroundColor:false,borderRadius:false,width:false,height:false};if(type==='text'){f.text=editable;f.fontSize=true;f.fontWeight=true;f.color=true;}else if(type==='button'){f.text=editable;f.fontSize=true;f.fontWeight=true;f.color=true;f.backgroundColor=true;f.borderRadius=true;}else if(type==='image'){f.borderRadius=true;f.width=true;f.height=true;}else if(type==='input'){f.value=!!editableValue;f.fontSize=true;f.color=true;f.backgroundColor=true;f.borderRadius=true;}else{f.backgroundColor=true;f.borderRadius=true;}return f;}
function changed(base,now){if(!base||!now)return false;if(now.text!=null&&String(now.text)!==String(base.text))return true;if(now.value!=null&&String(now.value)!==String(base.value))return true;return PROPS.some(function(p){return String(now[p.k])!==String(base[p.k]);});}
function applyStored(a){if(!a||!a.sel||!a.now||!a.base)return;var el=resolveEl(a);if(!el)return;PROPS.forEach(function(p){if(String(a.now[p.k])!==String(a.base[p.k]))el.style[p.k]=(a.now[p.k]==null?(p.k==='backgroundColor'?'transparent':''):a.now[p.k]);});if(a.now.text!=null&&a.now.text!==a.base.text&&el.children.length===0)el.textContent=a.now.text;if(a.now.value!=null&&a.now.value!==a.base.value&&isFormValueEl(el))el.value=a.now.value;}
function revertStored(a){if(!a||!a.sel||!a.now||!a.base)return;var el=resolveEl(a);if(!el)return;restoreAnnoStyle(el,a);if(a.now.text!=null&&a.now.text!==a.base.text&&el.children.length===0)el.textContent=a.base.text;if(a.now.value!=null&&a.now.value!==a.base.value&&isFormValueEl(el))el.value=a.base.value;}
function restoreStoredElement(el,a){if(!el||!a)return;restoreAnnoStyle(el,a);if(a.now&&a.base&&a.now.text!=null&&a.now.text!==a.base.text&&el.children.length===0)el.textContent=a.base.text;if(a.now&&a.base&&a.now.value!=null&&a.now.value!==a.base.value&&isFormValueEl(el))el.value=a.base.value;}
function resetAndReplay(nextAnnos){var old=annos.slice(),seen=[],groups=[];old.forEach(function(a){var el=resolveEl(a);if(!el)return;if(seen.indexOf(el)<0){seen.push(el);groups.push({el:el,a:a});}});groups.forEach(function(g){restoreStoredElement(g.el,g.a);});annos=nextAnnos||[];annos.forEach(applyStored);save();renderAll();}
// 无痕回滚：恢复本帧所有被标注元素到原始状态（非 active 模式下页面不留工具痕迹）
function revertAllLocal(){
  var seen=[],groups=[];
  annos.forEach(function(a){var el=resolveEl(a);if(!el)return;if(seen.indexOf(el)<0){seen.push(el);groups.push({el:el,a:a});}});
  groups.forEach(function(g){restoreStoredElement(g.el,g.a);});
  if(layer)layer.innerHTML='';
}
function applyAll(){annos.forEach(applyStored);}
function chSummaryFrom(base,now){if(!base||!now)return '';var p=[];if(now.text!=null&&String(now.text)!==String(base.text))p.push('文案改写');if(now.value!=null&&String(now.value)!==String(base.value))p.push('内容 '+base.value+'→'+now.value);PROPS.forEach(function(pr){if(String(now[pr.k])!==String(base[pr.k])){if(pr.k==='color')p.push('文字色 '+now.color);else if(pr.k==='backgroundColor')p.push('背景 '+(now.backgroundColor||'透明'));else p.push(pr.label+' '+base[pr.k]+'→'+now[pr.k]);}});return p.join(' · ');}
function chSummary(a){return chSummaryFrom(a.base,a.now);}

/* ================= 角色状态 ================= */
// top: mode = 'dormant' | 'replay' | 'active'；child 镜像 masterMode
var mode='dormant';
var masterMode='dormant';
var myPath=null,childDepth=0,TOKEN=null;
var booted=false,fab=null,btn=null,panel=null,layer=null,replayBar=null,hotN=0;
var frameRegistry={};   // top 专用：path.join(',') → {path, el, win, ack}
var watchT=0,migrateChecked=false;

function isOn(){return isTop?on:(masterMode==='active'&&!!myPath);}

/* ================= 存储与广播（Master） ================= */
function save(){
  if(!isTop)return;
  try{var o={};o[KEY]=JSON.stringify(annos);chrome.storage.local.set(o);}catch(e){toast('保存失败','无法写入扩展存储，请先复制导出');}
  notifyBadge();
  broadcastState();
}
function notifyBadge(){if(!isTop)return;try{var r=chrome.runtime.sendMessage({type:'ANNO_CHANGED'});if(r&&r.catch)r.catch(function(){});}catch(e){}}
function subsetFor(path){var k=(path||[]).join(',');return annos.filter(function(a){return ((a.f||[]).join(','))===k;});}
function sendStateTo(en){if(!en||!en.win)return;postToFrame(en.win,{type:'PA_STATE',token:TOKEN,annos:subsetFor(en.path),mode:mode});}
function broadcastState(){if(!isTop||!booted)return;Object.keys(frameRegistry).forEach(function(k){var en=frameRegistry[k];if(en.ack)sendStateTo(en);});}
function sendFlags(){if(!isTop||!booted)return;Object.keys(frameRegistry).forEach(function(k){var en=frameRegistry[k];if(en.ack&&en.win)postToFrame(en.win,{type:'PA_FLAGS',token:TOKEN,dialogOpen:dialogOpen});});}
function postToFrame(win,msg){try{win.postMessage(msg,'*');}catch(e){}}
function postTop(msg){msg.token=TOKEN;try{window.top.postMessage(msg,'*');}catch(e){}}

/* ================= frame 注册与握手 ================= */
function genToken(){return 'pa-'+Math.random().toString(36).slice(2)+Date.now().toString(36);}
function walkFrames(basePath,depth){
  if(depth>4)return;
  var list=document.querySelectorAll('iframe');
  var newReg=null,needState=[];
  if(isTop){
    // 保留动态登记的深层嵌套条目（顶层扫描覆盖不到它们）
    newReg={};
    Object.keys(frameRegistry).forEach(function(k){
      var en=frameRegistry[k];
      if(en.path.length>1)newReg[k]=en;
    });
  }
  for(var i=0;i<list.length;i++){
    var el=list[i];
    var path=basePath.concat([i]);
    var w=null;try{w=el.contentWindow;}catch(e){}
    if(isTop){
      var key=path.join(',');
      var old=frameRegistry[key];
      var keepAck=!!(old&&old.el===el&&old.ack);
      newReg[key]={path:path,el:el,win:w,ack:keepAck};
      // 重建注册表时对已握手的帧补发 HELLO+状态，防 ACK 与重建竞态丢状态
      if(w&&!keepAck)postToFrame(w,{type:'PA_FRAME_HELLO',token:TOKEN,path:path,depth:depth+1});
      else if(w&&keepAck)needState.push(newReg[key]);
    }else if(w){
      postToFrame(w,{type:'PA_FRAME_HELLO',token:TOKEN,path:path,depth:depth+1});
    }
    try{el.addEventListener('load',scheduleRescan);}catch(e){}
  }
  if(isTop){frameRegistry=newReg;needState.forEach(sendStateTo);}
}
function scanFrames(){if(!TOKEN)TOKEN=genToken();walkFrames([],1);}
function rescan(){if(isTop)scanFrames();else if(myPath)walkFrames(myPath,childDepth);}
var scanT=0;
function scheduleRescan(){clearTimeout(scanT);scanT=setTimeout(rescan,250);}
function entryByWin(w){if(!w)return null;var ks=Object.keys(frameRegistry);for(var i=0;i<ks.length;i++){if(frameRegistry[ks[i]].win===w)return frameRegistry[ks[i]];}return null;}
// 顶层文档内逐级下钻解析帧链上每级 iframe 元素（跨域边界处截断）
function resolveChain(path){
  var out=[],doc=document;
  for(var i=0;i<path.length;i++){
    var el=doc.querySelectorAll('iframe')[path[i]]||null;
    if(!el)break;
    out.push(el);
    try{doc=el.contentDocument;}catch(e){break;}
    if(!doc)break;
  }
  return out;
}
function registerNested(path,win){
  var key=(path||[]).join(',');
  var chain=resolveChain(path);
  var el=chain.length===path.length?chain[chain.length-1]:(chain[chain.length-1]||null);
  var en=frameRegistry[key];
  if(en&&en.win===win){if(!en.el&&el)en.el=el;return en;}
  en={path:path.slice(),el:el,win:win,ack:true};
  frameRegistry[key]=en;
  return en;
}
function frameSummary(){
  var total=0,ok=0;
  Object.keys(frameRegistry).forEach(function(k){var en=frameRegistry[k];if(en.el&&en.el.isConnected){total++;if(en.ack)ok++;}});
  if(!total)return '';
  var parts=[];
  if(ok)parts.push(ok+' 个 iframe 内部可标注');
  var rest=total-ok;
  if(rest)parts.push(rest+' 个 iframe 仅能标注外框');
  return parts.join(' · ');
}

/* ================= 渲染（各帧本地） ================= */
var renderRafT=0;
function scheduleRender(){if(renderRafT)return;renderRafT=requestAnimationFrame(function(){renderRafT=0;renderMarks();});}
function ensureLayer(){
  if(layer||!document.body)return;
  layer=markUi(document.createElement('div'));
  layer.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2147483639;';
  document.body.appendChild(layer);
}
function highlightMark(n,hot){
  hotN=hot?n:0;
  if(isTop){
    var a=byN(n);
    if(a&&a.f&&a.f.length){var en=frameRegistry[a.f.join(',')];if(en&&en.win)postToFrame(en.win,{type:'PA_HIGHLIGHT',n:n,hot:hot});}
  }
  if(!layer)return;
  Array.prototype.forEach.call(layer.querySelectorAll('[data-n="'+n+'"]'),function(e){e.classList.toggle('hot',hot);});
}
function locateLocal(n){
  var a=byN(n);if(!a)return;var el=resolveEl(a);
  if(el&&el.scrollIntoView)el.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'});
  setTimeout(function(){renderMarks();if(!layer)return;var t=layer.querySelector('.pa-box[data-n="'+n+'"]')||layer.querySelector('.pa-badge[data-n="'+n+'"]');if(t){t.classList.add('flash');setTimeout(function(){t.classList.remove('flash');},1000);}},el?360:0);
}
function locateMark(n){
  var a=byN(n);if(!a)return;
  if(isTop&&a.f&&a.f.length){var en=frameRegistry[a.f.join(',')];if(en&&en.win){postToFrame(en.win,{type:'PA_LOCATE',n:n});return;}}
  locateLocal(n);
}
function flashTarget(el){var anchor=el?visibleAnchor(el):null;if(!anchor||!anchor.getBoundingClientRect)return;var r=anchor.getBoundingClientRect();if(!(r.width||r.height))return;var box=markUi(document.createElement('div'));box.className='pa-box retarget flash';box.style.left=(r.left+window.scrollX)+'px';box.style.top=(r.top+window.scrollY)+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';['tl','tr','bl','br'].forEach(function(cc){var cn=document.createElement('div');cn.className='pa-corner '+cc;box.appendChild(cn);});ensureLayer();if(layer)layer.appendChild(box);setTimeout(function(){if(box.parentNode)box.parentNode.removeChild(box);},1050);}
function renderMarks(){
  if(!layer)return;
  layer.innerHTML='';
  annos.forEach(function(a){
    var el=resolveEl(a);
    var anchor=el?visibleAnchor(el):null;
    var via=!!(anchor&&anchor!==el);
    var bx,by,r=null;
    if(anchor){r=anchor.getBoundingClientRect();bx=r.left+window.scrollX;by=r.top+window.scrollY;}else{bx=a.x||0;by=a.y||0;}
    if(r&&(r.width||r.height)){
      var box=markUi(document.createElement('div'));box.className='pa-box'+(via?' via':'');box.setAttribute('data-n',a.n);box.style.left=bx+'px';box.style.top=by+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';
      ['tl','tr','bl','br'].forEach(function(cc){var cn=document.createElement('div');cn.className='pa-corner '+cc;box.appendChild(cn);});
      layer.appendChild(box);
    }
    var badge=markUi(document.createElement('div'));badge.className='pa-badge'+(via?' via':'');badge.setAttribute('data-n',a.n);badge.textContent=a.n;
    badge.title=((a.mode==='note'?a.text:chSummary(a))||'')+(via?'（实际元素已隐藏，标注显示在可见父级）':'');
    badge.style.left=bx+'px';badge.style.top=by+'px';
    badge.onclick=function(e){e.stopPropagation();if(isTop){if(on)editAnno(a.n);else locateMark(a.n);}else postTop({type:'PA_PIN_CLICK',n:a.n});};
    badge.onmouseenter=function(){highlightMark(a.n,true);};
    badge.onmouseleave=function(){highlightMark(a.n,false);};
    layer.appendChild(badge);
  });
  if(hotN)highlightMark(hotN,true);
}
function renderAll(){
  if(isTop){renderMarks();renderList();updatePanel();}
  else renderMarks();
}

/* ================= Master UI ================= */
function buildUi(){
  if(booted)return;
  booted=true;
  ensureLayer();
  fab=markUi(document.createElement('div'));fab.className='pa-fab';fab.style.display='none';
  fab.innerHTML='<div class="pa-toggle"><span class="pa-ico">⌖</span><span class="pa-lab">原型标注</span><span class="pa-state">OFF</span><span class="pa-sw"></span></div>'
  +'<div class="pa-panel"><div class="pa-phead"><span class="pa-ptitle">📋 标注清单</span><span class="pa-cnt">0</span></div><div class="pa-body"></div><div class="pa-foot"><button class="pri pa-copy">📋 复制给 AI</button><button class="pa-clr">清空</button></div></div>';
  document.body.appendChild(fab);
  btn=fab.querySelector('.pa-toggle');
  panel=fab.querySelector('.pa-panel');
  btn.onclick=function(){if(fab._drag)return;setMode(!on);};
  panel.querySelector('.pa-copy').onclick=function(e){e.stopPropagation();copyOut();};
  panel.querySelector('.pa-clr').onclick=function(e){e.stopPropagation();if(confirm('清空全部标注？')){seq=0;elMap={};resetAndReplay([]);}};
  drag(btn,fab);drag(panel.querySelector('.pa-phead'),fab);

  replayBar=markUi(document.createElement('div'));replayBar.className='pa-replay-bar';replayBar.style.display='none';
  replayBar.innerHTML='<span class="pa-rb-ico">⌖</span><span class="pa-rb-txt">只读回显 <b class="pa-rb-n">0</b> 条标注<i>· 页面已按标注预览</i></span><button class="pa-rb-btn">进入编辑</button>';
  document.body.appendChild(replayBar);
  replayBar.querySelector('.pa-rb-btn').onclick=function(){setMode(true);};
}
function renderList(){
  var body=panel.querySelector('.pa-body');var cnt=fab.querySelector('.pa-cnt');
  cnt.textContent=annos.length;cnt.style.display=annos.length?'inline-block':'none';
  if(!annos.length){body.innerHTML='';return;}
  var g={};annos.forEach(function(a){(g[a.ctx]=g[a.ctx]||[]).push(a);});
  var html='';
  Object.keys(g).forEach(function(k){
    html+='<div class="pa-grp">'+esc(k)+'</div>';
    g[k].forEach(function(a){
      var main=(a.mode==='note')?(a.text||'(空)'):(chSummary(a)||'(空)');
      var ty=a.type?a.type.label:'';
      var fm=(a.f&&a.f.length)?'<span class="pa-fm" title="位于 iframe 内部">iframe</span> ':'';
      html+='<div class="pa-item" data-n="'+a.n+'"><span class="pa-n">'+a.n+'</span><span class="pa-tx">'+fm+esc(main)+'<span class="pa-summ">'+(ty?'<b style="color:#FF8A7A">'+esc(ty)+'</b> · ':'')+'“'+esc(a.summ)+'”</span></span><span class="pa-act"><span data-ed="'+a.n+'" title="编辑">✎</span><span data-del="'+a.n+'" title="删除">🗑</span></span></div>';
    });
  });
  body.innerHTML=html;
  Array.prototype.forEach.call(body.querySelectorAll('.pa-item'),function(row){
    var n=+row.getAttribute('data-n');
    row.onmouseenter=function(){highlightMark(n,true);};
    row.onmouseleave=function(){highlightMark(n,false);};
    row.onclick=function(){locateMark(n);};
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-ed]'),function(x){x.onclick=function(e){e.stopPropagation();editAnno(+x.getAttribute('data-ed'));};});
  Array.prototype.forEach.call(body.querySelectorAll('[data-del]'),function(x){x.onclick=function(e){e.stopPropagation();var dn=+x.getAttribute('data-del');resetAndReplay(annos.filter(function(a){return a.n!==dn;}));};});
  body.onmouseleave=function(){if(hotN)highlightMark(hotN,false);};
  if(hotN)highlightMark(hotN,true);
}
function updatePanel(){
  panel.style.display=(on&&annos.length)?'flex':'none';
  if(on&&annos.length&&fab.style.left)clamp(fab);
  if(replayBar){
    var show=(!on&&mode==='replay'&&annos.length);
    if(show){
      replayBar.style.display='flex';
      replayBar.querySelector('.pa-rb-n').textContent=annos.length;
      scheduleReplayBarHide();
    }else{
      replayBar.style.display='none';
      cancelReplayBarHide();
    }
  }
}
/* 回显提示条：默认 5s 后自动消失（toast 语义，不常驻遮挡页面） */
var replayBarT=0;
function scheduleReplayBarHide(){
  clearTimeout(replayBarT);
  replayBarT=setTimeout(function(){if(replayBar)replayBar.style.display='none';},5000);
}
function cancelReplayBarHide(){clearTimeout(replayBarT);}

/* ================= 编辑弹窗（Master；元素可能在本帧或子帧） ================= */
function clamp(target){var maxX=window.innerWidth-target.offsetWidth-6,maxY=window.innerHeight-target.offsetHeight-6;var l=parseFloat(target.style.left||'0'),t=parseFloat(target.style.top||'0');target.style.left=Math.max(6,Math.min(l,Math.max(6,maxX)))+'px';target.style.top=Math.max(6,Math.min(t,Math.max(6,maxY)))+'px';}
function closeDialog(runCancel){if(runCancel&&activeCancel){var fn=activeCancel;activeCancel=null;fn();return;}var d=document.querySelector('.pa-dialog');if(d)d.remove();activeCancel=null;if(dialogOpen){dialogOpen=false;sendFlags();}}

function fStepper(label,k,val){return '<div class="pa-field"><label>'+label+'</label><div class="pa-ctl"><div class="pa-step"><button data-step="'+k+'" data-d="-1">−</button><input class="pa-in-'+k+'" type="number" min="0" max="3000" value="'+val+'"><button data-step="'+k+'" data-d="1">+</button></div><span class="pa-unit">px</span></div></div>';}
function fWeight(val){var o='';WEIGHTS.forEach(function(w){o+='<option value="'+w[0]+'"'+(String(val)===w[0]?' selected':'')+'>'+w[1]+'</option>';});return '<div class="pa-field"><label>字重</label><div class="pa-ctl"><select class="pa-sel pa-in-fontWeight">'+o+'</select></div></div>';}
function fColor(label,k,val,allowNone){var has=val!=null;return '<div class="pa-field"><label>'+label+'</label><div class="pa-ctl pa-color"><input type="color" class="pa-in-'+k+'" value="'+(val||'#000000')+'"><input class="pa-hex pa-hex-'+k+'" value="'+(val||'')+'"'+(allowNone?' placeholder="无"':'')+'>'+(allowNone?'<span class="pa-none'+(has?'':' act')+'" data-none="'+k+'" title="设为透明">无</span>':'')+'</div></div>';}

// o: {anno, num, title, ctx, summ, type, payload, ref, editableText, editableValue, hasStyle, chain, note, px, py, onSave}
function openEditor(o){
  closeDialog(true);dialogOpen=true;sendFlags();
  var anno=o.anno||null;
  var ref=o.ref||{local:true,el:null};
  var payload=o.payload||{};
  var type=o.type||(anno&&anno.type)||{key:'box',label:'元素',tag:'?'};
  var editableText=!!o.editableText,editableValue=!!o.editableValue;
  var hasStyle=o.hasStyle!==false;
  var base;
  if(anno&&anno.base){base=anno.base;}
  else{base=(payload.style?Object.assign({},payload.style):readStyle(ref.el));if(!editableText)base.text=null;if(!editableValue)base.value=null;}
  var now=(anno&&anno.now)?Object.assign({},anno.now):Object.assign({},base);
  var inlineBase=(anno&&anno.inlineBase)?anno.inlineBase:(payload.inline||readInlineStyle(ref.el));
  var fields=fieldsFor(type.key,editableText,editableValue);
  var mode2=(anno&&anno.mode)?anno.mode:(hasStyle?'tweak':'note');
  if(!hasStyle)mode2='note';
  var chain=o.chain||[];
  var chainEls=(ref.local&&chain.length)?chainOf(ref.el):[];

  var d=markUi(document.createElement('div'));d.className='pa-dialog';
  var h='<div class="pa-dhead"><span class="pa-dttl"><span class="pa-dnum">#'+o.num+'</span>'+esc(o.title)+'</span><span class="pa-dx" title="取消">✕</span></div><div class="pa-dbody">';
  h+='<div class="pa-dctx"><span class="pa-dtype">'+esc(type.label)+' <i>&lt;'+esc(type.tag)+'&gt;</i></span><span class="pa-dctxn">'+esc(o.ctx)+'</span></div>';
  h+='<div class="pa-dsumm">“'+esc(o.summ)+'”</div>';
  if(chain.length){var curI=chain.length-1;h+='<div class="pa-bc"><span class="pa-bch">选中层级 · 点上层可改选父级元素</span>';chain.forEach(function(c,i){h+=(i?'<span class="pa-sep">›</span>':'')+'<span class="pa-crumb'+(i===curI?' cur':'')+'" data-i="'+i+'">'+esc(typeof c==='string'?c:crumbLabel(c))+'</span>';});h+='</div>';}
  if(hasStyle)h+='<div class="pa-modebar"><div class="pa-modebtn pa-mode-tweak'+(mode2==='tweak'?' act':'')+'">🎛 直接微调</div><div class="pa-modebtn pa-mode-note'+(mode2==='note'?' act':'')+'">✍️ 文字说明</div></div>';
  h+='<div class="pa-mbody-tweak" style="display:'+(mode2==='tweak'?'block':'none')+'">';
  if(fields.text)h+='<div class="pa-sec"><div class="pa-sec-h">文案</div><textarea class="pa-ta pa-c-text" style="min-height:52px">'+esc(now.text||'')+'</textarea></div>';
  if(fields.value)h+='<div class="pa-sec"><div class="pa-sec-h">内容 · 输入框的值</div><textarea class="pa-ta pa-c-value" style="min-height:52px">'+esc(now.value||'')+'</textarea></div>';
  h+='<div class="pa-sec"><div class="pa-sec-h">样式微调 <span class="pa-reset" title="复原到原始样式">↺ 复原</span></div>';
  if(fields.fontSize)h+=fStepper('字号','fontSize',pxv(now.fontSize));
  if(fields.fontWeight)h+=fWeight(now.fontWeight);
  if(fields.color)h+=fColor('文字色','color',now.color,false);
  if(fields.backgroundColor)h+=fColor('背景色','backgroundColor',now.backgroundColor,true);
  if(fields.borderRadius)h+=fStepper('圆角','borderRadius',pxv(now.borderRadius));
  if(fields.width)h+=fStepper('宽','width',pxv(now.width));
  if(fields.height)h+=fStepper('高','height',pxv(now.height));
  h+='</div>';
  h+='<div class="pa-preview"><span class="pa-pvh">自动生成的修改意见</span><span class="pa-pvc"></span></div>';
  h+='</div>';
  h+='<div class="pa-mbody-note" style="display:'+(mode2==='note'?'block':'none')+'"><div class="pa-sec"><div class="pa-sec-h">文字说明</div><textarea class="pa-ta pa-c-note" placeholder="用一句话描述这里要怎么改"></textarea></div></div>';
  h+='<div class="pa-dhint">Ctrl / ⌘ + Enter 保存 · Esc 取消 · 标题栏可拖动 · 微调实时预览</div>';
  h+='<div class="pa-dfoot"><button class="pri pa-dsave">保存标注</button><button class="pa-dcancel">取消</button></div></div>';
  d.innerHTML=h;
  document.body.appendChild(d);
  d.style.left=o.px+'px';d.style.top=o.py+'px';clamp(d);

  var noteEl=d.querySelector('.pa-c-note');noteEl.value=o.note||'';

  function refreshPreview(){var pv=d.querySelector('.pa-pvc');if(!pv)return;var s=chSummaryFrom(base,now);pv.innerHTML=s?esc(s):'<span class="pa-pvempty">（还没有改动——调整上面的属性即可）</span>';}
  function applyPreview(){
    if(ref.local){
      var el=ref.el;if(!el)return;
      restoreInlineStyle(el,inlineBase);
      PROPS.forEach(function(p){if(String(now[p.k])!==String(base[p.k]))el.style[p.k]=(now[p.k]==null?(p.k==='backgroundColor'?'transparent':''):now[p.k]);});
      if(editableText&&now.text!=null&&now.text!==base.text)el.textContent=now.text;
      if(editableValue&&now.value!=null&&now.value!==base.value)el.value=now.value;
    }else{
      postToFrame(ref.win,{type:'PA_PREVIEW',op:'apply',n:anno?anno.n:null,base:base,now:now,inlineBase:inlineBase,editableText:editableText,editableValue:editableValue});
    }
  }
  function revertPreview(){
    if(ref.local){
      var el=ref.el;if(!el)return;
      restoreInlineStyle(el,inlineBase);
      if(editableText&&base.text!=null)el.textContent=base.text;
      if(editableValue&&base.value!=null)el.value=base.value;
    }else{
      postToFrame(ref.win,{type:'PA_PREVIEW',op:'revert',n:anno?anno.n:null,base:base,now:now,inlineBase:inlineBase,editableText:editableText,editableValue:editableValue});
    }
  }

  var ct=d.querySelector('.pa-c-text');
  var cv=d.querySelector('.pa-c-value');
  var fw=d.querySelector('.pa-in-fontWeight');
  if(hasStyle){
    if(ct)ct.addEventListener('input',function(){now.text=ct.value;applyPreview();refreshPreview();});
    if(cv)cv.addEventListener('input',function(){now.value=cv.value;applyPreview();refreshPreview();});
    ['fontSize','borderRadius','width','height'].forEach(function(k){var inp=d.querySelector('.pa-in-'+k);if(inp)inp.addEventListener('input',function(){now[k]=(parseInt(inp.value,10)||0)+'px';applyPreview();refreshPreview();});});
    Array.prototype.forEach.call(d.querySelectorAll('[data-step]'),function(b){b.addEventListener('click',function(){var k=b.getAttribute('data-step'),delta=+b.getAttribute('data-d');var inp=d.querySelector('.pa-in-'+k);var nv=Math.max(0,(parseInt(inp.value,10)||0)+delta);inp.value=nv;now[k]=nv+'px';applyPreview();refreshPreview();});});
    if(fw)fw.addEventListener('change',function(){now.fontWeight=fw.value;applyPreview();refreshPreview();});
    ['color','backgroundColor'].forEach(function(k){var ci=d.querySelector('.pa-in-'+k),hx=d.querySelector('.pa-hex-'+k);if(!ci)return;function set(v){now[k]=v;applyPreview();if(v){ci.value=v;hx.value=v;}else hx.value='';var nb=d.querySelector('[data-none="'+k+'"]');if(nb)nb.classList.toggle('act',v==null);refreshPreview();}ci.addEventListener('input',function(){set(ci.value);});hx.addEventListener('change',function(){if(/^#[0-9a-fA-F]{6}$/.test(hx.value))set(hx.value);else if(!hx.value)set(null);});});
    Array.prototype.forEach.call(d.querySelectorAll('[data-none]'),function(b){b.addEventListener('click',function(){var k=b.getAttribute('data-none');now[k]=null;applyPreview();var hx=d.querySelector('.pa-hex-'+k);if(hx)hx.value='';b.classList.add('act');refreshPreview();});});
    var rs=d.querySelector('.pa-reset');
    if(rs)rs.addEventListener('click',function(){['fontSize','fontWeight','color','backgroundColor','borderRadius','width','height'].forEach(function(k){now[k]=base[k];});if(editableText)now.text=base.text;if(editableValue)now.value=base.value;revertPreview();['fontSize','borderRadius','width','height'].forEach(function(k){var inp=d.querySelector('.pa-in-'+k);if(inp)inp.value=pxv(base[k]);});if(fw)fw.value=base.fontWeight;['color','backgroundColor'].forEach(function(k){var ci=d.querySelector('.pa-in-'+k),hx=d.querySelector('.pa-hex-'+k);if(ci)ci.value=base[k]||'#000000';if(hx)hx.value=base[k]||'';var nb=d.querySelector('[data-none="'+k+'"]');if(nb)nb.classList.toggle('act',base[k]==null);});if(ct)ct.value=base.text||'';if(cv)cv.value=base.value||'';refreshPreview();});
    d.querySelector('.pa-mode-tweak').onclick=function(){switchMode('tweak');};
    d.querySelector('.pa-mode-note').onclick=function(){switchMode('note');};
  }

  function switchMode(m){mode2=m;d.querySelector('.pa-mode-tweak').classList.toggle('act',m==='tweak');d.querySelector('.pa-mode-note').classList.toggle('act',m==='note');d.querySelector('.pa-mbody-tweak').style.display=(m==='tweak')?'block':'none';d.querySelector('.pa-mbody-note').style.display=(m==='note')?'block':'none';if(m==='note'){revertPreview();}else{applyPreview();refreshPreview();}var f=(m==='note')?noteEl:(editableText?d.querySelector('.pa-c-text'):null);if(f)f.focus();}

  if(chain.length){var curIdx=chain.length-1;Array.prototype.forEach.call(d.querySelectorAll('.pa-crumb'),function(cr){var ci=+cr.getAttribute('data-i');if(ci===curIdx)return;cr.onclick=function(){revertPreview();onRetarget(ci);};});}
  function onRetarget(ci){
    if(ref.local){
      var anc=chainEls[ci];
      if(!anc||anc===ref.el)return;
      flashTarget(anc);
      var pl=buildPickPayload(anc,[],payload.clientX,payload.clientY);
      pl.el=anc;
      handlePick(pl);
    }else{
      closeDialog(true);
      postToFrame(ref.win,{type:'PA_RETARGET',index:ci});
    }
  }
  refreshPreview();
  if(mode2==='note')noteEl.focus();else{var tf=d.querySelector('.pa-c-text')||d.querySelector('.pa-c-value');if(tf)tf.focus();else{d.tabIndex=-1;d.style.outline='none';d.focus();}}

  function fin(){
    var data;
    if(mode2==='note'){data={mode:'note',note:(noteEl.value||'').trim(),base:base,now:Object.assign({},base),inlineBase:inlineBase,type:type};}
    else{data={mode:'tweak',note:'',base:base,now:now,inlineBase:inlineBase,type:type};}
    var has=(data.mode==='note')?!!data.note:changed(data.base,data.now);
    if(!has){toast('还没有做任何改动','写点说明或调整上方样式再保存；纯备注可点「✍️ 文字说明」',2800);return;}
    closeDialog();o.onSave(data);
  }
  function cancel(){
    revertPreview();
    if(anno){
      if(ref.local)applyStored(anno);
      else postToFrame(ref.win,{type:'PA_PREVIEW',op:'restore',n:anno.n});
    }
    closeDialog();
  }
  activeCancel=cancel;
  d.querySelector('.pa-dsave').onclick=fin;
  d.querySelector('.pa-dcancel').onclick=cancel;
  d.querySelector('.pa-dx').onclick=cancel;
  d.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();fin();}else if(e.key==='Escape'){e.preventDefault();cancel();}});
  drag(d.querySelector('.pa-dhead'),d);
}

/* ================= 点选 → 编辑器（Master） ================= */
function buildPickPayload(el,f,cx,cy){
  var r=el.getBoundingClientRect();
  var t=elType(el);
  return {
    f:(f||[]).slice(),
    sel:selOf(el),
    ctx:ctxOf(el),
    summ:summOf(el),
    type:{key:t.key,label:t.label,tag:t.tag},
    chain:chainOf(el).map(crumbLabel),
    style:readStyle(el),
    inline:readInlineStyle(el),
    editableText:(el.children.length===0&&(t.key==='text'||t.key==='button')),
    editableValue:isFormValueEl(el),
    pin:{x:Math.round(r.left+window.scrollX+r.width/2),y:Math.round(r.top+window.scrollY+12)},
    clientX:cx,clientY:cy
  };
}
function topClientFor(payload){
  var path=(payload.f||[]).join(',');
  var en=frameRegistry[path];
  if(!en)return {x:Math.max(6,window.innerWidth/2-170),y:Math.max(6,window.innerHeight/2-200)};
  // 帧链逐级累加：每级 iframe 元素的视口 rect + content 原点（border），跨域截断时用已得的最深链近似
  var chain=resolveChain((payload.f||[]).slice());
  var x=0,y=0,ok=true;
  for(var i=0;i<payload.f.length;i++){
    var el=chain[i];
    if(!el||!el.isConnected){ok=false;break;}
    var r=el.getBoundingClientRect();var cs=getComputedStyle(el);
    x+=r.left+parseFloat(cs.borderLeftWidth||0);
    y+=r.top+parseFloat(cs.borderTopWidth||0);
  }
  if(!ok)return {x:Math.max(6,window.innerWidth/2-170),y:Math.max(6,window.innerHeight/2-200)};
  return {x:x+payload.clientX+14,y:y+payload.clientY+14};
}
function handlePick(payload){
  if(!on||dialogOpen)return;
  var ref,px,py;
  if(payload.f&&payload.f.length){
    var en=frameRegistry[payload.f.join(',')];
    ref={local:false,win:en?en.win:null};
    var c=topClientFor(payload);px=c.x;py=c.y;
  }else{
    ref={local:true,el:payload.el};
    px=payload.clientX+14;py=payload.clientY+14;
  }
  openEditor({anno:null,num:seq+1,title:'标注 / 微调',ctx:payload.ctx,summ:payload.summ,type:payload.type,payload:payload,ref:ref,editableText:payload.editableText,editableValue:payload.editableValue,chain:payload.chain,note:'',px:px,py:py,
    onSave:function(data){
      var p=payload.pin||{x:0,y:0};
      seq++;
      annos.push({n:seq,x:p.x,y:p.y,f:(payload.f||[]).slice(),sel:payload.sel,ctx:payload.ctx,summ:payload.summ,type:{key:payload.type.key,label:payload.type.label,tag:payload.type.tag},mode:data.mode,text:data.note,base:data.base,now:data.now,inlineBase:data.inlineBase});
      if(ref.local&&ref.el)elMap[seq]=ref.el;
      resetAndReplay(annos);
    }});
}
function editAnno(n){
  if(!on)return;var a=byN(n);if(!a)return;
  var ref,editableText,editableValue;
  var type=a.type||{key:'box',label:'元素',tag:'?'};
  if(a.f&&a.f.length){
    var en=frameRegistry[a.f.join(',')];
    ref={local:false,win:en?en.win:null};
    editableText=!!(a.base&&a.base.text!=null&&(type.key==='text'||type.key==='button'));
    editableValue=!!(a.base&&a.base.value!=null);
  }else{
    var el=resolveEl(a);
    ref={local:true,el:el};
    editableText=!!el&&(type.key==='text'||type.key==='button')&&el.children.length===0;
    editableValue=!!el&&isFormValueEl(el);
  }
  var cx=Math.max(6,window.innerWidth/2-170),cy=Math.max(6,window.innerHeight/2-200);
  openEditor({anno:a,num:a.n,title:'编辑标注',ctx:a.ctx,summ:a.summ,type:type,payload:{},ref:ref,editableText:editableText,editableValue:editableValue,hasStyle:ref.local?!!ref.el:true,chain:[],note:a.text||'',px:cx,py:cy,
    onSave:function(data){
      var has=(data.mode==='note')?!!data.note:changed(data.base,data.now);
      if(!has){resetAndReplay(annos.filter(function(x){return x.n!==n;}));return;}
      a.mode=data.mode;a.text=data.note;a.base=data.base;a.now=data.now;a.inlineBase=data.inlineBase;resetAndReplay(annos);
    }});
}

/* ================= 导出 / 复制 / toast（Master） ================= */
function selTextOf(a){if(a.f&&a.f.length){var p=[];a.f.forEach(function(i){p.push('iframe#'+(i+1));});return p.join(' >> ')+' >> '+(a.sel||'');}return a.sel||'';}
function exportMd(){if(!annos.length)return'（无标注）';var g={};annos.forEach(function(a){(g[a.ctx]=g[a.ctx]||[]).push(a);});var md='【原型标注清单】共 '+annos.length+' 条';Object.keys(g).forEach(function(k){md+='\n\n## '+k;g[k].forEach(function(a){var ty=a.type?(a.type.label+' <'+a.type.tag+'>'):'';var cs=chSummary(a);md+='\n- ['+a.n+'] '+(a.mode==='note'?(a.text||'(空)'):(cs?'【微调】 '+cs:'(空)'));md+='\n    · 元素：'+(ty?ty+' · ':'')+'“'+a.summ+'” · 选择器：'+selTextOf(a);if(a.mode!=='note'&&a.now&&a.base){if(a.now.text!=null&&String(a.now.text)!==String(a.base.text))md+='\n    · 文案："'+a.base.text+'" → "'+a.now.text+'"';if(a.now.value!=null&&String(a.now.value)!==String(a.base.value))md+='\n    · 内容："'+a.base.value+'" → "'+a.now.value+'"';var sp=[];PROPS.forEach(function(pr){if(String(a.now[pr.k])!==String(a.base[pr.k]))sp.push(pr.css+' '+(a.base[pr.k]==null?'transparent':a.base[pr.k])+' → '+(a.now[pr.k]==null?'transparent':a.now[pr.k]));});if(sp.length)md+='\n    · 样式：'+sp.join('；');}});});return md;}
function copyText(text,ok,fail){function fallback(){var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;left:-9999px;top:0;';document.body.appendChild(ta);ta.focus();ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();return done;}if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(function(){if(ok)ok();},function(){if(fallback()){if(ok)ok();}else if(fail)fail();});}else{if(fallback()){if(ok)ok();}else if(fail)fail();}}
function copyOut(){if(!annos.length){toast('还没有标注','点击页面元素即可添加');return;}var md=exportMd();copyText(md,function(){toast('已复制 '+annos.length+' 条标注','含 before→after 精确值，直接粘贴给 AI');},function(){toast('复制失败','请手动选中导出内容复制');});}
function toast(title,sub,duration){
  if(!isTop||!document.body)return;
  var t=document.querySelector('.pa-toast');
  if(!t){t=markUi(document.createElement('div'));t.className='pa-toast';document.body.appendChild(t);}else markUi(t);
  t.innerHTML='<span class="pa-ti">⌖</span><span class="pa-tt"><b>'+esc(title)+'</b>'+(sub?'<i>'+esc(sub)+'</i>':'')+'</span>';
  void t.offsetWidth;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove('show');},duration||3800);
}

/* ================= 模式切换（Master） ================= */
// active = 编辑（UI+点选+预览样式+针脚）；dormant/replay = 无痕（不渲染针脚、回滚预览样式）
function applyMode(m){
  mode=m;on=(m==='active');
  if(!booted&&m!=='dormant')buildUi();
  if(!booted)return;
  document.body.classList.toggle('pa-on',on);
  btn.classList.toggle('on',on);
  fab.querySelector('.pa-state').textContent=on?'ON':'OFF';
  fab.style.display=on?'block':'none';
  if(on){renderAll();layer.style.display='block';}
  else{closeDialog(true);exitPick();revertAllLocal();layer.style.display='none';updatePanel();}
  broadcastState();sendFlags();
}
function setMode(v){
  if(!isTop)return;
  if(v){
    buildUi();startWatch();maybeMigrate();scanFrames();
    applyMode('active');
    var fs=frameSummary();
    toast('标注模式已开启','按住 Ctrl + Alt 点击页面元素进行标注 · 平时可正常操作页面'+(fs?' · '+fs:''),2600);
  }else{
    applyMode(annos.length?'replay':'dormant');
  }
}
function toggle(){setMode(!on);}

/* ================= 旧书签数据迁移（Master，一次性） ================= */
function maybeMigrate(){
  if(migrateChecked||annos.length)return;
  migrateChecked=true;
  try{
    var pk=KEY_PREFIX+location.pathname;
    var raw=localStorage.getItem(pk);
    if(!raw)return;
    var arr=JSON.parse(raw);
    if(!Array.isArray(arr)||!arr.length)return;
    if(confirm('检测到此页面有书签版标注数据（'+arr.length+' 条），迁移到扩展存储？\n（迁移后书签版在此页面将读不到旧数据）')){
      annos=sanitizeAnnos(arr);
      seq=annos.reduce(function(m,a){return Math.max(m,a.n||0);},0);
      elMap={};
      localStorage.setItem(pk,'[]');
      resetAndReplay(annos);
      toast('已迁移书签版标注',annos.length+' 条标注已迁入扩展存储（按完整 URL 分库）');
    }
  }catch(e){}
}

/* ================= SPA 软导航监听（Master） ================= */
function startWatch(){
  if(watchT)return;
  watchT=setInterval(function(){
    if(!booted||mode==='dormant')return;
    var k=KEY_PREFIX+location.href.split('#')[0];
    if(k===KEY)return;
    revertAllLocal();   // 先回滚旧 URL 的预览样式，再切库（旧标注不残留到新页面）
    KEY=k;
    (async function(){
      var got={};try{got=await chrome.storage.local.get(KEY);}catch(e){}
      var arr=[];try{arr=JSON.parse(got[KEY]||'[]');}catch(e){}
      annos=sanitizeAnnos(arr);
      seq=annos.reduce(function(m,a){return Math.max(m,a.n||0);},0);
      elMap={};
      scanFrames();
      if(!annos.length&&mode==='replay')applyMode('dormant');
      else applyMode(mode);
      notifyBadge();
    })();
  },500);
}

/* ================= 点选监听（Master/Child 共用） ================= */
var pickChordDown=false,lastHover=null,hlEls=[];
function addHl(el){if(!el||!el.classList)return;if(hlEls.indexOf(el)<0)hlEls.push(el);el.classList.add('pa-hl');}
function removeHl(el){var i=hlEls.indexOf(el);if(i>=0){hlEls.splice(i,1);el.classList.remove('pa-hl');}}
function clearHl(){hlEls.slice().forEach(removeHl);}
function exitPick(){if(pickChordDown){pickChordDown=false;document.body.classList.remove('pa-pick');clearHl();}}
function isPickChord(e){return !!(e&&e.ctrlKey&&e.altKey);}
function pickable(t){return isElementNode(t)&&!isToolUi(t);}
function eventTargetFromPath(e){var p=(e.composedPath&&e.composedPath())||[];for(var i=0;i<p.length;i++){if(pickable(p[i]))return p[i];}return pickable(e.target)?e.target:null;}
function targetFromPoint(x,y,fallback){var el=null;try{el=document.elementFromPoint(x,y);}catch(err){}if(pickable(el))return el;if(fallback&&document.contains(fallback)&&pickable(fallback))return fallback;return null;}
function getPickTarget(e){return eventTargetFromPath(e)||targetFromPoint(e.clientX,e.clientY,null);}
function blockNative(e){e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();}
function reportPick(target,x,y){
  if(isTop){
    var pl=buildPickPayload(target,[],x,y);pl.el=target;handlePick(pl);
  }else{
    var pl2=buildPickPayload(target,myPath,x,y);
    lastPick={el:target,chain:chainOf(target),clientX:x,clientY:y};
    postTop({type:'PA_PICK',payload:pl2});
  }
}
var lastPick=null;
function startPickFromDown(e){
  if(!isOn()||dialogOpen||!isPickChord(e))return;
  var target=getPickTarget(e);if(!target)return;
  blockNative(e);
  if(pendingPick)return;
  pendingPick={target:target,x:e.clientX,y:e.clientY};
  suppressPickClick=Date.now()+500;suppressPickX=e.clientX;suppressPickY=e.clientY;
  exitPick();
  setTimeout(function(){
    var p=pendingPick;pendingPick=null;if(!p)return;
    var target=targetFromPoint(p.x,p.y,p.target);
    if(target)reportPick(target,p.x,p.y);
    else if(isTop)toast('未能选中元素','页面结构刚刚变化，请再按 Ctrl + Alt 点击一次',1800);
  },0);
}
function bindPicking(){
  document.addEventListener('mousemove',function(e){lastHover=eventTargetFromPath(e)||e.target;},true);
  document.addEventListener('pointerdown',startPickFromDown,true);
  document.addEventListener('mousedown',startPickFromDown,true);
  document.addEventListener('click',function(e){
    if(isToolUi(e.target))return;
    if(suppressPickClick>Date.now()&&Math.abs(e.clientX-suppressPickX)<4&&Math.abs(e.clientY-suppressPickY)<4){blockNative(e);return;}
    if(!isOn()||dialogOpen||!isPickChord(e))return;
    var target=getPickTarget(e);if(!target)return;
    blockNative(e);var tx=e.clientX,ty=e.clientY;exitPick();
    reportPick(target,tx,ty);
  },true);
  document.addEventListener('mouseover',function(e){var target=eventTargetFromPath(e);if(isOn()&&!dialogOpen&&pickChordDown&&target)addHl(target);});
  document.addEventListener('mouseout',function(e){removeHl(eventTargetFromPath(e)||e.target);});
  window.addEventListener('keydown',function(e){if(isOn()&&!dialogOpen&&(e.key==='Alt'||e.key==='Control')&&isPickChord(e)){if(!pickChordDown){pickChordDown=true;document.body.classList.add('pa-pick');}if(pickable(lastHover))addHl(lastHover);}});
  window.addEventListener('keyup',function(e){if(e.key==='Alt'||e.key==='Control')exitPick();});
  window.addEventListener('blur',exitPick);
}
bindPicking();
window.addEventListener('scroll',scheduleRender,true);
window.addEventListener('resize',function(){
  scheduleRender();
  if(isTop)[fab,document.querySelector('.pa-dialog')].forEach(function(el){if(el&&el.style.left)clamp(el);});
});

/* ================= 拖动（Master） ================= */
function drag(handle,target){handle.addEventListener('mousedown',function(e){if(e.button!==0)return;var sx=e.clientX,sy=e.clientY;var r=target.getBoundingClientRect();var ox=r.left,oy=r.top;var moved=false;function mv(ev){if(Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>4){moved=true;target._drag=true;}if(moved){var nx=ox+ev.clientX-sx,ny=oy+ev.clientY-sy;var maxX=window.innerWidth-target.offsetWidth-6,maxY=window.innerHeight-target.offsetHeight-6;nx=Math.max(6,Math.min(nx,Math.max(6,maxX)));ny=Math.max(6,Math.min(ny,Math.max(6,maxY)));target.style.left=nx+'px';target.style.top=ny+'px';target.style.right='auto';target.style.bottom='auto';}}function up(){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);setTimeout(function(){target._drag=false;},0);}document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);});}

/* ================= 消息路由 ================= */
window.addEventListener('message',function(e){
  var d=e.data;
  if(!d||typeof d!=='object')return;
  var t=d.type;
  if(isTop){
    // 安全校验：帧消息的 source 必须是注册表里的已知 frame window（防伪造）
    function knownSrc(){var en=entryByWin(e.source);return en?(postToFrame(en.win,{type:'PA_FRAME_HELLO',token:TOKEN,path:en.path,depth:en.path.length+1}),en):null;}
    if(t==='PA_FRAME_PING'){if(!booted)return;if(!entryByWin(e.source))scheduleRescan();else knownSrc();}
    else if(t==='PA_FRAME_ACK'){
      if(!booted||!TOKEN||d.token!==TOKEN)return;
      var en2=entryByWin(e.source);
      if(!en2){
        // 嵌套帧（顶层扫描覆盖不到）：按子帧自报 path 动态登记（token 校验已保证可信）
        var p2=d.path||[];
        if(!p2.length)return;
        en2=registerNested(p2,e.source);
      }
      en2.ack=true;sendStateTo(en2);
    }
    else if(t==='PA_PICK'){if(!booted||!TOKEN||d.token!==TOKEN||!on||dialogOpen)return;var en3=entryByWin(e.source);if(!en3)return;d.payload.f=en3.path;handlePick(d.payload);}
    else if(t==='PA_PIN_CLICK'){if(!booted||!TOKEN||d.token!==TOKEN)return;if(!entryByWin(e.source))return;var nn=+d.n;if(on)editAnno(nn);else locateMark(nn);}
  }else{
    if(t==='PA_FRAME_HELLO'){
      TOKEN=d.token;myPath=(d.path||[]).slice();childDepth=d.depth||1;
      postTop({type:'PA_FRAME_ACK',path:myPath});
      if(childDepth<=4)walkFrames(myPath,childDepth);
      startChildObservers();
    }
    else if(t==='PA_STATE'){
      if(!TOKEN||d.token!==TOKEN)return;
      masterMode=d.mode||'replay';
      resetAndReplay(sanitizeAnnos(d.annos||[]));
      ensureLayer();
      if(masterMode==='active'){renderMarks();}
      else{revertAllLocal();exitPick();}
    }
    else if(t==='PA_FLAGS'){if(!TOKEN||d.token!==TOKEN)return;dialogOpen=!!d.dialogOpen;}
    else if(t==='PA_PREVIEW'){
      if(!TOKEN||d.token!==TOKEN)return;
      var a=(d.n!=null)?byN(d.n):null;
      var el=a?resolveEl(a):(lastPick&&lastPick.el);
      if(!el)return;
      if(d.op==='apply'){
        restoreInlineStyle(el,d.inlineBase);
        PROPS.forEach(function(p){if(String(d.now[p.k])!==String(d.base[p.k]))el.style[p.k]=(d.now[p.k]==null?(p.k==='backgroundColor'?'transparent':''):d.now[p.k]);});
        if(d.editableText&&d.now.text!=null&&d.now.text!==d.base.text)el.textContent=d.now.text;
        if(d.editableValue&&d.now.value!=null&&d.now.value!==d.base.value)el.value=d.now.value;
      }else if(d.op==='revert'){
        restoreInlineStyle(el,d.inlineBase);
        if(d.editableText&&d.base.text!=null)el.textContent=d.base.text;
        if(d.editableValue&&d.base.value!=null)el.value=d.base.value;
      }else if(d.op==='restore'&&a){
        applyStored(a);
      }
    }
    else if(t==='PA_RETARGET'){
      if(!TOKEN||d.token!==TOKEN||!lastPick)return;
      var ne=lastPick.chain[+d.index];
      if(!ne)return;
      lastPick.el=ne;lastPick.chain=chainOf(ne);
      flashTarget(ne);
      postTop({type:'PA_PICK',payload:buildPickPayload(ne,myPath,lastPick.clientX,lastPick.clientY)});
    }
    else if(t==='PA_HIGHLIGHT'){if(!TOKEN||d.token!==TOKEN)return;highlightMark(+d.n,!!d.hot);}
    else if(t==='PA_LOCATE'){if(!TOKEN||d.token!==TOKEN)return;locateMark(+d.n);}
  }
});

/* ================= 子帧观察器（握手后启动） ================= */
var childObserved=false;
function startChildObservers(){
  if(childObserved||isTop)return;
  childObserved=true;
  if(window.MutationObserver){try{new MutationObserver(function(){scheduleRescan();}).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}}
}
/* 子帧就绪后主动 ping 一次（覆盖内容脚本晚于 Master 扫描注入的时序） */
if(!isTop){try{window.top.postMessage({type:'PA_FRAME_PING'},'*');}catch(e){}}

/* ================= Master 观察器 / 激活通道 ================= */
if(isTop){
  if(window.MutationObserver){try{var moT=0;new MutationObserver(function(){clearTimeout(moT);moT=setTimeout(function(){if(booted)scheduleRescan();},250);}).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}}
  if(chrome.runtime&&chrome.runtime.onMessage){
    chrome.runtime.onMessage.addListener(function(msg){
      if(msg&&msg.type==='PA_ACTIVATE'&&isTop)toggle();
    });
  }
}

/* ================= 启动 ================= */
(async function init(){
  if(!isTop)return;   // 子帧被动等待 HELLO，零 DOM 接触
  var got={};
  try{got=await chrome.storage.local.get(KEY);}catch(e){}
  var arr=[];
  try{arr=JSON.parse(got[KEY]||'[]');}catch(e){}
  annos=sanitizeAnnos(arr);
  seq=annos.reduce(function(m,a){return Math.max(m,a.n||0);},0);
  if(annos.length){
    buildUi();startWatch();scanFrames();
    applyAll();applyMode('replay');broadcastState();
  }
  /* 无数据 → 保持 DORMANT：仅上面的消息监听在工作，零 DOM 接触 */
})();
})();
