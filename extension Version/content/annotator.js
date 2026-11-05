// 原型标注工具 · Chrome/Edge MV3 扩展版 v1.0
// 架构：内容脚本注入所有 frame（all_frames + match_origin_as_fallback，隔离世界，免疫页面 CSP）。
//   top frame = Master：唯一 UI（浮窗/清单/编辑弹窗/toast/提示条）、chrome.storage 持久化、
//   frame 注册表与消息路由（window.postMessage + token 握手，跨域 iframe 可达）。
//   子 frame = Child：本地渲染属于自己的标注（f 路径匹配本帧），本地点选/悬停/预览回滚，
//   派生数据（选择器/摘要/样式快照）在本帧算好后经 postMessage 上报 Master。
//   元素针脚在各帧文档内以本地坐标渲染；截图针脚需要跨帧换算（见 shotPosOf）。
// 休眠策略：页面无标注且未激活时不创建任何工具 UI；点选监听仍然常驻（不产生 DOM）。
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
function cleanAnno(a,i){
  if(a&&typeof a==='object'&&a.kind==='shot')return cleanShotAnno(a,i);
  if(!a||typeof a!=='object')return null;var base=cleanStyleObj(a.base),now=cleanStyleObj(a.now);if(!base||!now)return null;var n=parseInt(a.n,10);if(!isFinite(n)||n<1)n=i+1;var mode=a.mode==='tweak'?'tweak':'note';var type=(a.type&&typeof a.type==='object')?{key:cleanStr(a.type.key,24),label:cleanStr(a.type.label,32),tag:cleanStr(a.type.tag,24)}:null;var fsrc=Array.isArray(a.f)?a.f:[],fout=[];for(var fi=0;fi<fsrc.length&&fi<8;fi++){var fv=parseInt(fsrc[fi],10);if(isFinite(fv)&&fv>=0)fout.push(fv);else break;}return {kind:'element',n:n,x:parseInt(a.x,10)||0,y:parseInt(a.y,10)||0,f:fout,sel:cleanStr(a.sel,500),ctx:cleanStr(a.ctx||'页面',80),summ:cleanStr(a.summ,160),type:type,mode:mode,text:cleanStr(a.text,1200),base:base,now:now,inlineBase:cleanInlineBase(a.inlineBase)};}
// 截图标注：img 为裁剪后的 PNG dataURL（上限 3.5MB），region 为文档坐标锚点，anchor 为邻近元素定位（可空）
function cleanShotAnno(a,i){
  var n=parseInt(a.n,10);if(!isFinite(n)||n<1)n=i+1;
  var img=String(a.img||'');
  if(!/^data:image\/png;base64,[A-Za-z0-9+\/=\s]+$/.test(img)||img.length>3500000)return null;
  var r=(a.region&&typeof a.region==='object')?a.region:{},rx=Math.round(+r.x),ry=Math.round(+r.y),rw=Math.round(+r.w),rh=Math.round(+r.h);
  if(!isFinite(rx)||!isFinite(ry)||!isFinite(rw)||!isFinite(rh)||rw<8||rh<8||rw>30000||rh>30000)return null;
  var v=(a.vp&&typeof a.vp==='object')?a.vp:{},vw=Math.round(+v.w),vh=Math.round(+v.h),vd=+v.dpr;
  if(!isFinite(vw)||!isFinite(vh)||vw<50||vh<50||!isFinite(vd)||vd<0.5||vd>6)return null;
  var an=null;
  if(a.anchor&&typeof a.anchor==='object'){
    var t=a.anchor.type,fp=[];
    if(Array.isArray(a.anchor.framePath)){for(var fi=0;fi<a.anchor.framePath.length&&fi<8;fi++){var fv=parseInt(a.anchor.framePath[fi],10);if(isFinite(fv)&&fv>=0)fp.push(fv);else break;}}
    an={sel:cleanStr(a.anchor.sel,500),summ:cleanStr(a.anchor.summ,160),ctx:cleanStr(a.anchor.ctx||'页面',80),type:(t&&typeof t==='object')?{key:cleanStr(t.key,24),label:cleanStr(t.label,32),tag:cleanStr(t.tag,24)}:null};
    if(fp.length)an.framePath=fp;
  }
  return {kind:'shot',n:n,x:rx,y:ry,f:[],ctx:cleanStr((a.ctx||(a.anchor&&a.anchor.ctx)||'截图区域'),80),text:cleanStr(a.text,1200),img:img,region:{x:rx,y:ry,w:rw,h:rh},vp:{w:vw,h:vh,dpr:vd},anchor:an,anchorOffset:cleanAnchorOffset(a.anchorOffset),shotScroll:cleanShotScroll(a.shotScroll)};
}
function cleanShotScroll(o){
  if(!o||typeof o!=='object')return null;
  var wx=+o.wx,wy=+o.wy;
  if(!isFinite(wx)||!isFinite(wy))return null;
  var frames=[];
  if(Array.isArray(o.frames)){for(var i=0;i<o.frames.length&&i<8;i++){var v=parseInt(o.frames[i],10);if(isFinite(v)&&v>=0)frames.push(v);else break;}}
  return {wx:Math.round(wx),wy:Math.round(wy),frames:frames};
}
function cleanAnchorOffset(o){
  if(!o||typeof o!=='object')return null;
  var x=Math.round(+o.x),y=Math.round(+o.y);
  if(!isFinite(x)||!isFinite(y)||Math.abs(x)>50000||Math.abs(y)>50000)return null;
  return {x:x,y:y};
}
// 从当前 KEY 读回标注并重算编号（init 与 SPA 切库共用）
async function loadAnnosFromStorage(){
  var got={};
  try{got=await chrome.storage.local.get(KEY);}catch(e){}
  var arr=[];
  try{arr=JSON.parse(got[KEY]||'[]');}catch(e){}
  annos=sanitizeAnnos(arr);
  seq=annos.reduce(function(m,a){return Math.max(m,a.n||0);},0);
  return annos;
}
function sanitizeAnnos(v){if(!Array.isArray(v))return[];var out=[],used={};v.forEach(function(a,i){var c=cleanAnno(a,i);if(!c)return;while(used[c.n])c.n++;used[c.n]=true;out.push(c);});return out;}
function byN(n){var a=null;annos.forEach(function(x){if(x.n===n)a=x;});return a;}
function cssEsc(s){return (window.CSS&&CSS.escape)?CSS.escape(s):String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&');}
function selOf(el){if(!el||el.nodeType!==1)return'';if(el.id)return'#'+cssEsc(el.id);var p=[],c=el,guard=0;while(c&&c.nodeType===1&&c!==document.documentElement&&guard<30){if(c.id){p.unshift('#'+cssEsc(c.id));break;}var s=c.tagName.toLowerCase();var par=c.parentElement;if(par){var sib=Array.prototype.filter.call(par.children,function(x){return x.tagName===c.tagName;});if(sib.length>1)s+=':nth-of-type('+(sib.indexOf(c)+1)+')';}p.unshift(s);c=par;guard++;}return p.join('>');}
function resolveEl(a){
  if(a&&a.kind==='shot')return null;  // 截图标注无 DOM 目标（region 像素锚点）
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
function applyStored(a){if(!a||a.kind==='shot')return;if(!a.sel||!a.now||!a.base)return;var el=resolveEl(a);if(!el)return;PROPS.forEach(function(p){if(String(a.now[p.k])!==String(a.base[p.k]))el.style[p.k]=(a.now[p.k]==null?(p.k==='backgroundColor'?'transparent':''):a.now[p.k]);});if(a.now.text!=null&&a.now.text!==a.base.text&&el.children.length===0)el.textContent=a.now.text;if(a.now.value!=null&&a.now.value!==a.base.value&&isFormValueEl(el))el.value=a.now.value;}
function restoreStoredElement(el,a){if(!el||!a||a.kind==='shot')return;restoreAnnoStyle(el,a);if(a.now&&a.base&&a.now.text!=null&&a.now.text!==a.base.text&&el.children.length===0)el.textContent=a.base.text;if(a.now&&a.base&&a.now.value!=null&&a.now.value!==a.base.value&&isFormValueEl(el))el.value=a.base.value;}
function resetAndReplay(nextAnnos){var old=annos.slice(),seen=[],groups=[];old.forEach(function(a){var el=resolveEl(a);if(!el)return;if(seen.indexOf(el)<0){seen.push(el);groups.push({el:el,a:a});}});groups.forEach(function(g){restoreStoredElement(g.el,g.a);});annos=nextAnnos||[];annos.forEach(applyStored);save();renderAll();}
// 回滚本帧所有被标注元素到原始状态（关闭标注模式时页面恢复原始 HTML）
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
var freePick=false;   // 自由点选：单击即选中，无需 Ctrl+Alt（Master 拥有，经 PA_FLAGS 广播）
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
function sendFlags(){if(!isTop||!booted)return;Object.keys(frameRegistry).forEach(function(k){var en=frameRegistry[k];if(en.ack&&en.win)postToFrame(en.win,{type:'PA_FLAGS',token:TOKEN,dialogOpen:dialogOpen,freePick:freePick});});}
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
function scanFrames(){if(!TOKEN)TOKEN=genToken();walkFrames([],1);watchFrameScrolls();}
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
  var el=chain[chain.length-1]||null;
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
// 重绘后让指定针脚闪烁一次（定位反馈）
function flashMark(n,delay){
  setTimeout(function(){
    renderMarks();
    if(!layer)return;
    var t=layer.querySelector('.pa-box[data-n="'+n+'"]')||layer.querySelector('.pa-badge[data-n="'+n+'"]');
    if(!t)return;
    t.classList.add('flash');
    setTimeout(function(){t.classList.remove('flash');},1000);
  },delay);
}
function locateLocal(n){
  var a=byN(n);if(!a)return;
  if(a.kind==='shot'){
    // 截图标注：滚动到区域中心再闪烁
    var cx=a.region.x+a.region.w/2,cy=a.region.y+a.region.h/2;
    var vx=cx-window.scrollX,vy=cy-window.scrollY;
    var inView=vx>=0&&vx<=window.innerWidth&&vy>=0&&vy<=window.innerHeight;
    if(!inView)window.scrollTo({left:Math.max(0,cx-window.innerWidth/2),top:Math.max(0,cy-window.innerHeight/2),behavior:'smooth'});
    flashMark(n,inView?0:420);
    return;
  }
  var el=resolveEl(a);
  if(el&&el.scrollIntoView)el.scrollIntoView({block:'center',inline:'nearest',behavior:'smooth'});
  flashMark(n,el?360:0);
}
function locateMark(n){
  var a=byN(n);if(!a)return;
  if(isTop&&a.f&&a.f.length){var en=frameRegistry[a.f.join(',')];if(en&&en.win){postToFrame(en.win,{type:'PA_LOCATE',n:n});return;}}
  locateLocal(n);
}
function flashTarget(el){var anchor=el?visibleAnchor(el):null;if(!anchor||!anchor.getBoundingClientRect)return;var r=anchor.getBoundingClientRect();if(!(r.width||r.height))return;var box=markUi(document.createElement('div'));box.className='pa-box retarget flash';box.style.left=(r.left+window.scrollX)+'px';box.style.top=(r.top+window.scrollY)+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';['tl','tr','bl','br'].forEach(function(cc){var cn=document.createElement('div');cn.className='pa-corner '+cc;box.appendChild(cn);});ensureLayer();if(layer)layer.appendChild(box);setTimeout(function(){if(box.parentNode)box.parentNode.removeChild(box);},1050);}
// 滚动量快照：window 滚动 + 各级 iframe 内部滚动（逐级累加）。
// 截图框用它做差值校正，位置不再依赖锚点元素。
function snapshotScrollFor(framePath){
  var out={wx:window.scrollX||0,wy:window.scrollY||0,frames:[]};
  var cdoc=document;
  for(var i=0;i<(framePath||[]).length;i++){
    var f=cdoc.querySelectorAll('iframe')[framePath[i]];
    if(!f)break;
    out.frames.push(framePath[i]);
    var inner=null;try{inner=f.contentDocument;}catch(e){}
    if(!inner)break;
    cdoc=inner;
  }
  return out;
}
// 当前滚动量（与快照同结构），用于差值校正
function currentScrollFor(framePath){
  var out={x:0,y:0},cdoc=document;
  out.x=window.scrollX||0;out.y=window.scrollY||0;
  for(var i=0;i<(framePath||[]).length;i++){
    var f=cdoc.querySelectorAll('iframe')[framePath[i]];
    if(!f)return null;
    var cwin=null,inner=null;
    try{cwin=f.contentWindow;inner=f.contentDocument;}catch(e){}
    if(!cwin||!inner)return null;
    out.x+=cwin.scrollX||0;out.y+=cwin.scrollY||0;
    cdoc=inner;
  }
  return out;
}
// 截图框当前位置。按可靠性依次尝试：
//  1) 锚点元素（最准确）：锚点跟着内容走，主文档内层滚动与 iframe 内滚动都能对齐
//     · 锚点在主文档 → 视口位置 + 相对偏移 + window.scrollY
//     · 锚点在 iframe 内 → iframe 顶层位置 + 帧内元素位置 + 偏移
//  2) 滚动量差值：截图时记下 window + 各级 iframe 的滚动量，按差值校正原坐标（锚点失效时用）
//  3) 都失效 → 退回存储的文档坐标
function shotPosOf(a){
  var fallback={x:a.region.x,y:a.region.y};
  // 1) 锚点方案（最准确）：锚点元素跟随任意祖先滚动容器，主文档/iframe 内都成立
  if(a.anchor&&a.anchor.sel&&a.anchorOffset){
    var fp=a.anchor.framePath||[];
    if(fp.length){
      var base=frameRectOf(fp);
      if(base){
        var cdoc=document,okChain=true;
        for(var i=0;i<fp.length;i++){
          var f=cdoc.querySelectorAll('iframe')[fp[i]];
          if(!f){okChain=false;break;}
          try{cdoc=f.contentDocument;}catch(e){okChain=false;break;}
          if(!cdoc){okChain=false;break;}
        }
        if(okChain){
          var iel=null;try{iel=cdoc.querySelector(a.anchor.sel);}catch(e){}
          if(iel&&iel.getClientRects().length){
            var ir=iel.getBoundingClientRect();
            return {x:base.x+ir.left+a.anchorOffset.x+window.scrollX,y:base.y+ir.top+a.anchorOffset.y+window.scrollY};
          }
        }
      }
    }else{
      var el=null;
      try{el=document.querySelector(a.anchor.sel);}catch(e){}
      if(el&&el.isConnected){
        var r=el.getBoundingClientRect();
        if(r.width||r.height)return {x:r.left+a.anchorOffset.x+window.scrollX,y:r.top+a.anchorOffset.y+window.scrollY};
      }
    }
  }
  // 2) 兜底：window + 各级 iframe 的滚动量差值（锚点已失效时）
  var sc=a.shotScroll;
  if(sc){
    var now=currentScrollFor(sc.frames||[]);
    if(now)return {x:a.region.x-(now.x-sc.wx),y:a.region.y-(now.y-sc.wy)};
  }
  return fallback;
}
function renderMarks(){
  if(!layer)return;
  // 关闭标注时页面保持原始 HTML：滚动/resize 触发的重绘不得把针脚画回来
  if(isTop?!(mode==='active'):!(masterMode==='active')){layer.innerHTML='';return;}
  layer.innerHTML='';
  annos.forEach(function(a){
    // 子帧标注由子帧自己渲染（坐标是该帧局部坐标）；主帧渲染会造成重复针脚且位置错误
    if(isTop&&a.f&&a.f.length)return;
    if(a.kind==='shot'){
      // 截图标注：优先按锚点元素反算位置（跟随任意滚动容器与布局变化）；
      // 锚点已失效时退回存储的文档坐标。
      var pos=shotPosOf(a);
      var box2=markUi(document.createElement('div'));box2.className='pa-box pa-shot-region';box2.setAttribute('data-n',a.n);
      box2.style.left=pos.x+'px';box2.style.top=pos.y+'px';box2.style.width=a.region.w+'px';box2.style.height=a.region.h+'px';
      layer.appendChild(box2);
      var badge2=markUi(document.createElement('div'));badge2.className='pa-badge';badge2.setAttribute('data-n',a.n);badge2.textContent=a.n;
      badge2.title=(a.text||'')+'（截图标注）';
      badge2.style.left=pos.x+'px';badge2.style.top=pos.y+'px';
      badge2.onclick=function(e){e.stopPropagation();if(isTop){if(on)editAnno(a.n);else locateMark(a.n);}else postTop({type:'PA_PIN_CLICK',n:a.n});};
      badge2.onmouseenter=function(){highlightMark(a.n,true);};
      badge2.onmouseleave=function(){highlightMark(a.n,false);};
      layer.appendChild(badge2);
      return;
    }
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
  +'<div class="pa-modes"><button class="pa-mb pa-mb-pick" title="自由点选：单击元素直接标注，无需快捷键；Esc 退出"><span class="pa-mbi">⌖</span>点选</button><button class="pa-mb pa-mb-shot" title="截图标注：框选或单击选中区域，截图后写修改意见"><span class="pa-mbi">⛶</span>截图</button></div>'
  +'<div class="pa-panel"><div class="pa-phead"><span class="pa-ptitle">📋 标注清单</span><span class="pa-cnt">0</span></div><div class="pa-body"></div><div class="pa-foot"><span class="pa-fmt"><button class="pa-fmtb pa-fmt-md act" title="Markdown：人读，适合粘贴聊天窗口">MD</button><button class="pa-fmtb pa-fmt-json" title="JSON：结构化，适合 Claude Code 文件工作流">JSON</button></span><button class="pri pa-copy">📋 复制给 AI</button><button class="pa-clr">清空</button></div></div>';
  document.body.appendChild(fab);
  btn=fab.querySelector('.pa-toggle');
  panel=fab.querySelector('.pa-panel');
  // 开关只在滑块区域触发；整条标题栏用于拖动
  fab.querySelector('.pa-sw').onclick=function(e){e.stopPropagation();if(fab._drag)return;setMode(!on);};
  fab.querySelector('.pa-mb-pick').onclick=function(e){e.stopPropagation();if(fab._drag)return;toggleFreePick();};
  fab.querySelector('.pa-mb-shot').onclick=function(e){e.stopPropagation();if(fab._drag)return;if(!on)return;enterShotMode();};
  panel.querySelector('.pa-copy').onclick=function(e){e.stopPropagation();copyOut();};
  panel.querySelector('.pa-fmt-md').onclick=function(e){e.stopPropagation();expFmt='md';panel.querySelector('.pa-fmt-md').classList.add('act');panel.querySelector('.pa-fmt-json').classList.remove('act');};
  panel.querySelector('.pa-fmt-json').onclick=function(e){e.stopPropagation();expFmt='json';panel.querySelector('.pa-fmt-json').classList.add('act');panel.querySelector('.pa-fmt-md').classList.remove('act');};
  panel.querySelector('.pa-clr').onclick=function(e){e.stopPropagation();if(confirm('清空全部标注？')){seq=0;elMap={};resetAndReplay([]);}};
  drag(btn,fab);drag(panel.querySelector('.pa-phead'),fab);

  replayBar=markUi(document.createElement('div'));replayBar.className='pa-replay-bar';replayBar.style.display='none';
  replayBar.innerHTML='<span class="pa-rb-ico">⌖</span><span class="pa-rb-txt">本页有 <b class="pa-rb-n">0</b> 条标注<i>· 开启后显示</i></span><button class="pa-rb-btn">进入编辑</button>';
  document.body.appendChild(replayBar);
  replayBar.querySelector('.pa-rb-btn').onclick=function(){setMode(true);};
}
function renderList(){
  var body=panel.querySelector('.pa-body');var cnt=fab.querySelector('.pa-cnt');
  cnt.textContent=annos.length;cnt.style.display=annos.length?'inline-block':'none';
  if(!annos.length){body.innerHTML='';return;}
  var g={};annos.forEach(function(a){var k=a.ctx||'页面';(g[k]=g[k]||[]).push(a);});
  var html='';
  Object.keys(g).forEach(function(k){
    html+='<div class="pa-grp">'+esc(k)+'</div>';
    g[k].forEach(function(a){
      var ty=a.type?a.type.label:'';
      var fm=(a.f&&a.f.length)?'<span class="pa-fm" title="位于 iframe 内部">iframe</span> ':'';
      if(a.kind==='shot'){
        var main=a.text||'(空)';
        html+='<div class="pa-item pa-item-shot" data-n="'+a.n+'"><span class="pa-n">'+a.n+'</span><span class="pa-thumb"><img alt="" data-thumb="'+a.n+'"></span><span class="pa-tx"><span class="pa-shot-tag">📷 截图</span>'+esc(main)+'</span><span class="pa-act"><span data-img="'+a.n+'" title="复制图片到剪贴板">🖼</span><span data-ed="'+a.n+'" title="编辑意见">✎</span><span data-del="'+a.n+'" title="删除">🗑</span></span></div>';
      }else{
        var main=(a.mode==='note')?(a.text||'(空)'):(chSummary(a)||'(空)');
        html+='<div class="pa-item" data-n="'+a.n+'"><span class="pa-n">'+a.n+'</span><span class="pa-tx">'+fm+esc(main)+'<span class="pa-summ">'+(ty?'<b style="color:#FF8A7A">'+esc(ty)+'</b> · ':'')+'“'+esc(a.summ)+'”</span></span><span class="pa-act"><span data-ed="'+a.n+'" title="编辑">✎</span><span data-del="'+a.n+'" title="删除">🗑</span></span></div>';
      }
    });
  });
  body.innerHTML=html;
  Array.prototype.forEach.call(body.querySelectorAll('[data-thumb]'),function(im){
    var a=byN(+im.getAttribute('data-thumb'));
    if(a&&a.img)im.src=a.img;
  });
  Array.prototype.forEach.call(body.querySelectorAll('.pa-item'),function(row){
    var n=+row.getAttribute('data-n');
    row.onmouseenter=function(){highlightMark(n,true);};
    row.onmouseleave=function(){highlightMark(n,false);};
    row.onclick=function(){locateMark(n);};
  });
  Array.prototype.forEach.call(body.querySelectorAll('[data-img]'),function(x){x.onclick=function(e){e.stopPropagation();copyShotImage(byN(+x.getAttribute('data-img')));};});
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
function defaultDialogPos(){return {x:Math.max(6,window.innerWidth/2-170),y:Math.max(6,window.innerHeight/2-200)};}
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
  if(mode2==='note'){if(noteEl)noteEl.focus();}else{var tf=d.querySelector('.pa-c-text')||d.querySelector('.pa-c-value');if(tf)tf.focus();else{d.tabIndex=-1;d.style.outline='none';if(d.focus)d.focus();}}

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
  if(!en)return defaultDialogPos();
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
  if(!ok)return defaultDialogPos();
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
      annos.push({kind:'element',n:seq,x:p.x,y:p.y,f:(payload.f||[]).slice(),sel:payload.sel,ctx:payload.ctx,summ:payload.summ,type:{key:payload.type.key,label:payload.type.label,tag:payload.type.tag},mode:data.mode,text:data.note,base:data.base,now:data.now,inlineBase:data.inlineBase});
      if(ref.local&&ref.el)elMap[seq]=ref.el;
      resetAndReplay(annos);
    }});
}
function editAnno(n){
  if(!on)return;var a=byN(n);if(!a)return;
  if(a.kind==='shot'){
    // 截图标注：仅改意见（复用截图编辑窗，img/region 不变）
    openShotEditor(a.region,a.img,a.vp,a);
    return;
  }
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
  var dp=defaultDialogPos(),cx=dp.x,cy=dp.y;
  openEditor({anno:a,num:a.n,title:'编辑标注',ctx:a.ctx,summ:a.summ,type:type,payload:{},ref:ref,editableText:editableText,editableValue:editableValue,hasStyle:ref.local?!!ref.el:true,chain:[],note:a.text||'',px:cx,py:cy,
    onSave:function(data){
      var has=(data.mode==='note')?!!data.note:changed(data.base,data.now);
      if(!has){resetAndReplay(annos.filter(function(x){return x.n!==n;}));return;}
      a.mode=data.mode;a.text=data.note;a.base=data.base;a.now=data.now;a.inlineBase=data.inlineBase;resetAndReplay(annos);
    }});
}

/* ================= 导出 / 复制 / toast（Master） ================= */
function selTextOf(a){if(a.f&&a.f.length){var p=[];a.f.forEach(function(i){p.push('iframe#'+(i+1));});return p.join(' >> ')+' >> '+(a.sel||'');}return a.sel||'';}
// 导出时 live 富化：元素仍在则取完整文本与 outerHTML 片段（iframe 条目 top 侧解析不到，退回存储摘要）
function liveEnrich(a){
  if(a.f&&a.f.length||a.kind==='shot')return null;
  var el=null;try{el=resolveEl(a);}catch(e){}
  if(!el)return null;
  return {text:(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,200)||null,html:(el.outerHTML||'').slice(0,300)||null};
}
function chStylesOf(a){var sp=[];if(!a.now||!a.base)return sp;PROPS.forEach(function(pr){if(String(a.now[pr.k])!==String(a.base[pr.k]))sp.push({css:pr.css,from:a.base[pr.k]==null?'transparent':a.base[pr.k],to:a.now[pr.k]==null?'transparent':a.now[pr.k]});});return sp;}
function exportMd(){if(!annos.length)return'（无标注）';var g={};annos.forEach(function(a){(g[a.ctx||'页面']=g[a.ctx||'页面']||[]).push(a);});var md='【原型标注清单】共 '+annos.length+' 条';Object.keys(g).forEach(function(k){md+='\n\n## '+k;g[k].forEach(function(a){
  if(a.kind==='shot'){
    md+='\n- ['+a.n+'] 截图标注：'+((a.text||'(空)'));
    if(a.anchor)md+='\n    · 邻近元素：“'+a.anchor.summ+'” · 选择器：'+(a.anchor.sel||'（无）');
    md+='\n    · 图片：复制这张截图粘贴即可（图中已标注编号 '+a.n+'）';
    return;
  }
  var ty=a.type?(a.type.label+' <'+a.type.tag+'>'):'';var cs=chSummary(a);md+='\n- ['+a.n+'] '+(a.mode==='note'?(a.text||'(空)'):(cs?'【微调】 '+cs:'(空)'));md+='\n    · 元素：'+(ty?ty+' · ':'')+'“'+a.summ+'” · 选择器：'+selTextOf(a);
  var live=liveEnrich(a);
  if(live&&live.text)md+='\n    · 文本锚点：“'+live.text+'”';
  if(live&&live.html)md+='\n    · HTML：`'+live.html.replace(/[`\n]/g,' ')+'`';
  if(a.x||a.y)md+='\n    · 位置：x='+a.x+', y='+a.y+'（文档坐标）';
  if(a.mode!=='note'&&a.now&&a.base){if(a.now.text!=null&&String(a.now.text)!==String(a.base.text))md+='\n    · 文案："'+a.base.text+'" → "'+a.now.text+'"';if(a.now.value!=null&&String(a.now.value)!==String(a.base.value))md+='\n    · 内容："'+a.base.value+'" → "'+a.now.value+'"';var sp=[];PROPS.forEach(function(pr){if(String(a.now[pr.k])!==String(a.base[pr.k]))sp.push(pr.css+' '+(a.base[pr.k]==null?'transparent':a.base[pr.k])+' → '+(a.now[pr.k]==null?'transparent':a.now[pr.k]));});if(sp.length)md+='\n    · 样式：'+sp.join('；');}});});return md;}
function exportJson(){
  var out={tool:'proto-anno',version:2,count:annos.length,annotations:[]};
  annos.forEach(function(a){
    if(a.kind==='shot'){
      out.annotations.push({id:a.n,kind:'shot',section:a.ctx||null,comment:a.text||'',
        imageLabel:'#'+a.n+' '+(a.anchor&&a.anchor.summ?a.anchor.summ:'截图区域'),
        nearElement:a.anchor?{selector:a.anchor.sel,text:a.anchor.summ,tag:a.anchor.type&&a.anchor.type.tag}:null,region:a.region});
      return;
    }
    var live=liveEnrich(a);
    var item={id:a.n,kind:'element',section:a.ctx||null,
      target:{selector:selTextOf(a),framePath:(a.f||[]).slice(),tag:a.type&&a.type.tag,
        text:live&&live.text?live.text:a.summ,
        outerHTML:live&&live.html?live.html:null,
        pin:{x:a.x||0,y:a.y||0}},
      mode:a.mode,comment:a.mode==='note'?(a.text||''):'',changes:{}};
    if(a.mode!=='note'&&a.now&&a.base){
      if(a.now.text!=null&&String(a.now.text)!==String(a.base.text))item.changes.text={from:a.base.text,to:a.now.text};
      if(a.now.value!=null&&String(a.now.value)!==String(a.base.value))item.changes.value={from:a.base.value,to:a.now.value};
      var st=chStylesOf(a);if(st.length)item.changes.styles=st;
    }
    out.annotations.push(item);
  });
  return JSON.stringify(out,null,2);
}
function copyText(text,ok,fail){function fallback(){var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;left:-9999px;top:0;';document.body.appendChild(ta);ta.focus();ta.select();var done=false;try{done=document.execCommand('copy');}catch(e){}ta.remove();return done;}if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(function(){if(ok)ok();},function(){if(fallback()){if(ok)ok();}else if(fail)fail();});}else{if(fallback()){if(ok)ok();}else if(fail)fail();}}
var expFmt='md';   // 导出格式：'md' | 'json'（仅内存态）
function copyOut(){
  if(!annos.length){toast('还没有标注','点击页面元素或截图区域即可添加');return;}
  var isJson=(expFmt==='json');
  var text=isJson?exportJson():exportMd();
  var shots=annos.filter(function(a){return a.kind==='shot';}).length;
  var sub=isJson?'JSON 已复制，可直接粘贴给 AI':'清单已复制'+(shots?'；另有 '+shots+' 张截图，点条目 🖼 复制后粘贴（图上带编号）':'，可直接粘贴给 AI');
  copyText(text,function(){toast('已复制 '+annos.length+' 条标注',sub,3000);},function(){toast('复制失败','请手动选中导出内容复制');});
}
function toast(title,sub,duration){
  if(!isTop||!document.body)return;
  var t=document.querySelector('.pa-toast');
  if(!t){t=markUi(document.createElement('div'));t.className='pa-toast';document.body.appendChild(t);}else markUi(t);
  t.innerHTML='<span class="pa-ti">⌖</span><span class="pa-tt"><b>'+esc(title)+'</b>'+(sub?'<i>'+esc(sub)+'</i>':'')+'</span>';
  void t.offsetWidth;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove('show');},duration||3800);
}

/* ================= 模式切换（Master） ================= */
// active = 编辑（UI+点选+预览样式+针脚）；replay / dormant = 关闭态：恢复原始 HTML，
// 不显示任何针脚、不应用任何样式预览（关掉开关就要看到页面本来的样子）。
function applyMode(m){
  mode=m;on=(m==='active');
  if(!booted&&m!=='dormant')buildUi();
  if(!booted)return;
  if(!on&&freePick){freePick=false;document.body.classList.remove('pa-free');}
  document.body.classList.toggle('pa-on',on);
  btn.classList.toggle('on',on);
  fab.querySelector('.pa-state').textContent=on?'ON':'OFF';
  fab.style.display=on?'block':'none';
  syncModeBar();
  closeDialog(true);exitPick();exitShotMode();
  if(on){
    // 只有开启标注时才呈现结果：应用样式微调 + 渲染针脚
    applyAll();renderAll();
    if(layer)layer.style.display='block';
  }else{
    // 关闭（replay/dormant）：页面恢复原始 HTML——回滚样式微调、清空针脚层
    revertAllLocal();
    if(layer){layer.innerHTML='';layer.style.display='none';}
  }
  updatePanel();broadcastState();sendFlags();
}
function setMode(v){
  if(!isTop)return;
  if(v){
    buildUi();startWatch();maybeMigrate();scanFrames();
    applyMode('active');
    var fs=frameSummary();
    toast('标注模式已开启','按住 Ctrl + Alt 点击元素，或点 🎯 自由点选后单击标注'+(fs?'（含 iframe 内元素）':''),2600);
  }else{
    applyMode(annos.length?'replay':'dormant');
  }
}
function toggle(){setMode(!on);}
function toggleFreePick(){
  if(!isTop)return;
  if(freePick){endFreePick();return;}
  freePick=true;
  document.body.classList.add('pa-free');
  syncModeBar();sendFlags();
  toast('自由点选已开启','鼠标悬停高亮元素，单击即标注一次；Esc 退出',2200);
}
// 结束自由点选：Master 走完整流程并广播；子帧只做本地清态（Master 的 PA_FLAGS 会同步过来）
function endFreePick(){
  if(isTop){
    if(!freePick){clearHl();return;}
    freePick=false;
    document.body.classList.remove('pa-free');
    clearHl();
    syncModeBar();sendFlags();
  }else{
    if(!freePick)return;
    freePick=false;
    document.body.classList.remove('pa-free');
    clearHl();
  }
}
/* ================= 截图标注模式（Master/top frame） ================= */
var shotMask=null,shotBox=null,shotSnap=null,shotActive=false,shotDrag=null;

function enterShotMode(){
  if(!isTop||!on)return;
  if(freePick)toggleFreePick();   // 与自由点选互斥
  exitShotMode();
  shotActive=true;document.body.classList.add('pa-shot');
  syncModeBar();
  shotMask=markUi(document.createElement('div'));shotMask.className='pa-shot-mask';
  shotMask.innerHTML='<div class="pa-shot-hint"><b>📷 截图标注</b><i>拖动框选区域 · 单击选中元素 · Esc 取消</i></div>';
  document.body.appendChild(shotMask);
  shotSnap=markUi(document.createElement('div'));shotSnap.className='pa-shot-snap';shotSnap.style.display='none';
  document.body.appendChild(shotSnap);
  shotBox=markUi(document.createElement('div'));shotBox.className='pa-shot-box';shotBox.style.display='none';
  shotBox.innerHTML='<span class="pa-shot-size"></span>';
  document.body.appendChild(shotBox);

  shotMask.addEventListener('pointerdown',function(e){
    if(e.button!==0)return;
    e.preventDefault();e.stopPropagation();
    shotDrag={x:e.clientX,y:e.clientY,moved:false};
    shotBox.style.left=e.clientX+'px';shotBox.style.top=e.clientY+'px';
    shotBox.style.width='0px';shotBox.style.height='0px';shotBox.style.display='block';
  });
  shotMask.addEventListener('pointermove',function(e){
    e.preventDefault();
    if(!shotDrag){
      // 悬停吸附：穿透工具 UI 取业务元素，预览其矩形
      var el=businessElAt(e.clientX,e.clientY);
      if(el){
        var r=el.getBoundingClientRect();
        shotSnap.style.display='block';
        shotSnap.style.left=r.left+'px';shotSnap.style.top=r.top+'px';
        shotSnap.style.width=r.width+'px';shotSnap.style.height=r.height+'px';
      }else shotSnap.style.display='none';
      return;
    }
    var dx=e.clientX-shotDrag.x,dy=e.clientY-shotDrag.y;
    if(!shotDrag.moved&&Math.abs(dx)+Math.abs(dy)>6)shotDrag.moved=true;
    if(shotDrag.moved){
      var l=Math.min(shotDrag.x,e.clientX),t=Math.min(shotDrag.y,e.clientY);
      shotBox.style.left=l+'px';shotBox.style.top=t+'px';
      shotBox.style.width=Math.abs(dx)+'px';shotBox.style.height=Math.abs(dy)+'px';
      shotSnap.style.display='none';
      var sz=shotBox.querySelector('.pa-shot-size');
      if(sz)sz.textContent=Math.round(Math.abs(dx))+' × '+Math.round(Math.abs(dy));
    }
  });
  function finish(e){
    if(!shotDrag)return;
    var dg=shotDrag;shotDrag=null;
    var rect;
    if(dg.moved&&e){
      var l=Math.min(dg.x,e.clientX),t=Math.min(dg.y,e.clientY);
      rect={x:l,y:t,w:Math.abs(e.clientX-dg.x),h:Math.abs(e.clientY-dg.y)};
    }else{
      // 单击 → 吸附整元素矩形；点在空白处则用小区域兜底
      var el=businessElAt(dg.x,dg.y);
      if(el){var r=el.getBoundingClientRect();rect={x:r.left,y:r.top,w:r.width,h:r.height};shotAnchorEl=el;}
      else rect={x:dg.x-60,y:dg.y-40,w:120,h:80};
    }
    if(rect.w<8||rect.h<8){cancelShotDrag();return;}
    // 视口内钳制（防止拖出窗口边界）
    rect.x=Math.max(0,Math.min(rect.x,window.innerWidth-8));
    rect.y=Math.max(0,Math.min(rect.y,window.innerHeight-8));
    rect.w=Math.min(rect.w,window.innerWidth-rect.x);
    rect.h=Math.min(rect.h,window.innerHeight-rect.y);
    // 锚点在此刻定格（exitShotMode 会清场，元素引用不能穿越截图流程）
    // 下钻 iframe：锚到帧内真实元素，这样 iframe 内滚动时框也能跟着内容走。
    // 采样多个点（中心/四角内缩），避开落在空白处的中心点。
    var samples=[[rect.x+rect.w/2,rect.y+rect.h/2],[rect.x+8,rect.y+8],[rect.x+rect.w-8,rect.y+rect.h-8],[rect.x+8,rect.y+rect.h-8],[rect.x+rect.w-8,rect.y+8]];
    var deep=null;
    if(shotAnchorEl){deep={el:shotAnchorEl,framePath:[]};}
    else{
      for(var si=0;si<samples.length;si++){
        var d0=deepAnchorAt(samples[si][0],samples[si][1]);
        if(d0&&d0.el&&d0.framePath&&d0.framePath.length){deep=d0;break;}
        if(!deep||(!deep.framePath||!deep.framePath.length))deep=d0||deep;
      }
    }
    var anchorEl=deep&&deep.el;
    var anchorData=shotAnchorOf(anchorEl);
    if(anchorData&&deep.framePath&&deep.framePath.length)anchorData.framePath=deep.framePath.slice();
    // 相对锚点左上角的偏移：渲染时用它跟随滚动容器（内层 overflow 滚动也能对齐）
    var anchorOffset=null;
    if(anchorEl){
      var ar=anchorEl.getBoundingClientRect();
      anchorOffset={x:Math.round(rect.x-ar.left),y:Math.round(rect.y-ar.top)};
    }
    var shotScroll=snapshotScrollFor((anchorData&&anchorData.framePath)||[]);
    captureRegion(rect,anchorData,anchorOffset,shotScroll);
  }
  shotMask.addEventListener('pointerup',finish);
  shotMask.addEventListener('keydown',function(e){if(e.key==='Escape')exitShotMode();});
  setTimeout(function(){if(shotMask&&shotMask.isConnected&&shotMask.focus)shotMask.focus();},0);
  window.addEventListener('keydown',shotKeyEsc,true);
}
var shotAnchorEl=null;
function shotKeyEsc(e){
  if(e.key==='Escape'&&shotActive){e.stopPropagation();exitShotMode();}
}
function cancelShotDrag(){
  if(shotBox){shotBox.style.display='none';}
}
function businessElAt(x,y){
  var list;
  try{list=document.elementsFromPoint(x,y)||[];}catch(err){list=[];}
  for(var i=0;i<list.length;i++){
    if(isElementNode(list[i])&&!isToolUi(list[i]))return list[i];
  }
  return null;
}
// 命中点真正的业务元素：若落在同源 iframe 上，继续下钻到帧内元素（截图标注需要内在的锚点，
// 否则框只能锚在外壳 iframe 上，iframe 内滚动就会错位）
function deepAnchorAt(x,y){
  var el=businessElAt(x,y);
  if(!el||el.tagName!=='IFRAME')return {el:el,framePath:[]};
  var path=[],doc=document,ix=x,iy=y,curl=el;
  for(var depth=0;depth<4;depth++){
    if(!curl||curl.tagName!=='IFRAME')break;
    var siblings=doc.querySelectorAll('iframe'),idx=-1;
    for(var i=0;i<siblings.length;i++){if(siblings[i]===curl){idx=i;break;}}
    if(idx<0)break;
    path.push(idx);
    var r=curl.getBoundingClientRect();
    var cs=getComputedStyle(curl);
    ix=ix-(r.left+parseFloat(cs.borderLeftWidth||0));
    iy=iy-(r.top+parseFloat(cs.borderTopWidth||0));
    var cdoc=null;try{cdoc=curl.contentDocument;}catch(e){}
    if(!cdoc)break;
    var inner=null;try{inner=cdoc.elementFromPoint(ix,iy);}catch(e){}
    var innerWin=null;try{innerWin=curl.contentWindow;}catch(e){}
    if(!inner)return {el:curl,framePath:path.slice(0,-1)};   // 点在空白处：停在 iframe 这层
    if(!innerWin||inner===cdoc.documentElement||inner===cdoc.body){
      doc=cdoc;curl=inner&&inner.tagName==='IFRAME'?inner:null;continue;
    }
    if(inner.tagName==='IFRAME'){doc=cdoc;curl=inner;continue;}
    // 找到帧内真实元素
    if(!isToolUi(inner))return {el:inner,framePath:path.slice()};
    break;
  }
  return {el:el,framePath:path};
}
// iframe 元素在顶层文档中的视口矩形（逐级累加 border）
function frameRectOf(framePath){
  var doc=document,x=0,y=0;
  for(var i=0;i<framePath.length;i++){
    var f=doc.querySelectorAll('iframe')[framePath[i]];
    if(!f||!f.isConnected)return null;
    var r=f.getBoundingClientRect(),cs=getComputedStyle(f);
    x+=r.left+parseFloat(cs.borderLeftWidth||0);
    y+=r.top+parseFloat(cs.borderTopWidth||0);
    var cdoc=null;try{cdoc=f.contentDocument;}catch(e){}
    if(!cdoc)return null;
    doc=cdoc;
  }
  return {x:x,y:y};
}
function exitShotMode(){
  if(!shotActive&&!shotMask)return;
  shotActive=false;shotDrag=null;shotAnchorEl=null;
  document.body.classList.remove('pa-shot');
  [shotMask,shotSnap,shotBox].forEach(function(el){if(el&&el.parentNode)el.parentNode.removeChild(el);});
  shotMask=shotSnap=shotBox=null;
  window.removeEventListener('keydown',shotKeyEsc,true);
  syncModeBar();
}
function captureRegion(rectVP,anchorData,anchorOffset,shotScroll){
  // 隐身：工具全部 UI（遮罩/浮窗/针脚/弹窗）在截图瞬间不可见
  document.body.classList.add('pa-capturing');
  exitShotMode();
  var done=function(){document.body.classList.remove('pa-capturing');};
  // 双 rAF（等样式应用）+ 80ms（等合成器出帧）
  requestAnimationFrame(function(){requestAnimationFrame(function(){
    setTimeout(function(){
      var resp;
      try{resp=chrome.runtime.sendMessage({type:'PA_CAPTURE'});}catch(err){done();toast('截图失败','无法连接扩展后台：'+err.message);return;}
      if(resp&&resp.catch)resp.catch(function(){});
      resp.then(function(r){
        done();
        if(!r||!r.ok){toast('截图失败',r&&r.error?r.error:'当前页面不允许截图（如浏览器内置页）',3200);return;}
        cropShot(r.dataUrl,rectVP,anchorData,anchorOffset,shotScroll);
      },function(err){done();toast('截图失败','扩展后台无响应：'+((err&&err.message)||'未知错误'),3200);});
    },80);
  });});
}
function cropShot(dataUrl,rectVP,anchorData,anchorOffset,shotScroll){
  var img=new Image();
  img.onload=function(){
    var dpr=window.devicePixelRatio||1;
    var sx=Math.round(rectVP.x*dpr),sy=Math.round(rectVP.y*dpr);
    var sw=Math.max(1,Math.round(rectVP.w*dpr)),sh=Math.max(1,Math.round(rectVP.h*dpr));
    sx=Math.max(0,Math.min(sx,img.width-1));sy=Math.max(0,Math.min(sy,img.height-1));
    sw=Math.min(sw,img.width-sx);sh=Math.min(sh,img.height-sy);
    var maxSide=1600,scale=Math.min(1,maxSide/Math.max(sw,sh));
    var c=document.createElement('canvas');c.width=Math.max(1,Math.round(sw*scale));c.height=Math.max(1,Math.round(sh*scale));
    var ctx=c.getContext('2d');
    try{ctx.drawImage(img,sx,sy,sw,sh,0,0,c.width,c.height);}catch(e){toast('截图失败','图片解码异常',2800);return;}
    var dataURL='';
    try{dataURL=c.toDataURL('image/png');}catch(e){toast('截图失败','图片导出被页面安全策略阻止',2800);return;}
    openShotEditor(rectVP,dataURL,{w:window.innerWidth,h:window.innerHeight,dpr:dpr},null,anchorData,anchorOffset,shotScroll);
  };
  img.onerror=function(){toast('截图失败','截屏数据无法解码',2800);};
  img.src=dataUrl;
}
function shotAnchorOf(el){
  if(!el)return null;
  var t=elType(el);
  return {sel:selOf(el),summ:summOf(el),ctx:ctxOf(el),type:{key:t.key,label:t.label,tag:t.tag}};
}
function openShotEditor(rectVP,dataURL,vp,prefill,anchorData,anchorOffset,shotScroll){
  closeDialog(true);dialogOpen=true;sendFlags();
  var d=markUi(document.createElement('div'));d.className='pa-dialog pa-shot-dialog';
  var num=prefill?prefill.n:seq+1;
  var shownAnchor=anchorData||(prefill&&prefill.anchor);
  d.innerHTML='<div class="pa-dhead"><span class="pa-dttl"><span class="pa-dnum">#'+num+'</span>'+(prefill?'编辑截图标注':'📷 截图标注')+'</span><span class="pa-dx" title="取消">✕</span></div>'
  +'<div class="pa-dbody">'
  +'<div class="pa-shot-preview"><img alt="截图标注区域"></div>'
  +'<div class="pa-sec"><div class="pa-sec-h">修改意见</div><textarea class="pa-ta pa-c-note" placeholder="用一句话描述这个区域要怎么改"></textarea></div>'
  +(shownAnchor?'<div class="pa-dsumm">邻近元素：“'+esc(shownAnchor.summ)+'” · '+esc(shownAnchor.sel||'')+'</div>':'')
  +'<div class="pa-dhint">Ctrl / ⌘ + Enter 保存 · Esc 取消 · 标题栏可拖动</div>'
  +'<div class="pa-dfoot"><button class="pri pa-dsave">保存标注</button><button class="pa-dcancel">取消</button></div></div>';
  document.body.appendChild(d);
  var im=d.querySelector('.pa-shot-preview img');im.src=dataURL;
  var ta=d.querySelector('.pa-c-note');ta.value=prefill?prefill.text:'';
  d.style.left=Math.max(6,window.innerWidth/2-190)+'px';d.style.top=Math.max(6,window.innerHeight/2-230)+'px';clamp(d);
  setTimeout(function(){if(ta&&ta.isConnected)ta.focus();},0);
  activeCancel=function(){closeDialog();};
  // 关闭/取消：✕ 与「取消」按钮
  var cancelBtn=d.querySelector('.pa-dcancel'), closeBtn=d.querySelector('.pa-dx');
  if(cancelBtn)cancelBtn.onclick=function(){closeDialog(true);};
  if(closeBtn)closeBtn.onclick=function(){closeDialog(true);};
  d.querySelector('.pa-dsave').onclick=function(){
    var note=(ta.value||'').trim();
    if(!note){toast('还没有写意见','描述一下这个区域要怎么改再保存',2400);return;}
    if(prefill){
      prefill.text=note;
      save();renderAll();
      closeDialog();
      toast('已更新 #'+prefill.n,'截图标注意见已修改',1800);
      return;
    }
    seq++;
    var rectDoc={x:Math.round(rectVP.x+window.scrollX),y:Math.round(rectVP.y+window.scrollY),w:Math.round(rectVP.w),h:Math.round(rectVP.h)};
    var a={kind:'shot',n:seq,x:rectDoc.x,y:rectDoc.y,f:[],ctx:(anchorData&&anchorData.ctx)||'截图区域',text:note,img:dataURL,region:rectDoc,vp:vp,anchor:anchorData||null,anchorOffset:cleanAnchorOffset(anchorOffset),shotScroll:cleanShotScroll(shotScroll)};
    annos.push(a);
    save();renderAll();
    closeDialog();
  };
  d.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();d.querySelector('.pa-dsave').click();}else if(e.key==='Escape'){e.preventDefault();closeDialog(true);}});
  drag(d.querySelector('.pa-dhead'),d);
}
// 复制截图时在图上烘焙「编号角标 + 底部信息条」，粘贴到任何对话框都能与文字清单里
// 的 [编号] 条目对上号（剪贴板只能传图片，无法附带文件名，视觉标记是唯一可靠手段）
function stampShot(a){
  return new Promise(function(resolve,reject){
    var img=new Image();
    img.onload=function(){
      try{
        var W=img.width,H=img.height;
        var scale=W<420?1:2;          // 小图用 1x 保证文字清晰，大图用 2x
        var badgeH=Math.round(26*scale);   // 顶部编号条高度
        var barH=Math.round(34*scale);     // 底部信息条高度
        var c=document.createElement('canvas');
        c.width=W;c.height=H+badgeH+barH;
        var ctx=c.getContext('2d');
        var sans='-apple-system,"Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillStyle='#F5F2EC';ctx.fillRect(0,0,c.width,c.height);
        // 顶部：朱红编号角标 + 板块
        ctx.fillStyle='#FF4438';
        var bw=Math.round(30*scale);
        ctx.fillRect(0,0,bw,badgeH);
        ctx.fillStyle='#fff';
        ctx.font='700 '+Math.round(15*scale)+'px '+sans;
        ctx.textAlign='center';ctx.textBaseline='middle';
        ctx.fillText('#'+a.n,bw/2,badgeH/2+1);
        ctx.textAlign='left';
        ctx.fillStyle='#6B635A';
        ctx.font='600 '+Math.round(12*scale)+'px '+sans;
        ctx.fillText('截图标注 · '+(a.ctx||'页面'),bw+Math.round(9*scale),badgeH/2+1);
        // 截图本体
        ctx.drawImage(img,0,badgeH,W,H);
        // 底部：意见（超长省略）
        var by=H+badgeH;
        ctx.fillStyle='#221C18';ctx.fillRect(0,by,W,barH);
        ctx.fillStyle='#FFB020';ctx.fillRect(0,by,Math.round(3*scale),barH);
        var note=(a.text||'').replace(/\s+/g,' ');
        ctx.fillStyle='#F2EDE4';
        ctx.font='600 '+Math.round(12*scale)+'px '+sans;
        var maxW=W-Math.round(16*scale);
        while(note&&ctx.measureText(note).width>maxW)note=note.slice(0,-1);
        if(note!==(a.text||'').replace(/\s+/g,' '))note=note.slice(0,-1)+'…';
        ctx.fillText(note,Math.round(9*scale),by+barH/2+1);
        c.toBlob(function(blob){blob?resolve(blob):reject(new Error('toBlob failed'));},'image/png');
      }catch(e){reject(e);}
    };
    img.onerror=function(){reject(new Error('decode failed'));};
    img.src=a.img;
  });
}
function copyShotImage(a){
  if(!a||a.kind!=='shot'||!a.img)return;
  function fail(){toast('复制失败','浏览器不允许写图片剪贴板，可右键另存截图',3000);}
  stampShot(a).then(function(blob){
    try{
      navigator.clipboard.write([new ClipboardItem({'image/png':blob})]).then(function(){
        toast('已复制 #'+a.n+' 截图','图中已标编号与意见，可对上清单第 '+a.n+' 条',2600);
      },fail);
    }catch(e){fail();}
  },fail);
}
function syncModeBar(){
  if(!booted||!isTop)return;
  var bp=fab.querySelector('.pa-mb-pick'),bs=fab.querySelector('.pa-mb-shot');
  if(bp)bp.classList.toggle('act',freePick);
  if(bs)bs.classList.toggle('act',shotActive);
}

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
      await loadAnnosFromStorage();
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
function eventTargetFromPath(e){var p=(e.composedPath&&e.composedPath())||[];if(!p.length)return null;var first=p[0];if(isElementNode(first)&&isToolUi(first))return null;/* 点击源于工具 UI（清单/面板/浮窗）：整体放弃，绝不向上兜底到 body 之类 */for(var i=0;i<p.length;i++){if(pickable(p[i]))return p[i];}return pickable(e.target)?e.target:null;}
function targetFromPoint(x,y,fallback){var el=null;try{el=document.elementFromPoint(x,y);}catch(err){}if(pickable(el))return el;if(fallback&&document.contains(fallback)&&pickable(fallback))return fallback;return null;}
function getPickTarget(e){
  // 点击源于工具 UI 时 eventTargetFromPath 已返回 null；这里再兜住 target 与坐标命中工具层的情况
  if(e.target&&isToolUi(e.target))return null;
  var t=eventTargetFromPath(e);
  if(t)return t;
  var pt=targetFromPoint(e.clientX,e.clientY,null);
  return isToolUi(pt)?null:pt;
}
function blockNative(e){e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();}
function reportPick(target,x,y){
  // 一次一标注：选出目标即退出自由点选（无论随后保存还是取消），避免持续误触
  if(freePick)endFreePick();
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
  if(!isOn()||dialogOpen||shotActive||!(isPickChord(e)||freePick))return;
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
  document.addEventListener('mousemove',function(e){
    lastHover=eventTargetFromPath(e)||e.target;
    if(freePick&&isOn()&&!dialogOpen&&!shotActive){clearHl();if(pickable(lastHover))addHl(lastHover);}
  },true);
  document.addEventListener('pointerdown',startPickFromDown,true);
  document.addEventListener('mousedown',startPickFromDown,true);
  document.addEventListener('click',function(e){
    if(isToolUi(e.target))return;
    if(suppressPickClick>Date.now()&&Math.abs(e.clientX-suppressPickX)<4&&Math.abs(e.clientY-suppressPickY)<4){blockNative(e);return;}
    if(!isOn()||dialogOpen||shotActive||!(isPickChord(e)||freePick))return;
    var target=getPickTarget(e);if(!target)return;
    blockNative(e);var tx=e.clientX,ty=e.clientY;exitPick();
    reportPick(target,tx,ty);
  },true);
  document.addEventListener('mouseover',function(e){var target=eventTargetFromPath(e);if(isOn()&&!dialogOpen&&(pickChordDown||freePick)&&target)addHl(target);});
  document.addEventListener('mouseout',function(e){removeHl(eventTargetFromPath(e)||e.target);});
  window.addEventListener('keydown',function(e){
    if(e.key==='Escape'&&freePick&&isOn()&&!dialogOpen&&!shotActive){
      if(isTop)toggleFreePick();else postTop({type:'PA_FREEPICK_ESC'});
      return;
    }
    if(isOn()&&!dialogOpen&&(e.key==='Alt'||e.key==='Control')&&isPickChord(e)){if(!pickChordDown){pickChordDown=true;document.body.classList.add('pa-pick');}if(pickable(lastHover))addHl(lastHover);}
  });
  window.addEventListener('keyup',function(e){if(e.key==='Alt'||e.key==='Control')exitPick();});
  window.addEventListener('blur',exitPick);
}
bindPicking();
window.addEventListener('scroll',scheduleRender,true);
// 截图标注可能锚在 iframe 内元素上：iframe 自己滚动时顶层收不到 scroll，需逐帧挂监听
function watchFrameScrolls(){
  if(!isTop)return;
  var doc=document;
  for(var depth=0;depth<4;depth++){
    var frames;try{frames=doc.querySelectorAll('iframe');}catch(e){break;}
    if(!frames.length)break;
    var next=null;
    for(var i=0;i<frames.length;i++){
      var cwin=null,cdoc=null;
      try{cwin=frames[i].contentWindow;cdoc=frames[i].contentDocument;}catch(e){}
      if(!cwin||!cdoc)continue;
      if(!cwin.__PA_SCROLL_BOUND__){
        cwin.__PA_SCROLL_BOUND__=true;
        try{cwin.addEventListener('scroll',scheduleRender,true);cwin.addEventListener('resize',scheduleRender,true);}catch(e){}
      }
      if(!next)next=cdoc;
    }
    if(!next)break;
    doc=next;
  }
}
window.addEventListener('resize',function(){
  scheduleRender();watchFrameScrolls();
  if(isTop)[fab,document.querySelector('.pa-dialog')].forEach(function(el){if(el&&el.style.left)clamp(el);});
});

/* ================= 拖动（Master） ================= */
// 拖动中用 pointer capture + pointerup/pointercancel 收尾：业务页面在捕获阶段吞 mouseup
// 或用 setPointerCapture 抢事件时，拖动也不会卡死。
// capture 延迟到实际开始拖动（位移>4px）才启用——纯点击不捕获，
// 否则 click 的合成目标会被重定向到 handle，子元素（如开关滑块）的 click 永远收不到。
function drag(handle,target){
  handle.addEventListener('pointerdown',function(e){
    if(e.button!==0)return;
    var pid=e.pointerId,sx=e.clientX,sy=e.clientY;var r=target.getBoundingClientRect();var ox=r.left,oy=r.top;var moved=false;
    function mv(ev){
      if(ev.pointerId!==pid)return;
      if(!moved&&Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>4){
        moved=true;target._drag=true;
        try{handle.setPointerCapture(pid);}catch(err){}
      }
      if(moved){
        var nx=ox+ev.clientX-sx,ny=oy+ev.clientY-sy;
        var maxX=window.innerWidth-target.offsetWidth-6,maxY=window.innerHeight-target.offsetHeight-6;
        nx=Math.max(6,Math.min(nx,Math.max(6,maxX)));ny=Math.max(6,Math.min(ny,Math.max(6,maxY)));
        target.style.left=nx+'px';target.style.top=ny+'px';target.style.right='auto';target.style.bottom='auto';
        ev.preventDefault();
      }
    }
    function up(ev){
      if(ev&&ev.pointerId!==undefined&&ev.pointerId!==pid)return;
      handle.removeEventListener('pointermove',mv);
      handle.removeEventListener('pointerup',up);
      handle.removeEventListener('pointercancel',up);
      document.removeEventListener('pointerup',docUp);
      document.removeEventListener('pointercancel',docUp);
      window.removeEventListener('blur',docUp);
      setTimeout(function(){target._drag=false;},0);
    }
    // document 级兜底：capture 被业务页面抢占或 handle 被重建时，pointerup 也必达
    function docUp(ev){if(ev.pointerId===pid)up(ev);}
    handle.addEventListener('pointermove',mv);
    handle.addEventListener('pointerup',up);
    handle.addEventListener('pointercancel',up);
    document.addEventListener('pointerup',docUp);
    document.addEventListener('pointercancel',docUp);
    window.addEventListener('blur',docUp);
  });
}

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
    else if(t==='PA_FLAGS'){if(!TOKEN||d.token!==TOKEN)return;dialogOpen=!!d.dialogOpen;freePick=!!d.freePick;if(!freePick){document.body.classList.remove('pa-free');clearHl();}}
    else if(t==='PA_FREEPICK_ESC'){if(!TOKEN||d.token!==TOKEN)return;if(isTop&&freePick)toggleFreePick();}
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
  await loadAnnosFromStorage();
  if(annos.length){
    buildUi();startWatch();scanFrames();
    // 默认关闭态：页面保持原始 HTML，只显示底部「进入编辑」回显条
    applyMode('replay');broadcastState();
  }
  /* 无数据 → 保持 DORMANT：仅上面的消息监听在工作，零 DOM 接触 */
})();
})();
