
/* ========== 腾讯地图 Key 配置 ==========
   安全提示：
   - 该 Key 会以明文出现在页面源码里，任何打开页面的人都能看到（可用浏览器「查看源代码」验证）。
   - ① 首选加固（最关键、最有效）：到腾讯位置服务控制台 →「我的应用」→ 该应用 →「域名白名单 / 校验 Referer」，
     只允许你自己的域名访问（如 http://localhost 或你的站点）。
   - ② 若想彻底隐藏：把「地名→经纬度」与「路线规划」两个 WebService 调用挪到你的后端（Node/云函数）做转发，
     Key 只存服务端，前端仅调用你自己的接口；前端的 JSAPI Key 仍需域名白名单。
   - ③ 更换 Key 只需改下面这一行。 */
var TMAP_KEY = 'KLDBZ-BRPET-P5VXP-LQ5I4-NJQQ2-U5FWA';

/* 景点数据不在本文件里：SPOTS 由 spots.data.js 定义（tools/build-spots.js 从
   spots.src.json 生成，HTML 中先于本脚本 defer 加载）；HTTP 环境下启动后仍会
   从同目录 spots.json 拉取合并静态字段（两份产物同源，见 test/frontend/spotsBuild.test.js）。 */

/* SPOTS name→index 反查索引（O(1) 替代 O(n) indexOf）；运行期 SPOTS 不再变动 */
var _spotIndexMap = null;
function getSpotIndex(s){ if(!_spotIndexMap) _spotIndexMap = new Map(SPOTS.map(function(s,i){ return [s,i]; })); return _spotIndexMap.get(s); }

/* ================== 常量定义 ================== */
var CROWD = {"高":2,"中":1,"低":0};
var CROWD_TXT = {"高":"人流高","中":"人流中","低":"人流低"};
var COLOR = ["#30a46c","#c2410c","#e5484d"];   // index by CROWD：低=绿、中=深橙、高=红（与列表/弹窗 .t-lo/.t-mid/.t-hi 语义一致）
var CROWD_OFF_COLOR = '#5b6472';               // 「人流着色关闭」时的中性灰蓝
var crowdColorOn = true;                       // 地图人流着色默认开（可在工具栏关闭）
var RESERVE_TXT = {need_reserve:["⏱ 需预约","#6e56cf"],need_ticket:["¥ 需购票","#4f6f8f"],free:["✓ 免预约","#30a46c"]};

/* ================== 工具函数（消除重复代码） ================== */

// 人流等级 → CSS 类名常量（3处统一引用）
var CROWD_CLS = {'高':'t-hi','中':'t-mid','低':'t-lo'};

// 预约状态 → [显示名, 颜色]（spotHTML / rowInnerHTML 共用）
function getReserveInfo(s){ return RESERVE_TXT[s.reserve] || RESERVE_TXT.free || ['','']; }

// 数据来源徽章（rowInnerHTML / patchLiveUI 共用）
function getSrcBadge(s){
  if(s._liveCrowd){
    var isCache = !!s._stale;
    var cls = isCache ? 'cache' : 'real';
    var txt = isCache ? '缓存' : '近10天';
    var title = isCache ? '数据源暂不可用，展示最近一次历史热力' : '来自及客智能 · 近10天历史热力';
    return '<span class="it-src ' + cls + '" title="' + title + '">' + txt + '</span>';
  }
  return '<span class="it-src est" title="未连接数据源，按本地时间估算">估算</span>';
}

// 指南针按钮文字（reset / rotate 回调 / northBtn.onclick 共用）
function getNorthText(deg){ return '🧭 ' + (deg === 0 ? '北' : deg + '°'); }

// 测距面板重置（catch 块 / rightclick 块共用）
function resetMeasureUI(){
  measuring = false;
  measureBtn.style.background = '';
  measureBtn.style.color = '';
  measureBtn.setAttribute('aria-pressed','false');
  measurePanel.style.display = 'none';
  mpPath.textContent = '—'; mpLine.textContent = '—';
}

// 人流建议统一入口（返回 {short, shortCls, full}）
// 人流建议统一入口（定义在下方 crowdAdvice 块中，见 getCrowdAdvice）

// hexRgb 结果缓存（颜色种类有限，缓存可避免重复 parseInt）
var _hexRgbCache = {};
function hexRgb(hex){
  if(_hexRgbCache[hex]) return _hexRgbCache[hex];
  var h = hex.replace('#','');
  var c = { r: parseInt(h.substr(0,2),16), g: parseInt(h.substr(2,2),16), b: parseInt(h.substr(4,2),16) };
  _hexRgbCache[hex] = c;
  return c;
}
function radialGlow(hex, spread){
  var c = hexRgb(hex);
  return 'radial-gradient(circle at 50% 38%, rgba('+c.r+','+c.g+','+c.b+',1) 0%, rgba('+c.r+','+c.g+','+c.b+',.82) 38%, rgba('+c.r+','+c.g+','+c.b+',.28) 68%, rgba('+c.r+','+c.g+','+c.b+',0) '+(spread||85)+'%)';
}
function neonGlow(hex){
  var c = hexRgb(hex);
  return '0 0 6px rgba('+c.r+','+c.g+','+c.b+',.85), 0 0 16px rgba('+c.r+','+c.g+','+c.b+',.55), 0 0 30px rgba('+c.r+','+c.g+','+c.b+',.32)';
}

/* ================== 地图应用（等 TMap 加载后执行） ================== */
function startApp(){
  var win = this; if(!win._ic) win._ic = 0; win._ic++;
  var boot = document.getElementById('boot'); if(boot) boot.remove();
  // 注意：不要在这里写 var toast = win.toast（局部变量会在下面 window.toast 赋值之前
  // 捕获到 undefined，导致本函数内所有 toast() 调用抛 "toast is not a function"）。
  // 不声明局部变量，toast 会实时解析到 window.toast。
// 在 Tencent SDK 外部创建 TMap.Map（避开 SDK with(map){} 块对局部变量的污染）
var mapInst = new TMap.Map('map', {
  center: new TMap.LatLng(30.56, 114.31),
  zoom: 11,
  viewMode: '3D',
  pitch: 0,
  maxZoom: 18,
  rotatable: true,
  pitchable: true
});
// 暴露到 window 供 SDK / 全局访问
window.__tmapMap = mapInst;

/* 用户要求：地图自带的「Loading」小胶囊弱网下会一直挂着 —— 直接取消。
   不能按 class 批量隐藏（瓦片带 tile_loading 状态类，会误伤地图），
   按「文本恰为 Loading/加载中 + 无子元素 + 小胶囊尺寸」精准移除。 */
(function suppressTmapLoader(){
  var mapEl = document.getElementById('map');
  if(!mapEl || !window.MutationObserver) return;
  var pending = false;
  function sweep(){
    pending = false;
    mapEl.querySelectorAll('div,span').forEach(function(el){
      if(el.children.length) return;
      var t = (el.textContent || '').trim();
      if(!/^(loading|加载中|loading\.\.\.)$/i.test(t)) return;
      var r = el.getBoundingClientRect();
      if(r.width > 0 && r.width <= 120 && r.height <= 40) el.style.display = 'none';
    });
  }
  var obs = new MutationObserver(function(){
    if(pending) return;
    pending = true;
    setTimeout(sweep, 80);
  });
  obs.observe(mapEl, { childList: true, subtree: true });
  sweep();
  // 胶囊只在地图样式/瓦片加载期出现：20 秒后监视器退役（末次兜底扫描），
  // 之后平移/缩放的瓦片 DOM 变动不再触发任何扫描 —— 常态零开销
  setTimeout(function(){ obs.disconnect(); sweep(); }, 20000);
})();
// 注意：不要 'var map = mapInst'（会被 with() 块污染）；SDK 调用全部使用 window.__tmapMap
  // 限制地图视野在武汉大市范围内，防止拖拽到空白区域
  var WUHAN_BOUNDS = new TMap.LatLngBounds(
    new TMap.LatLng(29.97, 113.70),   // 西南角
    new TMap.LatLng(31.37, 115.08)    // 东北角
  );
  // 用 window.__tmapMap 引用绕过 SDK with() 块的变量遮蔽
  window.__tmapMap.on('center_changed', function(){
    if(!WUHAN_BOUNDS.contains(window.__tmapMap.getCenter())){
      var c = window.__tmapMap.getCenter();
      var ne = WUHAN_BOUNDS.getNorthEast(), sw = WUHAN_BOUNDS.getSouthWest();
      var lat = Math.max(sw.getLat(), Math.min(ne.getLat(), c.getLat()));
      var lng = Math.max(sw.getLng(), Math.min(ne.getLng(), c.getLng()));
      window.__tmapMap.setCenter(new TMap.LatLng(lat, lng));
    }
  });
  // 暗色模式下地图底图主题切换
  function applyMapTheme(dark){
    if(!dark) return;
    try{
      window.__tmapMap.setStyle({
        style: 'dark',
        features: {
          water: { fill: '#0d1b2a' },
          land: { fill: '#1a1a2e' },
          road: { fill: '#2d2d44' },
          point: { fill: '#8b8bb0' }
        }
      });
    } catch(e){ /* 地图样式切换失败，静默 */ }
  }
  // 监听 body.classList 变化，实时切换地图主题
  var darkObserver = new MutationObserver(function(muts){
    muts.forEach(function(m){
      if(m.attributeName === 'class'){
        applyMapTheme(document.body.classList.contains('dark'));
      }
    });
  });
  darkObserver.observe(document.body, {attributes: true});
  // 页面加载时：如果已是暗色，应用暗色地图
  if(document.body.classList.contains('dark')){ applyMapTheme(true); }
window.__tmapMap.on('click', function(){ closePopup(); closeClusterList(); });

/* ================== 自建弹窗 ================== */
var popup = document.getElementById('spotPopup');
var popupContent = popup.querySelector('.pp-content');
var popupSpot = null;   // 当前弹窗对应的景点
var popupPrevFocus = null;   // 打开弹窗前持焦元素，关闭时归还焦点

/* ---- 周边推荐（F3）----
   球面距离自算 haversine 而不走 TMap.geometry —— 纯函数，单测不需要桩 SDK。
   半径内无邻居（远郊孤立景点）返回空数组，弹窗不渲染该节。 */
var NEARBY_RADIUS = 2000;   // 米
var NEARBY_MAX = 4;
function distMeters(a, b){
  var R = 6371000, rad = Math.PI / 180;
  var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  var h = s1 * s1 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function nearbySpots(s, radiusM, max){
  var r = radiusM || NEARBY_RADIUS, cap = max || NEARBY_MAX;
  var out = [];
  for(var i = 0; i < SPOTS.length; i++){
    var o = SPOTS[i];
    if(o === s || o.name === s.name) continue;
    var d = distMeters(s, o);
    if(d <= r) out.push({ spot: o, dist: d, index: i });
  }
  out.sort(function(a, b){ return a.dist - b.dist; });
  return out.slice(0, cap);
}

function spotHTML(s){
  var r = getReserveInfo(s);
  var rname = r[0];
  var tierCls = CROWD_CLS[s.crowd] || 't-lo';
  var infoRows = '';
  if(s.hours)   infoRows += '<div class="c-row"><b>开放</b><span>'+esc(s.hours)+'</span></div>';
  if(s.duration)infoRows += '<div class="c-row"><b>建议</b><span>'+esc(s.duration)+'</span></div>';
  if(s.metro)   infoRows += '<div class="c-row"><b>交通</b><span>'+esc(s.metro)+'</span></div>';
  var score = s.score ? '<span class="pp-score">⭐ '+esc(s.score)+'</span>' : '';
  var os = openState(s), osChip = os ? ' <span class="tag t-'+os.cls+'">'+esc(os.text)+'</span>' : '';
  var actions = '<div class="pp-actions"><button data-act="go">📍 到这去</button></div>';
  if(s.url) actions += '<a class="pp-url" href="'+esc(s.url)+'" target="_blank" rel="noopener noreferrer">🔗 官方预约 / 购票</a>';
  return '<div class="iw">'+
    '<div class="c-title">'+esc(s.emoji)+' '+esc(s.name)+' '+score+osChip+'</div>'+
    '<div class="c-cat">'+esc(s.cat)+'</div>'+
    '<div class="c-row"><b>门票</b><span>'+esc(s.ticket)+'</span></div>'+
    '<div class="c-row"><b>预约</b><span>【'+esc(rname)+'】 '+esc(s.reserveNote)+'</span></div>'+infoRows+
    '<div class="c-row"><b>人流</b><span><span class="tier '+tierCls+'">'+esc(s.crowd)+'</span>　<span class="peak">'+esc(s.peak)+'</span></span></div>'+
    (s._typPeak ? '<div class="c-row"><b>典型高峰</b><span>'+esc(s._typPeak)+'</span></div>' : '')+
    '<div class="c-advice">💬 '+esc(getCrowdAdvice(s).full)+'</div>'+
    '<div class="c-trend">'+trendHTML(s)+'</div>'+
    '<div class="c-row"><b>地址</b><span>'+esc(s.addr)+'</span></div>'+
    (function(){
      var near = nearbySpots(s);
      if(!near.length) return '';
      return '<div class="c-near"><b>📍 周边 '+ (NEARBY_RADIUS >= 1000 ? (NEARBY_RADIUS/1000) + ' 公里' : NEARBY_RADIUS + ' 米') +'</b>'+
        near.map(function(nb){
          return '<button class="pp-near" data-i="' + nb.index + '" title="查看 '+esc(nb.spot.name)+'">'+esc(nb.spot.name)+' · '+fmtDist(nb.dist)+'</button>';
        }).join('') + '</div>';
    })()+
    '<div class="c-tip">💡 '+esc(s.tip)+'</div>'+actions+'</div>';
}
var popupSize = null, wrapSize = null;   // 弹窗/容器尺寸缓存：pan/zoom 时避免每帧读布局
function measurePopupBox(){
  popupSize = { w: popup.offsetWidth, h: popup.offsetHeight };
  var wrap = document.getElementById('mapwrap');
  wrapSize = { w: wrap.clientWidth, h: wrap.clientHeight };
}
function positionPopup(){
  if(!popupSpot) return;
  var px = window.__tmapMap.projectToContainer(new TMap.LatLng(popupSpot.lat, popupSpot.lng));
  if(!popupSize || !wrapSize) measurePopupBox();   // 打开/缩放后首帧测量一次，之后复用
  var w = popupSize.w, h = popupSize.h;
  var x = px.getX() - w/2;
  var y = px.getY() - h - 50;   // 弹窗在标记上方 50px
  // 边界约束：不让弹窗超出容器
  x = Math.max(8, Math.min(x, wrapSize.w - w - 8));
  if(y < 8){ y = px.getY() + 50; }   // 上方放不下则放到标记下方
  if(y > wrapSize.h - h - 8){ y = Math.max(8, wrapSize.h - h - 8); }   // 底部同样钳制，避免窄屏/矮屏溢出
  popup.style.transform = 'translate('+x+'px,'+y+'px)';
}
window.addEventListener('resize', function(){ popupSize = null; wrapSize = null; if(popupSpot) positionPopup(); });
function openInfo(s){
  popupSpot = s;
  // 对话框语义：role/aria-modal + 焦点管理（记录触发元素、进入后聚焦内容区）
  if(!popup.contains(document.activeElement)) popupPrevFocus = document.activeElement;
  popup.setAttribute('role','dialog');
  popup.setAttribute('aria-modal','true');
  popup.setAttribute('aria-label','景点详情：' + s.name);
  popupContent.setAttribute('tabindex','-1');   // 可编程聚焦，供读屏读取弹窗内容
  popupContent.innerHTML = spotHTML(s);
  bindPopupActions(s);
  popup.style.display = 'block';
  // 等布局完成后定位再聚焦（preventScroll 避免视图跳动）
  requestAnimationFrame(function(){ measurePopupBox(); positionPopup(); try{ popupContent.focus({ preventScroll: true }); }catch(e){} });
}
function closePopup(){
  if(!popupSpot) return;   // 已关闭则不再重新聚焦
  popupSpot = null;
  popup.style.display = 'none';
  if(popupPrevFocus && popupPrevFocus !== document.body && document.contains(popupPrevFocus) && typeof popupPrevFocus.focus === 'function'){
    try{ popupPrevFocus.focus({ preventScroll: true }); }catch(e){}
  }
}
// 右上角叉号关闭弹窗
document.getElementById('ppClose').onclick = function(){ closePopup(); };
// Esc：依次关闭弹窗 / 聚合列表 / 联想下拉（输入框中由 qInput 自行处理，这里跳过）
document.addEventListener('keydown', function(e){
  if(e.key !== 'Escape') return;
  var t = e.target;
  if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if(helpOverlayOpen){ hideHelpOverlay(); return; }
  if(popupSpot){ closePopup(); return; }
  if(clusterListEl){ closeClusterList(); return; }
  hideQList();
});
// 键盘快捷键面板
function showHelpOverlay(){
  if(helpOverlayOpen) return;
  var keys = [
    ['Esc', '关闭弹窗 / 联想 / 帮助'],
    ['/', '聚焦搜索框'],
    ['+ / -', '放大 / 缩小地图'],
    ['D', '切换日间 / 夜间'],
    ['C', '复位视图'],
    ['F', '定位到我的位置'],
    ['M', '开启 / 关闭测距'],
    ['T', '切换地图暗色叠加'],
    ['↑/↓', '搜索结果上下选择'],
    ['Enter', '打开选中项的详情'],
  ];
  var rows = keys.map(function(r){ return '<tr><td><kbd>'+r[0]+'</kbd></td><td>'+r[1]+'</td></tr>'; }).join('');
  var div = document.createElement('div');
  div.id = 'helpOverlay';
  div.setAttribute('role','dialog');
  div.setAttribute('aria-label','键盘快捷键');
  div.innerHTML = '<div class="help-card"><div class="help-head"><span>⌨ 键盘快捷键</span><button class="help-x" aria-label="关闭">✕</button></div><table class="help-table">'+rows+'</table></div>';
  document.body.appendChild(div);
  helpOverlayOpen = div;
  div.querySelector('.help-x').onclick = hideHelpOverlay;
  div.onclick = function(ev){ if(ev.target === div) hideHelpOverlay(); };
}
function hideHelpOverlay(){ if(helpOverlayOpen){ helpOverlayOpen.remove(); helpOverlayOpen = null; } }
var helpOverlayOpen = null;

// 全局快捷键监听
document.addEventListener('keydown', function(e){
  // 在输入框里不响应
  var ae = document.activeElement;
  if(ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
  var handled = true;
  switch(e.key){
    case '?':
      if(e.shiftKey) showHelpOverlay();
      else handled = false;
      break;
    case '/':
      e.preventDefault();
      var q = document.getElementById('q');
      if(q){ q.focus(); q.select(); }
      break;
    case '+':
    case '=':
      if(window.__tmapMap) window.__tmapMap.setZoom((window.__tmapMap.getZoom() || 11) + 1);
      break;
    case '-':
    case '_':
      if(window.__tmapMap) window.__tmapMap.setZoom((window.__tmapMap.getZoom() || 11) - 1);
      break;
    case 'd':
    case 'D':
      // 点按钮而不是直接改状态：日↔夜的切换逻辑只写在 themeBtn.onclick 一处，
      // 快捷键不重复一遍。紫晶是另一个开关，不在 d 的职责范围内。
      var themeBtn = document.getElementById('btn-theme');
      if(themeBtn) themeBtn.click();
      break;
    case 'c':
    case 'C':
      var reset = document.getElementById('reset');
      if(reset) reset.click();
      break;
    case 'f':
    case 'F':
      var loc = document.getElementById('locateBtn');
      if(loc) loc.click();
      break;
    case 'm':
    case 'M':
      var mb = document.getElementById('btn-measure');
      if(mb) mb.click();
      break;
    case 't':
    case 'T':
      var sat = document.getElementById('btn-sat');
      if(sat) sat.click();
      break;
    default:
      handled = false;
  }
  if(handled) e.preventDefault();
});
// 地图移动/缩放时跟随定位
window.__tmapMap.on('zoom', function(){
  if(popupSpot) positionPopup();
  scheduleRenderPins();
  var zl = document.getElementById('zoomLevel');
  if(zl) zl.textContent = Math.round(window.__tmapMap.getZoom());
});
window.__tmapMap.on('center_changed', function(){ if(popupSpot) positionPopup(); });
// 缩放触发的渲染调度（避免每帧重建）
var renderPinsTimer = null;
function scheduleRenderPins(){
  if(renderPinsTimer) return;
  renderPinsTimer = setTimeout(function(){ renderPinsTimer = null; renderPinsForZoom(); }, 100);
}

/* 非阻塞提示（替代 alert，避免阻断整个页面） */
var toastEl = null, toastTimer = null;
window.toast = function(msg, type){
  if(!toastEl){ toastEl = document.createElement('div'); toastEl.setAttribute('role','alert'); toastEl.setAttribute('aria-live','assertive'); document.body.appendChild(toastEl); }
  toastEl.className = 'toast' + (type === 'ok' ? ' ok' : type === 'error' ? ' error' : type === 'info' ? ' info' : '');
  toastEl.textContent = msg;
  void toastEl.offsetWidth;   // 强制重排，使每次弹窗都重新过渡
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, type === 'error' ? 3800 : 2600);
};
// 异步失败不再静默：统一兜底提示
window.addEventListener('unhandledrejection', function(ev){ toast('⚠️ 操作未完成：' + ((ev.reason && ev.reason.message) || '网络异常'), 'error'); ev.preventDefault(); });

/* ================== 自定义覆盖物 ================== */

/* --- 单点标记 --- */
function SpotPin(options){ TMap.DOMOverlay.call(this, options); }
SpotPin.prototype = new TMap.DOMOverlay();
SpotPin.prototype.onInit = function(options){
  this.position = options.position;
  this.spot = options.spot;
  // 名字被去遮挡逻辑判定为「放不下」时不渲染这个 div。
  // .sp-name 是绝对定位（top:48px），去掉它不影响 .spotpin 的 42px 盒子和 updateDOM 的居中计算，
  // 只是这条 pin 在屏幕上没有名字 —— 点它照样进详情，信息并没丢。
  this.hideName = !!options.hideName;
};
SpotPin.prototype.onDestroy = function(){
  this.dom.removeEventListener('click', this.onClick);
  this.removeAllListeners();
};
SpotPin.prototype.createDOM = function(){
  var s = this.spot;
  var color = crowdColorOn ? COLOR[CROWD[s.crowd]] : CROWD_OFF_COLOR;
  var badge = '';
  if(s.reserve !== 'free'){
    var bt = RESERVE_TXT[s.reserve] ? RESERVE_TXT[s.reserve][0] : '';
    badge = '<div class="sp-badge sp-res-'+s.reserve+'">'+esc(bt)+'</div>';
  }
  var dom = document.createElement('div');
  dom.className = 'spotpin';
  dom.innerHTML = badge +
    '<div class="sp-pin" style="background:'+radialGlow(color,88)+';box-shadow:'+neonGlow(color)+',0 2px 6px rgba(0,0,0,.35)"><span>'+esc(s.emoji)+'</span></div>' +
    (this.hideName ? '' : '<div class="sp-name">'+esc(s.name)+'</div>');
  this.onClick = this.onClick.bind(this);
  dom.addEventListener('click', this.onClick);
  return dom;
};
SpotPin.prototype.updateDOM = function(){
  if(!this.map) return;
  var pixel = this.map.projectToContainer(this.position);
  var left = pixel.getX() - this.dom.clientWidth/2;
  var top  = pixel.getY() - 42;               // 锚点在 pin 底部
  this.dom.style.transform = 'translate('+left+'px,'+top+'px)';
};
SpotPin.prototype.onClick = function(){ this.emit('click'); };
/* 60s tick 时原位刷新标记颜色（不销毁重建 DOM） */
SpotPin.prototype.refresh = function(){
  if(!this.spot || !this.dom) return;
  var color = crowdColorOn ? COLOR[CROWD[this.spot.crowd]] : CROWD_OFF_COLOR;
  var pin = this.dom.querySelector('.sp-pin');
  if(pin){ pin.style.background = radialGlow(color, 88); pin.style.boxShadow = neonGlow(color) + ',0 2px 6px rgba(0,0,0,.35)'; }
};

/* --- 聚合气泡 --- */
/* 性能优化（P1-4）：聚合气泡改为单个 canvas overlay 替代 50+ DOM 节点。
   - zoom < 13 时一个 canvas 绘制所有气泡
   - 保留 ClusterBubble 类名以防代码中其他位置引用
   - SpotPin（zoom>=13）保持 DOM 不变 */
function ClusterBubble(options){ TMap.DOMOverlay.call(this, options); }
ClusterBubble.prototype = new TMap.DOMOverlay();
ClusterBubble.prototype.onInit = function(options){
  this.position = options.position;
  this.content = options.content;
  this.color = options.color;
  this.bounds = options.bounds;
};
ClusterBubble.prototype.onDestroy = function(){
  if(this.dom) this.removeAllListeners();
};
ClusterBubble.prototype.createDOM = function(){
  // 实际不再使用此方法（renderPinsForZoom 走 canvas 路径），保留防止报错
  var dom = document.createElement('div');
  dom.className = 'clusterBubble-hidden';
  return dom;
};

// === 分组的互斥半径 ===
// 一组该占多大，按组内景点数算：点的人多就留出更大的位置。
// clusterLayout 用它决定两组挤在一起时能不能合并、合并后半径往哪走。
// 组最终渲染成 emoji pin，视觉半径由 .spotpin 自己定，这里只管排布不打架。
function bubbleRadius(total){
  return 18 + Math.min(total, 9) * 1.5;
}
/* 气泡布局：把屏幕上会互相压住的圈合并成一个。
   为什么是「合并」而不是「挪开」：圆心必须压在某个真实景点上才不浮空，
   一旦为了避开重叠而平移，圆心就落到空地里了。所以重叠时只能把两组并成更大的一组，
   圆心保持在锚点（真实景点）上不动。
   items: [{lat, lng, geoms, src, r, rx, ry}]；project(lat, lng) -> {x, y}；w/h 为画布尺寸（用于剔掉屏外气泡）。
   r 是可选的视觉半径（气泡用），rx/ry 是可选的互斥半轴 —— pin 用更大的 ry/rx 把
   「圆 + 下方名字标签」整块算进去，否则两个圈虽然分开了，名字还是会互相盖。
   merge=false 时只做投影和屏外剔除、不合并（没有气泡层之后没人再用这个模式，保留给单测）。
   返回 [{lat, lng, geoms, src, sx, sy, r, rx, ry}]，任意两个互不重叠。 */
function clusterLayout(items, project, w, h, merge){
  var GAP = 6;                 // 两个圈之间保留的最小缝隙
  var groups = [];
  var i, g;
  for(i = 0; i < items.length; i++){
    var b = items[i];
    if(!b || !b.geoms || !b.geoms.length) continue;
    var p = project(b.lat, b.lng);
    var sx = p.x, sy = p.y;
    var r = (b.r != null) ? b.r : bubbleRadius(b.geoms.length);
    var rx = (b.rx != null) ? b.rx : r;
    var ry = (b.ry != null) ? b.ry : r;
    var size = Math.max(rx, ry) + 8;   // 连光晕一起算，视觉上才算真的分开
    if(w < Infinity && (sx < -size || sy < -size || sx > w + size || sy > h + size)) continue;   // 屏外不参与，也不画
    groups.push({lat: b.lat, lng: b.lng, geoms: b.geoms, src: b.src, sx: sx, sy: sy, r: r, rx: rx, ry: ry});
  }
  // 贪心合并：每次挑半径小的一方并进大的一方，直到没有任何一对相交
  var guard = groups.length * groups.length + 8;
  var changed = merge !== false && groups.length > 1;
  while(changed && guard-- > 0 && groups.length > 1){
    changed = false;
    outer:
    for(i = 0; i < groups.length; i++){
      for(g = i + 1; g < groups.length; g++){
        var A = groups[i], B = groups[g];
        var dx = A.sx - B.sx, dy = A.sy - B.sy;
        var nx = A.rx + B.rx + GAP, ny = A.ry + B.ry + GAP;
        // 椭圆相交（rx/ry 相等时就是普通的圆相交）
        if(dx * dx / (nx * nx) + dy * dy / (ny * ny) < 1){
          var big = A.geoms.length >= B.geoms.length ? A : B;
          var small = big === A ? B : A;
          big.geoms = big.geoms.concat(small.geoms);
          // 并进来圈要变大，于是可能又压到别人，交给下一轮；
          // 取 max 保证半径只增不减，视觉上不会出现「合并后反而变小」
          big.r = Math.max(big.r, small.r, bubbleRadius(big.geoms.length));
          big.rx = Math.max(big.rx, small.rx, bubbleRadius(big.geoms.length));
          big.ry = Math.max(big.ry, small.ry, bubbleRadius(big.geoms.length));
          groups.splice(groups.indexOf(small), 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return groups;
}
/* 名字标签去遮挡。
   圈与圈之间的互斥已经在 clusterLayout 里做完了，但 .sp-name 是一条横向长条
   （max-width:140px，锚点下方 6~31px），「两个中心的椭圆相不相交」描述不了它往旁边伸出去的那一截 ——
   实测「武汉欢乐谷」的标签就压在隔壁气泡的边上，而两个中心点相距快 100px，判定里压根没看见。
   为什么用「藏标签」而不是「把两个点合并成一个圈」：合并会丢掉两个独立的圆和各自的颜色，
   藏一条标签只影响可读性，点 pin 还能进详情。
   items: [{key, sx, sy, r, hasName}]；返回 key 集合 = 该隐藏标签的项。
   有名字的按数组顺序优先占位（SPOTS 的顺序是数据里的顺序，稳定的）。 */
/* .sp-name 是 max-width:140px 的上限，11.5px 字号下 6 个汉字约 71px、10 个汉字约 118px。
   取 58（≈10 个汉字的一半）作为典型半宽：按上限 70 取会让相邻 pin 的标签互相判定，
   一排密点的标签会被全部藏掉；按最小名取又会漏掉真正压上去的长名。 */
var LABEL_HALF_W = 58;    // 名字标签的典型半宽
var LABEL_TOP = 4;        // 标签顶相对锚点（CSS top:48px，锚点在 .spotpin 的 42px 处）
var LABEL_BOT = 34;       // 标签底相对锚点
var PIN_BODY_HW = 27;      // 邻居 pin 的「圆 + 徽标」典型半宽（徽标 54px 比 42px 的圆更宽）
var PIN_BODY_TOP = -42;    // 圆顶相对锚点
var PIN_BADGE_H = 20;      // 徽标典型高度
var PIN_SOVER_RATIO = 0.35; // 邻居 pin 圆+徽标要盖住标签这么大比例，才算「压得看不清」
function declutterNames(items){
  // 障碍分两档，因为两类东西的可信度差得很远：
  // ① 气泡（hasName===false）：又大又实心，压上去必然看不清 → 相交即挡。
  // ② 邻居 pin 的圆 + 徽标（it.soft）：圈与圈已经被 clusterLayout 保证互斥了，
  //    所以邻居圆压上来往往只盖掉标签一角，硬判「相交就藏」会在刚好的密度下
  //    把整片密集区的名字全藏光（这正是之前只挡气泡的原因）。
  //    改成按面积比判：盖掉 35% 以上才藏，既保住密集区的名字，
  //    又能把「湖北省科学技术馆」这种被隔壁圆压掉近一半的直接藏掉。
  //  ③ 外部实测矩形（it.extSoft / it.extHard）：软 / 硬两档外部障碍。
  //     extHard 现在只有四角死亡区一个生产者；extSoft 的生产者（底图 POI 文字）已删，
  //     因为 TMap v3 把文字画进 canvas、取不到 DOM 矩形（见 applyNameDeclutter 处的说明）。
  //     分支留着：这是个纯几何函数，对 items 上的矩形不该挑三拣四；而且成本为零 ——
  //     下面这个 forEach 本来就要为 extHard 跑一遍，多一个 if 不会更慢。
  //     这两类的 items 都带 hasName:false 但没有 r，必须从下面这个 sx/sy 估算分支里排掉，
  //     否则 pad = it.r + 8 会算出 NaN，整个障碍判定静默失效。
  var blocks = items.filter(function(it){ return !it.hasName && !it.extSoft && !it.extHard; }).map(function(it){
    var pad = it.r + 8;                      // 连光晕/描边一起算
    return { x0: it.sx - pad, x1: it.sx + pad, y0: it.sy - pad, y1: it.sy + pad, self: -1 };
  });
  items.forEach(function(it){
    if(it.extHard)                 // 死亡区：常驻控件，相交即挡，不讲面积比
      blocks.push({ x0: it.extHard.x0, x1: it.extHard.x1, y0: it.extHard.y0, y1: it.extHard.y1, self: -1 });
    if(it.extSoft)                 // 底图 POI 文字：软障碍，和邻居 pin 同一档
      blocks.push({ x0: it.extSoft.x0, x1: it.extSoft.x1, y0: it.extSoft.y0, y1: it.extSoft.y1,
                    soft: true, self: -1 });
  });
  items.forEach(function(it){
    if(it.absSoft){                 // 已有实测矩形：直接用，不做锚点换算
      blocks.push({ x0: it.absSoft.x0, x1: it.absSoft.x1, y0: it.absSoft.y0, y1: it.absSoft.y1,
                    soft: true, self: it.hasName ? it.key : -1 });
      return;
    }
    if(!it.soft) return;            // 量不到 pin 本体就退化成「不挡」
    blocks.push({
      x0: it.sx + it.soft.dx0, x1: it.sx + it.soft.dx1,
      y0: it.sy + it.soft.dy0, y1: it.sy + it.soft.dy1,
      soft: true,
      self: it.hasName ? it.key : -1        // 自己不挡自己
    });
  });
  var kept = [];
  var hidden = [];
  items.forEach(function(it){
    if(!it.hasName) return;
    // hw/ht/hb 由调用方量真实 DOM 给；给不到才退回估算值。
    // 不实测是因为「7 个汉字」比按字号算出来的宽，两条相邻标签照样会叠。
    var hw = it.hw != null ? it.hw : LABEL_HALF_W;
    var ht = it.ht != null ? it.ht : LABEL_TOP;
    var hb = it.hb != null ? it.hb : LABEL_BOT;
    var box = it.abs || { x0: it.sx - hw, x1: it.sx + hw, y0: it.sy + ht, y1: it.sy + hb };
    var area = Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0));
    var bad = false;
    for(var k = 0; k < kept.length && !bad; k++){
      var b = kept[k];
      if(box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0) bad = true;
    }
    var cover = 0;
    for(var c = 0; c < blocks.length && !bad; c++){
      var q = blocks[c];
      if(q.self === it.key) continue;
      if(box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0){
        if(q.soft){                                        // 软障碍：按面积比累计
          var ix = Math.min(box.x1, q.x1) - Math.max(box.x0, q.x0);
          var iy = Math.min(box.y1, q.y1) - Math.max(box.y0, q.y0);
          cover += ix * iy;
        } else {
          bad = true;                                      // 硬障碍：相交即挡
        }
      }
    }
    if(!bad && cover / area >= PIN_SOVER_RATIO) bad = true;
    if(bad) hidden.push(it.key);
    else kept.push(box);
  });
  return hidden;
}
/* 量出 .sp-name 的真实盒子，转成 declutterNames 需要的参数。
   offsetWidth/offsetHeight 是布局后的值，jsdom 里恒为 0，所以取不到时返回 null 走估算。 */
function measureNameBox(el, sx, sy){
  if(!el || !el.offsetWidth || !el.offsetHeight) return null;
  var w = el.offsetWidth, h = el.offsetHeight;
  return { hw: w / 2, ht: LABEL_TOP, hb: LABEL_TOP + h + 2 };
}
/* 量出一个 pin 的「圆 + 徽标」相对锚点的框，交给 declutterNames 当软障碍。
   圆和徽标都是固定尺寸的，量不到就用常量兜底 —— 绝不能返回 null：
   applyNameDeclutter 是在 new SpotPin() 之后同步跑的，此时 TMap 往往还没把
   DOM 挂进覆盖物容器，offsetWidth 全是 0。一旦这里给 null，
   邻居圆这道障碍就整条失效，「湖北省科学技术馆」被隔壁 pin 压掉 45% 也照样显示。 */
function measurePinBody(rec){
  var hw = PIN_BODY_HW, top = PIN_BODY_TOP;
  var pin = rec.pinEl;
  if(pin && pin.offsetWidth && pin.offsetHeight){
    hw = pin.offsetWidth / 2;
    top = -pin.offsetHeight;              // .sp-pin 盒底对在锚点，圆顶 = -盒高
  }
  var b = rec.badgeEl;
  if(b && b.offsetWidth && b.offsetHeight){
    if(b.offsetWidth / 2 > hw) hw = b.offsetWidth / 2;
    top = top - b.offsetHeight - 6;       // 徽标悬在圆上方 6px
  } else if(!pin || !pin.offsetWidth){
    top = PIN_BODY_TOP - PIN_BADGE_H - 6; // 没徽标的 pin 就按有徽标的留够位置，宁可挡多一点
  }
  return { dx0: -hw, dx1: hw, dy0: top, dy1: 0 };
}
/* 实测屏幕矩形（视口坐标）。
   为什么必须实测、不能靠 app.js 记的 sx/sy：
   sx/sy 是 renderPinsForZoom 建层那一瞬间的投影结果，而地图随后还会自己动 ——
   初始定位动画、用户拖动都会平移底图，TMap 把 .spotpin 挪到新位置，
   但 pinRecs 里的 sx/sy 不会跟着更新。实测就撞上过：
   「湖北省科学技术馆」记的锚点是 y=560，DOM 实际已经在 y=812，差 250px。
   拿过期坐标判遮挡，结果是一条都没判出来，标签照旧叠在一起。 */
function measureAbsBox(el){
  if(!el) return null;
  var r = el.getBoundingClientRect();
  if(!r || (!r.width && !r.height)) return null;
  return { x0: r.left, x1: r.right, y0: r.top, y1: r.bottom };
}
/* pin 的「圆 + 徽标」实测矩形：两者取并集。 */
function measureAbsBody(rec){
  var box = null;
  [rec.pinEl, rec.badgeEl].forEach(function(el){
    var b = measureAbsBox(el);
    if(!b) return;
    box = box
      ? { x0: Math.min(box.x0, b.x0), x1: Math.max(box.x1, b.x1),
          y0: Math.min(box.y0, b.y0), y1: Math.max(box.y1, b.y1) }
      : b;
  });
  return box;
}
/* 地图四角的「死亡区」：常驻的控件浮层 —— 我们的 .sp-name 飘进去就直接压字、压图标。
   这里是量真实元素，不是写死矩形。写死的坑：比例尺 .tmap-scale-control 的宽度随缩放级别
   变（实测「5 公里」那档是 122×35），换个缩放级别矩形就对不上；
   而且缩放 +/- 和罗盘其实在**右上角**，不在右下角 —— 一开始就是按「控件都堆在右下」想当然
   写的，结果右下整整 220px 高全划成禁区，白白浪费一片标签位。
   量不到（TMap 换版本改了类名）才退回按地图容器推的保守矩形。 */
var DEAD_ZONE_SELECTORS = [
  '.tmap-scale-control',              // 左下：比例尺（宽度随缩放级别变）
  '.logo-text',                       // 左下：腾讯地图版权文字
  '#map a[href*="map.qq.com"]',       // 左下：腾讯地图 logo（.logo-text 的兄弟节点）
  '.rotate-circle',                   // 右上：罗盘
  '.tmap-zoom-control',               // 右上：缩放 +/-（在罗盘正下方）
  '#locateBtn'                        // 右下：定位按钮（这个是我们自己的）
];
var DEAD_ZONE_PAD = 6;                 // 往外留一点，别让文字贴着控件边缘
function collectDeadZones(){
  var zones = [];
  DEAD_ZONE_SELECTORS.forEach(function(sel){
    var r = measureAbsBox(document.querySelector(sel));
    if(!r || (r.x1 - r.x0) < 2 || (r.y1 - r.y0) < 2) return;   // 隐藏 / 0 尺寸跳过
    zones.push({ x0: r.x0 - DEAD_ZONE_PAD, x1: r.x1 + DEAD_ZONE_PAD,
                 y0: r.y0 - DEAD_ZONE_PAD, y1: r.y1 + DEAD_ZONE_PAD });
  });
  if(zones.length) return zones;
  // 兜底：TMap 改了类名时的保守矩形（位置按实测控件定的，右下只留定位按钮那一小块）
  var host = document.getElementById('mapwrap') || document.getElementById('map');
  if(!host) return zones;
  var hr = host.getBoundingClientRect();
  if(!hr.width || !hr.height) return zones;
  zones.push({ x0: hr.left - DEAD_ZONE_PAD, x1: hr.left + 300,
               y0: hr.bottom - 64 - DEAD_ZONE_PAD, y1: hr.bottom + DEAD_ZONE_PAD });
  zones.push({ x0: hr.right - 64 - DEAD_ZONE_PAD, x1: hr.right + DEAD_ZONE_PAD,
               y0: hr.top - DEAD_ZONE_PAD, y1: hr.top + 210 + DEAD_ZONE_PAD });
  zones.push({ x0: hr.right - 64 - DEAD_ZONE_PAD, x1: hr.right + DEAD_ZONE_PAD,
               y0: hr.bottom - 64 - DEAD_ZONE_PAD, y1: hr.bottom + DEAD_ZONE_PAD });
  return zones;
}
/* 名字去遮挡的落地。
   pass=1 表示「DOM 已经挂进地图容器，可以实测」，这时一律用实测矩形；
   不传 pass 时（建层那一刻）只能退回 sx/sy + 估算值。
   实测这一趟由 renderPinsForZoom 建完层后主动触发、并挂在 moveend 上重跑，
   而不是排到下一帧 —— 页面不可见时 rAF 根本不执行，靠它兜底不可靠。 */
function applyNameDeclutter(pinRecs, laid, pass){
  if(!pinRecs.length) return;
  var useAbs = !!pass;
  var items = pinRecs.map(function(rec, i){
    var m = measureNameBox(rec.nameEl, rec.sx, rec.sy) || {};
    return {
      key: i, sx: rec.sx, sy: rec.sy, r: 0, hasName: true,
      hw: m.hw, ht: m.ht, hb: m.hb,
      soft: measurePinBody(rec),
      abs: useAbs ? measureAbsBox(rec.nameEl) : null,
      absSoft: useAbs ? measureAbsBody(rec) : null
    };
  });
  (laid || []).forEach(function(g){
    if(g.src && g.src.spot) return;
    items.push({ key: -1, sx: g.sx, sy: g.sy, r: g.r, hasName: false });
  });
  /* 外部障碍只在实测趟（pass=1）接进来。
     它们是 getBoundingClientRect 量出来的**视口**坐标，而 sx/sy 那条老路走的是
     地图容器坐标，两者不是一个坐标系 —— 混在一起判必然错位。 */
  var extBlocks = [];
  if(useAbs){
    /* 四角死亡区是现在唯一的外部障碍。底图 POI 文字曾经是第二种：这版 TMap（JSAPI v3）
       把底图 POI 文字直接画进 <canvas>、不进 DOM，getPanes() 里也没有 label pane，
       那次采集实测恒返回 []，已连采集函数一起删掉 —— 它让每次 moveend / zoomend /
       resize 都白跑一次全子树类名扫描。要加回来的前提：先在浏览器里实测确认底图文字
       确实进了 DOM，别照着旧代码直接抄回来。 */
    collectDeadZones().forEach(function(z){
      items.push({ key: -1, hasName: false, extHard: z });
      extBlocks.push(z);
    });
  }
  var hidden = declutterNames(items);
  hidden.forEach(function(i){
    var el = pinRecs[i] && pinRecs[i].nameEl;
    if(el) el.style.display = 'none';
  });
  declutterBadges(pinRecs, extBlocks);
}
/* .sp-badge 与底图 POI 文字的避让 —— 用户报过「陈子海」压住「需预约」。
   徽标（需预约 / 需购票）悬在 pin 圆的正上方，是一块小而实的文字，
   底图的 POI 文字飘过来会直接压在上面，两块深色小字叠在一起谁也读不出来。
   为什么不像名字那样「藏了就一起藏」：名字被藏往往是被隔壁 pin 挤掉的，跟底图无关，
   跟着藏等于白丢预约状态。只在底图文字真的盖住徽标时才藏，判定沿用同一套面积比规则。
   徽标也没有别的位置可挪（挪到圆的下方会跟 .sp-name 正面撞上），
   而预约状态在详情弹窗和左侧列表里都还在，藏起来不算丢信息。 */
function declutterBadges(pinRecs, blocks){
  if(!blocks || !blocks.length) return;
  for(var i = 0; i < pinRecs.length; i++){
    var rec = pinRecs[i];
    if(!rec || !rec.badgeEl) continue;
    var box = measureAbsBox(rec.badgeEl);
    if(!box) continue;
    var area = Math.max(1, (box.x1 - box.x0) * (box.y1 - box.y0));
    var cover = 0;
    for(var b = 0; b < blocks.length; b++){
      var q = blocks[b];
      if(box.x0 >= q.x1 || box.x1 <= q.x0 || box.y0 >= q.y1 || box.y1 <= q.y0) continue;
      if(!q.soft){ cover = area; break; }        // 死亡区：进去就藏，不看面积
      cover += (Math.min(box.x1, q.x1) - Math.max(box.x0, q.x0)) *
               (Math.min(box.y1, q.y1) - Math.max(box.y0, q.y0));
    }
    if(cover / area >= PIN_SOVER_RATIO) rec.badgeEl.style.display = 'none';
  }
}
/* 重新判一次遮挡：先把上一轮藏掉的标签全部放回来，再按实测位置重判。
   必须先恢复 —— 只藏不恢复的话，一次平移之后被藏的标签就永远回不来了。
   挂在 moveend 上而不是排进 rAF：页面不可见时 rAF 根本不执行。 */
var nameDeclutterCtx = null;
function runNameDeclutter(){
  var ctx = nameDeclutterCtx;
  if(!ctx || !ctx.pinRecs.length) return;
  ctx.pinRecs.forEach(function(r){
    if(r.nameEl) r.nameEl.style.display = '';
    // 徽标也必须一起放回来：只恢复名字的话，徽标被底图文字压过一次之后，
    // 平移开就再也回不来了（「需预约」凭空消失）
    if(r.badgeEl) r.badgeEl.style.display = '';
  });
  applyNameDeclutter(ctx.pinRecs, ctx.laid, 1);
}
var declutterQueued = false;
function scheduleNameDeclutter(){
  if(declutterQueued) return;
  declutterQueued = true;
  requestAnimationFrame(function(){
    declutterQueued = false;
    runNameDeclutter();
  });
}
window.__tmapMap.on('moveend', scheduleNameDeclutter);
window.__tmapMap.on('zoomend', scheduleNameDeclutter);
/* 视口一变，四角死亡区和所有实测矩形就一起作废（坐标全是按旧视口量的），
   而 TMap 的 resize 既不冒 moveend 也不冒 zoomend —— 不补这一条的话，
   转手机、拖窗口边缘、拉出软键盘之后，控件上又会重新压出名字和徽标。
   这里刻意不直接调 scheduleNameDeclutter：resize 是连着几十帧来的，
   每帧重跑一遍 50 个 pin 的遮挡判定太浪费，等停下来再算一次。 */
var declutterResizeTimer = null;
window.addEventListener('resize', function(){
  clearTimeout(declutterResizeTimer);
  declutterResizeTimer = setTimeout(scheduleNameDeclutter, 120);
});
/* ================== 聚合气泡已下线 ==================
   原来低缩放级别用一块 canvas 画实心聚合圈（ClusterCanvas）：
   红色实心圆 + 光晕 + 白边 + 高光渐变，整块盖住底图。
   现在所有分组一律渲染成 emoji pin —— 合并出来的组用「离质心最近的真实景点」
   当代表，圆心压在真实坐标上，点开仍然列该组的全部景点（clusterQuickList）。
   因此 canvas 聚合层、命中检测、hover 光环全部失去用处，连同 bubbleColor 一起删除。
   bubbleRadius 还在：clusterLayout 用它算一组的互斥半径。 */
var spotOverlays = [];       // 当前渲染的 DOMOverlay 实例（rename from overlays 避免 SDK with() 作用域冲突）
function _maxCrowdLevelInner(geoms){
  var lv = 0;
  geoms.forEach(function(g){ lv = Math.max(lv, CROWD[SPOTS[g.properties.index].crowd]); });
  return lv;
}
function _clusterSummaryInner(geoms){
  var hi = 0, mid = 0, lo = 0;
  geoms.forEach(function(g){
    var c = CROWD[SPOTS[g.properties.index].crowd];
    if(c === 2) hi++; else if(c === 1) mid++; else lo++;
  });
  return { total: geoms.length, hi: hi, mid: mid, lo: lo };
}
// 兼容旧引用（SDK 内部 createDOM 调用 maxCrowdLevel → 用 window 上的全局版）
var maxCrowdLevel = window.maxCrowdLevel;
var clusterSummary = window.clusterSummary;
/* 点击聚合气泡 → 弹出/关闭「这里 N 个景点」快捷列表（点某条进入详情） */
var clusterListEl = null;
var clusterListCenter = null;
function closeClusterList(){
  if(clusterListEl){ clusterListEl.remove(); clusterListEl = null; clusterListCenter = null; }
  // 列表是 body 下的独立 DOM，没有 .clusterBubble 那种需要额外维护的状态
}
function clusterQuickList(geoms, center){
  // 同一聚类再次点击 → 关闭
  if(clusterListEl && clusterListCenter && center && Math.abs(clusterListCenter.lng - center.lng) < 1e-6 && Math.abs(clusterListCenter.lat - center.lat) < 1e-6){
    closeClusterList();
    return;
  }
  closeClusterList();
  var spots = geoms.map(function(g){ return SPOTS[g.properties.index]; });
  var lv = maxCrowdLevel(geoms);
  var color = crowdColorOn ? COLOR[lv] : CROWD_OFF_COLOR;
  var div = document.createElement('div');
  div.className = 'cluster-list';
  div.style.setProperty('--cl-accent', color);
  div.setAttribute('role', 'dialog');
  div.setAttribute('aria-label', '附近 ' + spots.length + ' 个景点');
  var items = spots.map(function(s){
    var i = getSpotIndex(s);
    var crowdCls = CROWD_CLS[s.crowd] || 't-lo';
    return '<div class="cl-item" data-i="'+i+'"><span class="cl-emoji">'+esc(s.emoji)+'</span><span class="cl-name">'+esc(s.name)+'</span><span class="cl-crowd '+crowdCls+'">人流'+esc(s.crowd)+'</span></div>';
  }).join('');
  div.innerHTML = '<div class="cl-head"><span class="cl-title">📍 附近 <b>'+spots.length+'</b> 个景点</span><span class="cl-x" title="关闭" aria-label="关闭" role="button">✕</span></div><div class="cl-c">'+items+'</div>';
  var wrap = document.getElementById('mapwrap');
  wrap.appendChild(div);
  clusterListEl = div;
  clusterListCenter = { lng: center.lng, lat: center.lat };
  var w = div.offsetWidth || 240;
  var h = div.offsetHeight || 200;
  /* 先绑事件再定位。
     原来定位写在前面，而 projectToContainer 只认 TMap.LatLng 实例，
     传普通对象 {lng,lat} 会返回 null → 下面 px.getX() 直接抛，
     于是「✕ 关闭」和「点条目进详情」根本绑不上 —— 列表弹得出来但完全点不动。
     projectToContainer(center) / new TMap.LatLng(...) 都是括号形式，
     TMap 的 with() 作用域下不能裸写 LatLng。 */
  div.querySelector('.cl-x').onclick = function(e){ e.stopPropagation(); closeClusterList(); };
  div.querySelectorAll('.cl-item').forEach(function(el){
    el.onclick = function(e){
      e.stopPropagation();
      var i = +el.dataset.i;
      closeClusterList();
      select(i, true);
    };
  });
  // 定位失败也不能让列表变成死的，try 兜住即可
  try{
    var px = window.__tmapMap.projectToContainer(new TMap.LatLng(center.lat, center.lng));
    if(px){
      var x = px.getX() - w/2;
      var y = px.getY() - h/2;
      x = Math.max(8, Math.min(x, wrap.clientWidth - w - 8));
      y = Math.max(8, Math.min(y, wrap.clientHeight - h - 8));
      div.style.left = x + 'px'; div.style.top = y + 'px';
    }
  }catch(e){}
  // 列表是 body 下的独立 DOM，没有 .clusterBubble 那种需要额外维护的状态
}
function renderAllPins(){
  if(!window.__tmapMap) return;
  lastPinMode = 'pin';                  // 与 renderPinsForZoom 共享模式记录，避免下一次缩放被守卫误判
  spotOverlays.forEach(function(o){ o.destroy(); });
  spotOverlays = [];
  SPOTS.forEach(function(s, i){
    var p = new SpotPin({ map: window.__tmapMap, position: new TMap.LatLng(s.lat, s.lng), spot: s });
    (function(idx){ p.on('click', function(){ openInfo(SPOTS[idx]); }); })(i);
    spotOverlays.push(p);
  });
}
/* 按当前 zoom 决定显示模式
   - zoom >= 13：单点 pin（看清详情）
   - zoom < 13：按格子聚类（减少视觉杂乱） */
/* 格子大小随 zoom 走，单位是「度」，但标定成「屏幕上固定多少像素」。
   为什么不能是常数：原来 GRID_SIZE 固定 0.012°，在 z=11 才约 13px，
   而气泡直径 40+px —— 格子比圈小 3 倍，于是满屏都在叠。
   也不能只交给屏幕空间去重：那是单链聚类，武汉主城区密度下会一路连锁，
   实测 50 个景点塌成 1 个「附近 33 个景点」的大圈，等于把地图废掉。
   所以主聚类交给经纬度格子（天然不会连锁、每格点数有界），
   屏幕空间去重只留作兜底，处理「两个格子边界上挨太近」这种零星情况。 */
var GRID_TARGET_PX = 64;   // 格子在屏幕上的边长：约等于一个气泡直径 + 缝隙
var GRID_LNG_PX = 156543.03392 / 111320;   // 米/像素 ÷ 米/度 ≈ 1.4063（cos 在经纬各自算时约掉）
var GRID_LAT_PX = 156543.03392 / 110574;   // ≈ 1.4158
function clusterGridDeg(zoom){
  var k = Math.pow(2, zoom);
  return {
    lng: GRID_TARGET_PX * GRID_LNG_PX / k,
    lat: GRID_TARGET_PX * GRID_LAT_PX / k
  };
}
/* pin 的屏幕占位（相对 projectToContainer 给出的锚点）。
   关键：SpotPin.updateDOM 是 left = px - w/2、top = py - 42，也就是把 42px 盒子的「底边」
   对在锚点上 —— 圆心其实落在锚点上方 21px，不是锚点本身。
   所以纵向要同时盖住「圆的上缘 -42」和「名字标签的下缘 +31」，半径不是对称的，
   这里用对称写法取大的那个 44。横向就是圆直径 42，半径 21，留点余量取 26。
   （早先按 28/34 算，漏掉了上方那 8~10px，于是 pin 的上半截会压到隔壁的圈。） */
var PIN_RX = 26;              // pin 互斥半轴（横）
var PIN_RY = 44;              // pin 互斥半轴（纵）：上缘 -42、下缘 +31 都得盖住
var lastPinMode = null;                 // 上次渲染模式（'pin' / 'cluster'），只用于判断要不要重建
var lastPinBucket = null;               // 上次的 zoom 档位；格子随 zoom 变，跨档要重算
/* 经纬度 → 容器像素。clusterLayout 要用它做屏幕空间的相交检测。 */
function projectToContainerFn(mapRef){
  return function(lat, lng){
    var p = mapRef.projectToContainer(new TMap.LatLng(lat, lng));
    return { x: p.getX(), y: p.getY() };
  };
}
function renderPinsForZoom(force){
  if(!window.__tmapMap) return;
  var zoom = window.__tmapMap.getZoom();
  var mode = zoom >= 13 ? 'pin' : 'cluster';
  /* 什么时候需要重算分组？
     聚合模式下答案是「视图一变就得重算」，因为去重叠是拿屏幕像素判定的：
     格子边长按 zoom 标定成固定像素、pin 与气泡的间距也是像素值，
     zoom 一动这些关系就全变了。所以这里按 zoom 的实际值（0.05 一档）守门，
     而不是按「是否跨过 13」这种布尔 —— 之前那个守门是给纯散点模式准备的，
     套到聚合模式上就成了「分组只算一次」，于是初始动画一落位就露馅：
     圆压回 pin 上、pin 的名字标签被旁边的气泡盖住。
     代价是连续滚轮时会比重排（scheduleRenderPins 有 100ms 防抖兜着），
     但重排出来的是十来个覆盖物，不是早先那 50 个 pin。 */
  var bucket = mode === 'pin' ? 'pin' : Math.round(zoom * 20);
  if(!force && mode === lastPinMode && bucket === lastPinBucket) return;
  lastPinMode = mode;
  lastPinBucket = bucket;
  spotOverlays.forEach(function(o){ o.destroy(); });
  spotOverlays = [];
  if(zoom >= 13){
    // 单点（zoom 高，需要看清详情，用 DOM SpotPin）
    // 高 zoom 下 50 个 pin 铺开，密集区（东湖/江汉）名字照样会互相盖：
    // 建完之后量真实宽度再判遮挡，和聚合模式走同一条路径。
    var proj13 = projectToContainerFn(window.__tmapMap);
    var recs13 = [];
    SPOTS.forEach(function(s, i){
      var p = new SpotPin({ map: window.__tmapMap, position: new TMap.LatLng(s.lat, s.lng), spot: s });
      (function(idx){ p.on('click', function(){ openInfo(SPOTS[idx]); }); })(i);
      spotOverlays.push(p);
      var px13 = proj13(s.lat, s.lng);
      recs13.push({
        sx: px13.x, sy: px13.y,
        nameEl: p.dom ? p.dom.querySelector('.sp-name') : null,
        pinEl: p.dom ? p.dom.querySelector('.sp-pin') : null,
        badgeEl: p.dom ? p.dom.querySelector('.sp-badge') : null
      });
    });
    nameDeclutterCtx = { pinRecs: recs13, laid: [] };  // 没有气泡，遮挡只来自标签与邻居 pin
    runNameDeclutter();
  } else {
    // 聚合层：按随 zoom 缩放的经纬度格子分组，组内出一枚代表景点的 emoji pin
    var gsz = clusterGridDeg(zoom);
    var buckets = {};
    SPOTS.forEach(function(s, i){
      var key = Math.floor(s.lng / gsz.lng) + ':' + Math.floor(s.lat / gsz.lat);
      if(!buckets[key]) buckets[key] = { spots: [] };
      buckets[key].spots.push({ s: s, i: i });
    });
    /* 低 zoom 下「堆叠」有两个来源，之前只治了后一个：
       1) 多点桶画成大圆（直径 40+px），而格子只有 ~13px —— 圆必然互相压；
       2) 单点桶降级成 emoji pin（42px 直径 + 一行名字），同样远大于格子，
          东湖那一带的 pin 会连成一坨，名字互相盖住。
       现在主聚类交给上面那个随 zoom 缩放的格子（每格边长 ≈ 一个圈的直径，天然不连锁），
       这里再用屏幕空间布局兜一遍底：只处理「两个格子边界上挨太近」的零星情况，
       撞上了就合并，圆心仍停在真实景点上。
       （这里绝不能靠屏幕空间单独定簇大小：单链聚类在主城区会连锁，实测 50 个景点塌成一个大圈。）
       这一步不剔屏外：曾经拿 map.getContainer().clientHeight 剔，实测它返回 720、
       而容器实际是 887，尺寸不准就会把本该显示的 pin 直接剔没了。
       屏外的 pin 本来也只是几个 DOM 节点，交给浏览器自己丢弃即可。
       不剔的代价只是几个屏外的圈，绘制时会被剔掉；pin 本来也只是个 DOM 覆盖物。 */
    var items = [];
    Object.keys(buckets).forEach(function(key){
      var b = buckets[key];
      // 代表点取格子内离质心最近的那个真实景点，不是质心本身。
      // 质心是几个景点的算术平均，落在它们之间的空地上 —— 这就是「圈浮空」的来源；
      // 只有让圆心压在一个真实景点上，点开列表时那个坐标才对得上号。
      var cLng = 0, cLat = 0;
      b.spots.forEach(function(x){ cLng += x.s.lng; cLat += x.s.lat; });
      cLng /= b.spots.length; cLat /= b.spots.length;
      var anchor = b.spots[0];
      var bestD = Infinity;
      b.spots.forEach(function(x){
        var dx = x.s.lng - cLng, dy = x.s.lat - cLat;
        var d = dx * dx + dy * dy;
        if(d < bestD){ bestD = d; anchor = x; }
      });
      var multi = b.spots.length > 1;
      items.push({
        lat: anchor.s.lat, lng: anchor.s.lng,
        geoms: b.spots.map(function(x){ return {properties:{index:x.i}}; }),
        // 不再区分「单点 pin」和「聚合气泡」：两种都出 emoji pin。
        // 合并出来的组也带 spot，圆心用的就是那个「离质心最近的真实景点」，
        // 点开列清单，不存在圆心浮在空地上的问题。
        src: { spot: anchor.s, idx: anchor.i, multi: multi },
        // 单点 pin 的互斥范围要盖住 .spotpin 本体 + 下方名字标签；
        // 组不指定，半径由 clusterLayout 按 bubbleRadius(组内数量) 自己算。
        rx: multi ? undefined : PIN_RX,
        ry: multi ? undefined : PIN_RY
      });
    });
    var laid = clusterLayout(items, projectToContainerFn(window.__tmapMap), Infinity, Infinity);
    var pinRecs = [];      // {sx, sy, nameEl}：等全部建出来、量到真实宽度后再判遮挡
    laid.forEach(function(g){
      var src = g.src || {};
      if(!src.spot) return;
      var p = new SpotPin({
        map: window.__tmapMap,
        position: new TMap.LatLng(g.lat, g.lng),
        spot: src.spot
      });
      if(src.multi){
        /* 这一格里有多个景点 → 点开列清单，而不是只跳到代表景点。
           同样要推迟到本次点击派发之后再开：map.on('click') 会 closeClusterList()，
           而那是 TMap 内部捕获阶段绑定的，stopPropagation 拦不住。 */
        (function(geoms, ctr){ p.on('click', function(){
          setTimeout(function(){ clusterQuickList(geoms, ctr); }, 0);
        }); })(g.geoms, { lng: g.lng, lat: g.lat });
      } else {
        (function(idx){ p.on('click', function(){ openInfo(SPOTS[idx]); }); })(src.idx);
      }
      spotOverlays.push(p);
      pinRecs.push({
        sx: g.sx, sy: g.sy,
        nameEl: p.dom ? p.dom.querySelector('.sp-name') : null,
        pinEl: p.dom ? p.dom.querySelector('.sp-pin') : null,
        badgeEl: p.dom ? p.dom.querySelector('.sp-badge') : null
      });
    });
    nameDeclutterCtx = { pinRecs: pinRecs, laid: laid };
    runNameDeclutter();
  }
}
function renderCluster(){
  // 必须走 renderPinsForZoom，而不是 renderAllPins：
  // renderAllPins 会在任何缩放级别都铺满 50 个 pin，等于把 zoom<13 的分档聚合策略覆盖掉，
  // 于是每次筛选（applyFilters → setGeometries → cluster_changed）之后地图会突然变回散点模式。
  if(typeof window.renderPinsForZoom === 'function') return window.renderPinsForZoom();
  renderPinsForZoom();
}
function allGeoms(){
  return SPOTS.map(function(s, i){
    return { id: 's'+i, position: new TMap.LatLng(s.lat, s.lng), properties: { index: i } };
  });
}
var markerCluster;
function initMarkerCluster(){
  var mapRef = window.__tmapMap;
  if (!mapRef) return false;
  try {
    markerCluster = new TMap.MarkerCluster({
      id: 'cluster',
      map: mapRef,
      enableDefaultStyle: false,
      minimumClusterSize: 2,
      gridSize: 60,
      averageCenter: false,
      geometries: allGeoms()
    });
    markerCluster.on('cluster_changed', renderCluster);
    return true;
  } catch(e){
    console.warn('[markerCluster init deferred]', e && e.message);
    return false;
  }
}
initMarkerCluster();
// 重试加次数上限：SDK 若始终加载不出来，别以 2Hz 无限空转。
// 20 次 × 500ms ≈ 10s，远大于 SDK 正常加载耗时，到点仍失败就放弃（自建覆盖物不依赖它）。
var markerClusterRetry = null;
if (!markerCluster){
  var initAttempts = 0;
  markerClusterRetry = setInterval(function(){
    if(initMarkerCluster() || ++initAttempts >= 20){
      clearInterval(markerClusterRetry);
      markerClusterRetry = null;
    }
  }, 500);
}
// 直接渲染 50 个 SpotPin（绕过 markerCluster 内部初始化竞态）
setTimeout(function(){
  try {
    renderPinsForZoom();
  } catch(e) {
    console.warn('[renderPinsForZoom failed]', e && e.message);
  }
  // 关键：把内部变量绑定到 window，让外部代码（包括 scheduleRenderPins 回调、调试 console）能访问
  // setTimeout 闭包能访问 startApp 函数级变量，因此赋值给 window 的属性就是函数执行时的对象
  window.spotOverlays = spotOverlays;
  window.markerCluster = markerCluster;
  window.applyFilters = applyFilters;
  window.renderCluster = renderCluster;
  window.renderPinsForZoom = renderPinsForZoom;
  window.initMarkerCluster = initMarkerCluster;
  window.scheduleRenderPins = scheduleRenderPins;
  // 定位相关函数暴露
  window.locateMe = locateMe;
  window.drawMyPosMarker = drawMyPosMarker;
  window.wgsToGcj = wgsToGcj;
  window.myPos = myPos;
  // maxCrowdLevel / clusterSummary 已在 startApp 外重新定义（供 SDK 内部 createDOM 访问）
  window.startAppReady = true;
}, 200);

/* ================== 侧栏 ================== */
var list = document.getElementById('list');
/* 列表事件委托：只在容器上注册一次，选中/加入路线统一处理，避免每次重建列表都逐个绑定 */
list.addEventListener('click', function(e){
  var t = e.target && e.target.closest ? e.target.closest('.item-add, .item') : null;
  if(!t || !list.contains(t)) return;
  if(t.classList.contains('item-add')){ e.stopPropagation(); toggleWaypoint(t.dataset.name); return; }
  if(t.classList.contains('item')) select(t.dataset.id, true);
});
list.addEventListener('keydown', function(e){
  if(e.key !== 'Enter' && e.key !== ' ') return;
  var el = e.target;
  if(el && el.classList && el.classList.contains('item') && el === e.target){ e.preventDefault(); select(el.dataset.id, true); }
});
function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
/* HTML 转义：把外部/用户数据安全放进 innerHTML */
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
/* 为 promise 加超时：避免地图/网络服务卡住时无限转圈（不真正中止请求，但 UI 可及时反馈） */
function withTimeout(p, ms, msg){
  var called = false;
  return new Promise(function(res, rej){
    var t = setTimeout(function(){ called = true; rej(new Error(msg || '请求超时')); }, ms);
    p.then(function(v){ if(called) return; clearTimeout(t); res(v); }, function(e){ if(called) return; clearTimeout(t); rej(e); });
  });
}
/* 命中的搜索词高亮（列表 + 联想下拉共用） */
function hl(t){
  if(!keyword || t.indexOf(keyword) < 0) return t;
  return t.replace(new RegExp('('+escapeRe(keyword)+')','g'),'<mark>$1</mark>');
}
/* 行节点拆成「外层属性」+「内部内容」两部分，好让 keyed diff 复用节点时只换内部内容 */
function rowAttrs(s){
  return 'data-id="'+getSpotIndex(s)+'" tabindex="0" role="button" aria-label="'+esc(s.name)+'"';
}
function rowInnerHTML(s){
  var srcBadge = getSrcBadge(s);
  var r = getReserveInfo(s);
  var rname = r[0];
  var crowdCls = CROWD_CLS[s.crowd] || 't-lo';
  var advice = getCrowdAdvice(s);
  var resCls = s.reserve==='free'?'t-lo':s.reserve==='need_reserve'?'t-res':'t-tick';
  var os = openState(s), osTag = os ? '<span class="tag t-'+os.cls+'">'+esc(os.text)+'</span>' : '';
  return '<div class="it-emoji">'+esc(s.emoji)+'</div>'+
    '<div class="it-body">'+
      '<div class="it-name">'+hl(esc(s.name))+'</div>'+
      '<div class="it-sub">'+esc(s.cat)+'</div>'+
      '<div class="it-tags"><span class="tag '+crowdCls+'">'+CROWD_TXT[s.crowd]+'</span>'+osTag+'<span class="tag t-adv '+advice.shortCls+'">'+esc(advice.short)+'</span><span class="tag '+resCls+'">'+esc(rname)+'</span>'+srcBadge+'</div>'+
    '</div>'+
    '<button class="item-add" title="添加到路线" data-name="'+esc(s.name)+'" aria-label="添加 '+esc(s.name)+' 到路线" aria-pressed="false">+</button>';
}
var crowdF = '', resF = '', zoneF = '', metroF = '', keyword = '', sortBy = '', lastGeoKey = null;   // lastGeoKey：setGeometries 去重，成员集未变则不重复聚合
function kwMatch(s, kw){ kw = String(kw||'').toLowerCase(); return s.name.toLowerCase().indexOf(kw)>=0 || s.cat.toLowerCase().indexOf(kw)>=0 || (s.tip||'').toLowerCase().indexOf(kw)>=0 || (s.metro||'').toLowerCase().indexOf(kw)>=0; }

/* ---- 列表 keyed DOM diff ----
   以前每次筛选都用 innerHTML 整块重建：50+ 行 × 8 个子节点全部销毁重建，
   丢掉键盘焦点、重复跑一遍样式计算，还制造大量垃圾给 GC。
   现在按 data-id 复用旧节点：内容没变就一个字节都不写，变了才替换内部 HTML；
   顺序变化用 insertBefore 就地纠正 —— 多数筛选场景（加/减筛选项）移动次数为 0。 */
var listNodes = new Map();                 // data-id -> .item 元素
/* 行内的「加入路线」按钮缓存到节点上：syncAddButtons 直接取，
   不必再对整个列表做 querySelectorAll。innerHTML 被替换后必须重新缓存。 */
function cacheRowButtons(el){
  el._addBtn = el.querySelector('.item-add');
}
function renderListRows(all){
  if(!all || !all.length){
    if(list._emptyRendered) return;        // 空态已经显示，不必重复重排
    list.innerHTML = '<div class="empty">没有匹配的景点</div>';
    listNodes.clear();
    list._emptyRendered = true;
    return;
  }
  if(list._emptyRendered){ list.innerHTML = ''; listNodes.clear(); list._emptyRendered = false; }
  var cur = list.firstChild;               // 已就位的游标：cur 之前的节点顺序已正确
  for(var i = 0; i < all.length; i++){
    var s = all[i];
    var key = String(getSpotIndex(s));
    var inner = rowInnerHTML(s);
    var el = listNodes.get(key);
    if(el){
      if(el._h !== inner){ el.innerHTML = inner; el._h = inner; cacheRowButtons(el); }   // 复用节点，只换内容
    } else {
      var tpl = document.createElement('div');
      tpl.innerHTML = '<div class="item" ' + rowAttrs(s) + '>' + inner + '</div>';
      el = tpl.firstElementChild;
      el._h = inner;
      cacheRowButtons(el);
      listNodes.set(key, el);
    }
    if(cur === el) cur = cur.nextSibling;
    else list.insertBefore(el, cur);       // 位置不对就地搬家（不重建节点）
  }
  while(cur){                               // 剩下的都是本轮筛掉的旧节点，直接移除
    var nx = cur.nextSibling;
    list.removeChild(cur);
    cur = nx;
  }
  listNodes.forEach(function(node, k){ if(!node.isConnected) listNodes.delete(k); });
}
/* 单个景点是否通过全部筛选（C2/C3 的区域/地铁条件也在这里）。
   拆成独立谓词是为了可测：zoneMetro.test.js 直接抽真实源码跑。
   metroN 是预解析的线路号（0 = 不筛），避免热路径里反复 parseInt。 */
function spotPassesFilters(s, metroN){
  if(crowdF && s.crowd !== crowdF) return false;
  if(resF && s.reserve !== resF) return false;
  if(zoneF && s.zone !== zoneF) return false;
  if(metroN && (!s._lines || s._lines.indexOf(metroN) < 0)) return false;   // spots.json 合并新推入的景点可能没 _lines
  if(keyword && !kwMatch(s, keyword)) return false;
  return true;
}
function applyFilters(){
  var metroN = metroF ? parseInt(metroF, 10) : 0;
  var all = SPOTS.filter(function(s){ return spotPassesFilters(s, metroN); });
  // 结果排序：热度 / 距离
  if(sortBy === 'heat'){
    all = all.slice().sort(function(a,b){ return ((CROWD[b.crowd]||0)-(CROWD[a.crowd]||0)) || a.name.localeCompare(b.name); });
  } else if(sortBy === 'dist' && myPos){
    all = all.slice().sort(function(a,b){ return distTo(a) - distTo(b); });
  }
  renderListRows(all);
  // 更新聚合数据（同步筛选，成员集未变则跳过重复聚合）
  var geoKey = all.map(function(s){ return getSpotIndex(s); }).sort(function(a,b){ return a-b; }).join(',');
  if(geoKey !== lastGeoKey && markerCluster && typeof markerCluster.setGeometries === 'function'){
    try {
      markerCluster.setGeometries(all.map(function(s,i){ return { id:'s'+i, position:new TMap.LatLng(s.lat,s.lng), properties:{ index: getSpotIndex(s) } }; }));
      lastGeoKey = geoKey;
    } catch(e){
      // 静默：markerCluster 可能暂时未就绪（异步重试中）
    }
  }
  // 事件绑定统一走 list 上的委托（见下方 addEventListener 一次注册），避免每次重建都逐个绑定 50+ 节点
  syncAddButtons();
  if(selectedId != null){
    var selKey = String(selectedId);
    listNodes.forEach(function(el){ el.classList.toggle('sel', el.dataset.id === selKey); });
  }
}
function select(id, pan){
  selectedId = id;
  closeClusterList();
  var s = SPOTS[+id];
  list.querySelectorAll('.item').forEach(function(el){ el.classList.toggle('sel', el.dataset.id === id); });
  if(pan){
    window.__tmapMap.setCenter(new TMap.LatLng(s.lat, s.lng));
    window.__tmapMap.setZoom(14);
  }
  // 直接打开信息窗（不依赖聚合层）
  openInfo(s);
}
function bindChips(el, setter){
  el.querySelectorAll('.chip').forEach(function(ch){
    ch.tabIndex = 0; ch.setAttribute('role', 'button');
    ch.setAttribute('aria-pressed', ch.classList.contains('active') ? 'true' : 'false');
    ch.onclick = function(){
      var all = el.querySelectorAll('.chip');
      all.forEach(function(c){ c.classList.remove('active'); c.setAttribute('aria-pressed','false'); });
      ch.classList.add('active'); ch.setAttribute('aria-pressed','true');
      setter(ch.dataset.v);
      applyFilters();
      savePrefs();
    };
    ch.onkeydown = function(ev){ if(ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); ch.onclick(); } };
  });
}
bindChips(document.getElementById('cf-crowd'), function(v){ crowdF = v; });
bindChips(document.getElementById('cf-reserve'), function(v){ resF = v; });
bindChips(document.getElementById('cf-sort'), function(v){ sortBy = v; if(sortBy === 'dist' && !myPos){ sortBy = ''; applyChipActive(document.getElementById('cf-sort'), ''); toast('未定位到你的位置，无法按距离排序，已切回默认', 'info'); } });

/* ---- 区域·地铁筛选（C2/C3）----
   区域用 spots 的 zone 字段（spots.src.json 单源，build 校验白名单）；
   地铁线从 metro 文本提取 —— '2/6 号线'、'6 号/7 号线' 这类双线写法都要拆全。
   启动时预计算 _lines，applyFilters 热路径不再跑正则。 */
function metroLinesOf(s){
  // 先把 '6 号/7 号线' 归一化成 '6/7 号线'：斜杠前带「号」的写法会让
  // (\d+(?:\/\d+)*)\s*号线 在 "6 号" 处匹配失败、丢掉前一条线（zoneMetro.test.js 钉着这个坑）
  var txt = String(s.metro || '').replace(/\s*号\s*\//g, '/');
  var out = [], m, re = /(\d+(?:\s*\/\s*\d+)*)\s*号线/g;
  while((m = re.exec(txt))){
    m[1].split('/').forEach(function(p){ var n = parseInt(p, 10); if(n && out.indexOf(n) < 0) out.push(n); });
  }
  return out;
}
function initZoneMetro(){
  SPOTS.forEach(function(s){ s._lines = metroLinesOf(s); });
  var lines = [];
  SPOTS.forEach(function(s){ s._lines.forEach(function(n){ if(lines.indexOf(n) < 0) lines.push(n); }); });
  lines.sort(function(a, b){ return a - b; });
  var mc = document.getElementById('metroChips');
  if(mc){
    mc.innerHTML = '<span class="chip active" data-v="">地铁不限</span>' +
      lines.map(function(n){ return '<span class="chip" data-v="' + n + '">' + n + ' 号线</span>'; }).join('');
    bindChips(mc, function(v){ metroF = v; });
  }
  var zc = document.getElementById('zoneChips');
  if(zc) bindChips(zc, function(v){ zoneF = v; });
}
initZoneMetro();

/* ---- 搜索联想下拉 + 命中高亮 ---- */
var qInput = document.getElementById('q');
var qListEl = document.getElementById('qList');
var qSelIdx = -1, qDebounce = null;
qInput.setAttribute('role', 'combobox');
qInput.setAttribute('aria-expanded', 'false');
qInput.setAttribute('aria-autocomplete', 'list');
qInput.setAttribute('aria-controls', 'qList');
qListEl.setAttribute('role', 'listbox');
qListEl.setAttribute('aria-labelledby', 'q');
function setQActive(ix){
  qSelIdx = ix;
  var items = qListEl.querySelectorAll('.q-item');
  items.forEach(function(el, j){
    var on = j === ix;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  qInput.setAttribute('aria-activedescendant', ix >= 0 ? 'qOpt-' + ix : '');
  var target = items[ix];
  if(target && target.scrollIntoView) target.scrollIntoView({block:'nearest'});
}
function hideQList(){ qListEl.style.display = 'none'; qSelIdx = -1; qInput.setAttribute('aria-expanded', 'false'); qInput.removeAttribute('aria-activedescendant'); }
function renderQSuggest(){
  var v = qInput.value.trim();
  if(!v){ hideQList(); return; }
  var hits = SPOTS.filter(function(s){ return kwMatch(s, v); }).slice(0,8);
  if(!hits.length){
    qListEl.innerHTML = '<div class="q-empty" role="status">没有匹配「'+esc(v)+'」的景点</div>';
    qListEl.setAttribute('aria-expanded', 'true');
    qListEl.style.display = 'block'; return;
  }
  qListEl.innerHTML = hits.map(function(s, j){
    var i = getSpotIndex(s);
    return '<div class="q-item" id="qOpt-'+j+'" role="option" data-i="'+i+'"><span>'+esc(s.emoji)+'</span><span>'+hl(esc(s.name))+'</span><span class="q-cat">'+esc(s.cat)+'</span></div>';
  }).join('');
  qListEl.setAttribute('aria-expanded', 'true');
  qListEl.style.display = 'block';
  qListEl.querySelectorAll('.q-item').forEach(function(el, ix){
    el.onclick = function(){ var s = SPOTS[+el.dataset.i]; clearTimeout(qDebounce); if(s){ keyword = s.name; qInput.value = s.name; } hideQList(); applyFilters(); select(el.dataset.i, true); qInput.blur(); };
    el.onmousemove = function(){ setQActive(ix); };
  });
}
qInput.addEventListener('input', function(e){ keyword = e.target.value.trim(); renderQSuggest(); clearTimeout(qDebounce); qDebounce = setTimeout(applyFilters, 120); });
qInput.addEventListener('keydown', function(e){
  var items = qListEl.querySelectorAll('.q-item');
  if(e.key === 'ArrowDown'){ e.preventDefault(); setQActive(Math.min(qSelIdx+1, items.length-1)); }
  else if(e.key === 'ArrowUp'){ e.preventDefault(); setQActive(Math.max(qSelIdx-1, 0)); }
  else if(e.key === 'Enter' && qSelIdx >= 0 && items[qSelIdx]){ e.preventDefault(); items[qSelIdx].click(); }
  else if(e.key === 'Escape'){ hideQList(); }
});
document.addEventListener('click', function(e){ if(!(e.target.closest && e.target.closest('.q-wrap'))) hideQList(); });

/* 按钮 */
document.getElementById('reset').onclick = function(){
  window.__tmapMap.setCenter(new TMap.LatLng(30.56, 114.31));
  window.__tmapMap.setZoom(11);
  window.__tmapMap.setRotation(0);              // 复位旋转
  setPitchToggle(false);           // 复位 3D 俯仰并同步「🕋 平面/3D」按钮态
  northBtn.textContent = getNorthText(0);   // 指南针文字刷回「北」
  closePopup();
  // 复位视图同时清空已画出的路线与行程，避免图上仍残留线条
  clearRoute();
  waypoints = []; rpFrom.value = ''; rpTo.value = '';
  renderWaypoints(); syncAddButtons();
  setRoutePanel(false);
  savePrefs();
};
// 缩放指示器按钮
document.getElementById('zoomIn').onclick = function(){
  window.__tmapMap.setZoom((window.__tmapMap.getZoom() || 11) + 1);
};
document.getElementById('zoomOut').onclick = function(){
  window.__tmapMap.setZoom((window.__tmapMap.getZoom() || 11) - 1);
};
document.getElementById('zoomHelp').onclick = function(){ showHelpOverlay(); };
// 初始化缩放级别显示
(function(){
  var zl = document.getElementById('zoomLevel');
  if(zl) zl.textContent = Math.round(window.__tmapMap.getZoom());
})();
document.getElementById('btn-vec').onclick = function(){
  setTrafficOff();
  window.__tmapMap.setBaseMap({type:'vector'});
  document.getElementById('btn-vec').setAttribute('aria-pressed','true');
  document.getElementById('btn-sat').setAttribute('aria-pressed','false');
};
document.getElementById('btn-sat').onclick = function(){
  setTrafficOff();
  window.__tmapMap.setBaseMap({type:'satellite'});
  document.getElementById('btn-sat').setAttribute('aria-pressed','true');
  document.getElementById('btn-vec').setAttribute('aria-pressed','false');
};
/* 窄屏下侧栏是抽屉，盖在地图上。
   顺手把状态同步到 body：CSS 要靠它做两件事 ——
   ① 侧栏开着的时候把浮在左上角的 ☰ 藏掉（不然它压在侧栏标题「武汉景点地图」上）；
   ② 给侧栏一个高于路线面板的层级（窄屏下路线面板是 100vw-24px 的全宽浮层，
      z-index 1300 会把侧栏顶部整个压住，侧栏里的工具菜单根本点不到）。 */
var panelEl = document.getElementById('panel');
document.getElementById('toggle').onclick = function(){
  panelEl.classList.toggle('open');
  syncPanelOpenState();
};

/* 工具菜单：原来是一块常驻的 .ctl 折叠工具条，现在收进 ☰ 菜单里，
   常驻工具条与它的折叠逻辑一并移除。 */
function initMenu(){
  var btn = document.getElementById('menuBtn');
  var menu = document.getElementById('menu');
  if(!btn || !menu) return;
  function close(){ menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  function open(){ menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  btn.addEventListener('click', function(e){
    e.stopPropagation();
    menu.hidden ? open() : close();
  });
  menu.addEventListener('click', function(e){
    if(e.target.closest && e.target.closest('.menu-item')) close();   // 选完自动收起
  });
  document.addEventListener('click', function(e){
    if(menu.hidden) return;
    if(menu.contains(e.target) || (btn.contains && btn.contains(e.target))) return;
    close();
  });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !menu.hidden) close(); });
  window.addEventListener('blur', function(){ if(!menu.hidden) close(); });
  // 精选行程（C1）：渲染进菜单顶部，点选即导入途经点（点 .menu-item 后菜单自动收起）
  var itinList = document.getElementById('itinList');
  if(itinList){
    itinList.innerHTML = ITINERARIES.map(function(it, i){
      return '<button class="menu-item" data-i="' + i + '" title="' + esc(it.desc) + '">' +
        it.emoji + ' ' + esc(it.name) + ' · ' + it.stops.length + ' 站</button>';
    }).join('');
    itinList.addEventListener('click', function(e){
      var b = e.target.closest && e.target.closest('.menu-item');
      if(!b) return;
      importItinerary(ITINERARIES[+b.dataset.i]);
    });
  }
}

/* 筛选折叠：原来 4 组「label + chips」常驻，把列表挤到只剩一小条。
   现在收成 3 个图标，点开对应的面板。 */
function initFilterToggles(){
  var btns = document.querySelectorAll('.f-toggle');
  btns.forEach(function(b){
    var panel = document.getElementById(b.dataset.f);
    if(!panel) return;
    b.addEventListener('click', function(e){
      e.stopPropagation();
      var willOpen = panel.hidden;
      btns.forEach(function(o){
        var p = document.getElementById(o.dataset.f);
        if(p) p.hidden = true;
        o.setAttribute('aria-expanded', 'false');
        o.classList.remove('active');
      });
      if(willOpen){
        panel.hidden = false;
        b.setAttribute('aria-expanded', 'true');
        b.classList.add('active');
      }
    });
  });
  document.addEventListener('click', function(e){
    // 点 .f-toggle（切换）或 .f-panel（选 chip）内部都不算「外部」：
    // 原来只豁免 .f-toggle，导致点一下 chip 面板就收起 —— 单行面板尚可当「下拉」用，
    // 但 cf-zone 有区域+地铁两行，必须保持打开才能组合选择（C2/C3）。
    var inside = e.target.closest && e.target.closest('.f-toggle, .f-panel');
    if(inside) return;
    btns.forEach(function(o){
      var p = document.getElementById(o.dataset.f);
      if(p) p.hidden = true;
      o.setAttribute('aria-expanded', 'false');
      o.classList.remove('active');
    });
  });
}

/* 可伸缩侧栏 */
/* body.panel-open 必须跟着 #panel.open 一起走。
   之前只有 #toggle 那条 onclick 在维护它，折叠侧栏（collapseBtn）和展开侧栏
   （expandBtn）都只动了 #panel.open —— 结果 class 留在 body 上不散：
   窄屏下 ☰ 被 body.panel-open #toggle{display:none} 永久藏掉，
   路线面板也一直按「抽屉开着」让位，收起抽屉也回不到原位。
   统一从 panelEl.classList.contains('open') 派生，两处不会再对不上。 */
function syncPanelOpenState(){
  document.body.classList.toggle('panel-open', panelEl.classList.contains('open'));
}
document.getElementById('collapseBtn').onclick = function(){
  document.getElementById('app').classList.add('panel-collapsed');
  document.getElementById('panel').classList.remove('open');
  syncPanelOpenState();
  // 折叠侧栏时同步关闭路线面板，避免遮挡 expandBtn
  setRoutePanel(false);
  closePopup();
};
document.getElementById('expandBtn').onclick = function(){
  document.getElementById('app').classList.remove('panel-collapsed');
  document.getElementById('panel').classList.add('open');
  syncPanelOpenState();
  // 展开侧栏后，如果用户之前点过路线按钮，自动恢复路线面板
  if(routePanelOpen){ routePanel.classList.remove('hidden'); }
};

/* 主题：日间 → 夜间 → 紫晶，三态循环。
   紫晶不是第四种独立配色，而是「深色表面 + 紫色色相」：body 上同时挂 dark 和 violet
   两个类，CSS 里 body.dark 那套深色玻璃覆盖全部照常生效，body.violet 排在它后面
   （同特异性，靠源码顺序）把色相刷成紫。两边共用一套结构，就不会出现
   「夜间调好的深色表面在紫晶里没被覆盖、露出一块白斑」这种漏改。 */
/* 主题。做成两个**独立**开关，而不是一个三态循环按钮：
   btn-theme 是原来的日↔夜两态开关（d 快捷键的行为也保持原样，少一点意外），
   btn-violet 单独开/关紫晶。之前做成三态循环（点一次夜间、点两次紫晶）看着优雅，
   实际很坑：用户点一下看到「夜间」，以为功能坏了就判定「没显示出颜色」。
   两个开关各自只做一件事，按钮上写什么、点了就去哪，不用数点击次数。 */
var THEME_ORDER = ['light', 'dark', 'violet'];
var curTheme = 'light';
var themeBtn = document.getElementById('btn-theme');
var violetBtn = document.getElementById('btn-violet');
function applyTheme(next){
  curTheme = THEME_ORDER.indexOf(next) >= 0 ? next : 'light';
  // violet 必须同时点亮 dark：深色表面覆盖挂在 body.dark 上
  document.body.classList.toggle('dark', curTheme === 'dark' || curTheme === 'violet');
  document.body.classList.toggle('violet', curTheme === 'violet');
  // 日夜开关：当前是日间就显示「去夜间」，否则显示「去日间」
  var toNight = curTheme === 'light';
  themeBtn.textContent = toNight ? '🌙 夜间' : '☀️ 日间';
  themeBtn.title = toNight ? '切换到夜间模式' : '切换到日间模式';
  themeBtn.setAttribute('aria-label', themeBtn.title);
  themeBtn.setAttribute('aria-pressed', toNight ? 'false' : 'true');
  // 紫晶开关：开着就显示「回夜间」（紫晶是建在夜间之上的），否则显示「进紫晶」
  if(violetBtn){
    var onViolet = curTheme === 'violet';
    violetBtn.textContent = onViolet ? '🌙 夜间' : '💜 紫晶';
    violetBtn.title = onViolet ? '退出紫晶，回到夜间' : '切换到紫晶模式';
    violetBtn.setAttribute('aria-label', violetBtn.title);
    violetBtn.setAttribute('aria-pressed', onViolet ? 'true' : 'false');
    violetBtn.classList.toggle('active', onViolet);
  }
}
/* 两个开关的绑定单独抽成函数（而不是裸写在顶层）：
   测试要从 app.js 抽真实源码执行，裸的 `x.onclick = ...` 不在任何函数体里，
   抓不出来，就只能对着源码字符串断言、点不出真实行为。 */
function bindThemeButtons(){
  themeBtn.onclick = function(){ applyTheme(curTheme === 'light' ? 'dark' : 'light'); savePrefs(); };
  if(violetBtn) violetBtn.onclick = function(){ applyTheme(curTheme === 'violet' ? 'dark' : 'violet'); savePrefs(); };
}
bindThemeButtons();

/* ================== 测距 ==================
   必须传 window.__tmapMap：原来写的是裸 `map`，那个标识符在 TMap 的 with(map){}
   作用域下会被 SDK 污染，拿到的东西不是 TMap.Map 实例 ——
   控制台因此常驻一条「类型错误: map参数类型错误，应为TMap.Map」，📏 测距整个是坏的。 */
var measureTool = new TMap.tools.MeasureTool({ map: window.__tmapMap });
var measureBtn = document.getElementById('btn-measure');
var measurePanel = document.getElementById('measurePanel');
var mpPath = document.getElementById('mpPath');
var mpLine = document.getElementById('mpLine');
var measuring = false;

function fmtDist(m){
  if(m < 1000) return Math.round(m) + ' 米';
  return (m/1000).toFixed(2) + ' 公里';
}
measureBtn.onclick = function(){
  if(measuring) return;
  measuring = true;
  closePopup();
  /* 窄屏下测距面板贴在地图左下角（.measure-panel{left:12px;bottom:28px}），
     而侧栏这时是盖在地图上的抽屉（z-index 1500 > 面板的 1150）—— 面板显示了却整个被盖住，
     看上去就像「点了没反应」。测距本来就是要盯着地图点点量距离，
     顺手把抽屉收掉最自然，宽屏侧栏常驻就不动了。 */
  if(window.innerWidth <= 820 && panelEl.classList.contains('open')){
    panelEl.classList.remove('open');
    syncPanelOpenState();
  }
  measureBtn.style.background = 'rgba(11,122,75,.85)';
  measureBtn.style.color = '#fff';
  measureBtn.setAttribute('aria-pressed','true');
  measurePanel.style.display = 'block';
  mpPath.textContent = '—'; mpLine.textContent = '—';
  measureTool.measureDistance().then(function(info){
    var path = info.path || [];
    var total = info.totalDistance || 0;
    mpPath.textContent = fmtDist(total);
    if(path.length >= 2){
      var line = TMap.geometry.computeDistance([path[0], path[path.length-1]]);
      mpLine.textContent = fmtDist(line);
    } else {
      mpLine.textContent = '—';
    }
    measuring = false;
    measureBtn.style.background = '';
    measureBtn.style.color = '';
    measureBtn.setAttribute('aria-pressed','false');
  }).catch(function(){
    resetMeasureUI();
  });
};
// 右键取消测距
window.__tmapMap.on('rightclick', function(){
  if(measuring){
    resetMeasureUI();
    measureBtn.style.background = '';
    measureBtn.style.color = '';
    measurePanel.style.display = 'none';
    measureTool.stop ? measureTool.stop() : null;
  }
});

/* ================== 指南针 / 旋转 ================== */
var northBtn = document.getElementById('btn-north');
northBtn.onclick = function(){
  window.__tmapMap.setRotation(0);
  window.__tmapMap.setPitch(0);
};
// 显示当前旋转角度（指南针方向）
window.__tmapMap.on('rotate', function(){
  var r = window.__tmapMap.getRotation ? window.__tmapMap.getRotation() : 0;
  var deg = Math.round(((r % 360) + 360) % 360);
  northBtn.textContent = getNorthText(deg);
});
northBtn.textContent = getNorthText(0);

/* ================== 定位（回到我的位置）================== */
var myPos = null;                       // 浏览器定位到的坐标（TMap.LatLng）；未定位为 null
var locateBtn = document.getElementById('locateBtn');
function distTo(s){
  if(!myPos) return Infinity;
  return TMap.geometry.computeDistance([myPos, new TMap.LatLng(s.lat, s.lng)]);
}
function locateMe(){
  if(!(navigator && navigator.geolocation)){
    toast('当前浏览器不支持定位', 'error');
    fallbackToWuhanCenter();
    return;
  }
  locateBtn.title = '正在定位…';
  locateBtn.style.opacity = '.6';
  // 先用 cache 快速定位（毫秒级响应）
  navigator.geolocation.getCurrentPosition(function(pos){
    onLocateSuccess(pos);
  }, function(err){
    // 快速 cache 失败 → 用高精度 watchPosition 重试
    if(err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE){
      var watchId = navigator.geolocation.watchPosition(function(pos){
        navigator.geolocation.clearWatch(watchId);
        onLocateSuccess(pos);
      }, function(){
        // 真的拿不到，给个武汉中心点并提示
        locateBtn.title = '回到我的位置';
        locateBtn.style.opacity = '';
        toast('定位失败，已定位武汉城区中心', 'error');
        fallbackToWuhanCenter();
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
      setTimeout(function(){
        if(locateBtn.style.opacity === '.6'){
          // watchPosition 15s 还没成功，主动 fallback
          navigator.geolocation.clearWatch(watchId);
          if(!myPos) fallbackToWuhanCenter();
        }
      }, 16000);
    } else {
      locateBtn.title = '回到我的位置';
      locateBtn.style.opacity = '';
      toast('定位失败：' + (err.message || '权限被拒绝'), 'error');
      fallbackToWuhanCenter();
    }
  }, { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });
}
function onLocateSuccess(pos){
  // WGS-84 → GCJ-02 偏移补偿（≈ 中国大陆境内 ~50-500m）
  var wgsLat = pos.coords.latitude, wgsLng = pos.coords.longitude;
  var gcj = wgsToGcj(wgsLat, wgsLng);
  myPos = new TMap.LatLng(gcj.lat, gcj.lng);
  myPosAccuracy = pos.coords.accuracy || 0;
  window.__tmapMap.setCenter(myPos);
  window.__tmapMap.setZoom(16);  // 提高缩放让定位更"精准"
  locateBtn.title = '回到我的位置（精度 ±' + Math.round(myPosAccuracy) + 'm）';
  locateBtn.style.opacity = '';
  toast('已定位到你的位置（精度 ±' + Math.round(myPosAccuracy) + 'm）', 'ok');
  applyFilters();
  drawMyPosMarker();
}
function fallbackToWuhanCenter(){
  // 给武汉市中心（黄鹤楼附近）作为兜底
  myPos = new TMap.LatLng(30.56, 114.31);
  myPosAccuracy = 5000;
  window.__tmapMap.setCenter(myPos);
  window.__tmapMap.setZoom(12);
  locateBtn.title = '回到我的位置';
  locateBtn.style.opacity = '';
  applyFilters();
}
/* 在地图上绘制我的位置标记 */
var myPosMarker = null;
var myPosAccuracyCircle = null;
function drawMyPosMarker(){
  if(!myPos || !window.__tmapMap) return;
  // 清除旧标记
  if(myPosMarker){ myPosMarker.setMap(null); myPosMarker = null; }
  if(myPosAccuracyCircle){ myPosAccuracyCircle.setMap(null); myPosAccuracyCircle = null; }
  // 精度圈
  if(myPosAccuracy > 0){
    myPosAccuracyCircle = new TMap.MultiPolygon({
      map: window.__tmapMap,
      styles: { polygon: new TMap.PolygonStyle({
        color: 'rgba(11,122,75,.18)', borderColor: 'rgba(11,122,75,.55)', borderWidth: 1.5, lineCap: 'round'
      })},
      geometries: [circlePolygon(myPos.lat, myPos.lng, myPosAccuracy)]
    });
  }
  // 中心点 marker
  myPosMarker = new TMap.MultiMarker({
    map: window.__tmapMap,
    styles: { marker: new TMap.MarkerStyle({
      width: 22, height: 22, src: locationDotSvg(), anchor: { x: 11, y: 11 }
    })},
    geometries: [{ id: 'me', position: myPos }]
  });
}
function circlePolygon(lat, lng, radiusMeters){
  // 简单圆形近似：经纬度偏移
  var d2r = Math.PI / 180;
  var r = radiusMeters / 6371000; // 弧度
  var latR = lat * d2r;
  var ring = [];
  for(var i=0;i<24;i++){
    var a = (i/24) * 2 * Math.PI;
    var dLat = r * Math.cos(a) / d2r;
    var dLng = r * Math.sin(a) / (Math.cos(latR) * d2r);
    ring.push([lng + dLng, lat + dLat]);
  }
  ring.push(ring[0]);
  return { id: 'acc', paths: [ring] };
}
function locationDotSvg(){
  // 内联 base64 SVG（蓝点带白色外圈 + 中心白点）
  return 'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22">' +
      '<circle cx="11" cy="11" r="9" fill="#1d6ffb" stroke="#fff" stroke-width="2.5"/>' +
      '<circle cx="11" cy="11" r="3" fill="#fff"/>' +
    '</svg>'
  );
}
/* WGS-84 → GCJ-02 火星坐标转换（中国大陆境内）
   来源：开源算法（gcoord 思路），偏差 < 1m；境外不偏移 */
var PI = 3.14159265358979323846, A = 6378245.0, EE = 0.00669342162296594323;
function outOfChina(lng, lat){ return (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271); }
function transformLat(x, y){
  var ret = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  ret += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))/4;
  ret += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI))/4;
  ret += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30.0))/4;
  return ret;
}
function transformLng(x, y){
  var ret = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  ret += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))/4;
  ret += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI))/4;
  ret += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI))/4;
  return ret;
}
function wgsToGcj(lat, lng){
  if(outOfChina(lng, lat)) return {lat: lat, lng: lng};
  var dLat = transformLat(lng-105, lat-35);
  var dLng = transformLng(lng-105, lat-35);
  var radLat = lat / 180 * PI;
  var magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  var sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
var myPosAccuracy = 0;  // 定位精度（米），0 = 未定位

locateBtn.onclick = locateMe;

/* ================== 比例尺 ==================
   自研的那套（#scaleBar + updateScale）已删除：TMap 默认就带 .tmap-scale-control，
   实测两者都锚在左下角同一处（(320,661) 与 (332,685)），
   再叠上腾讯地图的版权块，「5 公里 / 5 英里 / 5 km」三行糊成一团。
   缩放变化交给 SDK 自己那套即可，这里只留 pin 重排。 */
window.__tmapMap.on('zoom_changed', scheduleRenderPins);
window.__tmapMap.on('resize', function(){
  scheduleRenderPins();       // 视口尺寸变了，屏外剔除和去重叠都要按新尺寸重算
});

/* ================== 3D 俯仰视角切换 ================== */
var pitchBtn = document.getElementById('btn-pitch');
var pitchOn = false;
function setPitchToggle(on){
  pitchOn = on;
  window.__tmapMap.setPitch(on ? 55 : 0);
  pitchBtn.classList.toggle('active', on);
  pitchBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  pitchBtn.textContent = on ? '🕋 平面' : '🕋 3D';
}
pitchBtn.onclick = function(){ setPitchToggle(!pitchOn); };

/* ================== 弹窗「到这去」：一键把景点设为路线终点 ================== */
function navTo(s){
  if(!s) return;
  hideQList();
  // 「到这去」以该景点为唯一终点：清空已存途经点，避免 doQuery 用 waypoints[0]/[last] 覆盖点击的景点
  if(waypoints.length){ waypoints = []; renderWaypoints(); syncAddButtons(); }
  rpTo.value = s.name;
  if(!rpFrom.value.trim()){ rpFrom.value = myPos ? '我的位置' : ''; }
  setRoutePanel(true);
  routePanel.classList.remove('collapsed');
  doQuery();
}
function bindPopupActions(s){
  var goBtn = popupContent.querySelector('[data-act="go"]');
  if(goBtn) goBtn.onclick = function(){ navTo(s); };
  // 周边胶囊（F3）：点击切到那个景点 —— 高亮列表行 + 平移聚焦 + 打开它的弹窗。
  // dataset.i 保持字符串传入（select 内部用 el.dataset.id === id 严格比较，传数字会失配）
  popupContent.querySelectorAll('.pp-near').forEach(function(nb){
    nb.onclick = function(){
      if(SPOTS[+nb.dataset.i]) select(nb.dataset.i, true);
    };
  });
}


/* ================== 路线查询（出发地 → 到达地）================== */
var geocoder = new TMap.service.Geocoder();
var driving = new TMap.service.Driving({ policy: 'LEAST_TIME', mp: true });
var walking = new TMap.service.Walking();
var bicycling = new TMap.service.Bicycling();
var transit = new TMap.service.Transit({ policy: 'RECOMMEND' });
var rpFrom = document.getElementById('rpFrom');
var rpTo = document.getElementById('rpTo');
var rpGo = document.getElementById('rpGo');
var rpClear = document.getElementById('rpClear');
var rpSummary = document.getElementById('rpSummary');
var rpCards = document.getElementById('rpCards');
var rpLineSummary = document.getElementById('rpLineSummary');
var routeMarkers = null;       // 起终点标记图层
var routeLineLayers = [];      // 各方案路线图层数组
var routeStraightLayer = null; // 红色直线图层
var routeBounds = null;
var curMode = 'driving';       // 当前出行方式
var routeModeName = { driving:'驾车', walking:'步行', bicycling:'骑行', transit:'公交' };
var ROUTE_COLORS = ['#e5484d', '#2f6fed', '#f5a524'];  // 多方案颜色（不跨色渐变）

function fmtKm(m){
  if(m == null || isNaN(m)) return '—';
  if(m < 1000) return Math.round(m) + ' 米';
  return (m/1000).toFixed(2) + ' 公里';
}
function clearRoute(){
  hideRPTip();
  if(routeMarkers){ routeMarkers.setMap(null); routeMarkers = null; }
  routeLineLayers.forEach(function(l){ if(l) l.setMap(null); });
  routeLineLayers = [];
  if(routeStraightLayer){ routeStraightLayer.setMap(null); routeStraightLayer = null; }
  routeBounds = null;
  rpSummary.style.display = 'none';
  rpCards.innerHTML = '';
}
rpClear.onclick = function(){
  rpFrom.value = ''; rpTo.value = '';
  waypoints = [];
  renderWaypoints();
  syncAddButtons();
  clearRoute();
  savePrefs();
};

/* 历史记录（localStorage） */
var RP_HISTORY_KEY = 'wuhan_rp_history';
function loadHistory(){ try { return JSON.parse(localStorage.getItem(RP_HISTORY_KEY) || '[]'); } catch(e){ return []; } }
function saveHistory(f, t){
  var h = loadHistory();
  h = h.filter(function(x){ return !(x.from === f && x.to === t); });
  h.unshift({ from: f, to: t });
  if(h.length > 8) h = h.slice(0, 8);
  lsSet(RP_HISTORY_KEY, JSON.stringify(h));
  fillHistoryLists();
}
function fillHistoryLists(){
  var h = loadHistory();
  var froms = [], tos = [];
  h.forEach(function(x){ froms.push(x.from); tos.push(x.to); });
  document.getElementById('rpFromList').innerHTML = froms.map(function(v){ return '<option value="'+v+'">'; }).join('');
  document.getElementById('rpToList').innerHTML = tos.map(function(v){ return '<option value="'+v+'">'; }).join('');
}

/* 出行方式切换 */
var rpModes = document.getElementById('rpModes');
rpModes.querySelectorAll('.rp-mode').forEach(function(btn){
  btn.onclick = function(){
    if(curMode === btn.dataset.mode) return;
    curMode = btn.dataset.mode;
    rpModes.querySelectorAll('.rp-mode').forEach(function(b){
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
    });
    savePrefs();
    if(rpFrom.value.trim() && rpTo.value.trim()){ doQuery(); }
  };
});

/* 折叠
   原来直接让 CSS 把 .rp-body 的 max-height 从 min(540px, 100dvh-80px) 收到 0。
   但面板内容实际只有 ~260px，元素高度受内容约束，于是前 48% 的行程（≈120ms）
   画面完全不动，点下去表现为「先卡一下、再突然收起」。展开时同理是「先窜高、再卡住」。
   改成先量出真实内容高度再收/放，两段动画全程可见，结束后撤掉内联样式交回 CSS。
   另外收放期间给面板挂 .folding：面板里有 8 处 backdrop-filter，max-height 每动一帧
   就要按新尺寸重算一次背景模糊（详见 style.min.css 对应注释），不掉帧才谈得上顺。 */
var rpFoldBtn = document.getElementById('rpFold');
var rpPanelEl = document.getElementById('routePanel');
var rpBodyEl = rpPanelEl ? rpPanelEl.querySelector('.rp-body') : null;
var rpFoldTimer = null;
if(rpFoldBtn){
  rpFoldBtn.onclick = function(){
    hideRPTip();
    var collapsed = rpPanelEl.classList.toggle('collapsed');
    this.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if(!rpBodyEl) return;                 // 结构异常时退回纯 CSS 折叠，不让整个 startApp 抛错
    clearTimeout(rpFoldTimer);
    // scrollHeight 不受 max-height 裁剪影响，这里量到的就是内容真实高度
    var h = rpBodyEl.scrollHeight;
    rpPanelEl.classList.add('folding');
    rpBodyEl.style.maxHeight = collapsed ? h + 'px' : '0px';
    requestAnimationFrame(function(){
      rpBodyEl.style.maxHeight = collapsed ? '0px' : h + 'px';
    });
    rpFoldTimer = setTimeout(function(){
      rpBodyEl.style.maxHeight = '';
      rpPanelEl.classList.remove('folding');
    }, 280);
  };
}

/* 侧栏「路线」按钮：开关寻路面板 */
var routePanel = document.getElementById('routePanel');
var btnRoute = document.getElementById('btnRoute');
var routePanelOpen = false;   // 初始隐藏，由侧栏按钮唤起
function setRoutePanel(open){
  routePanelOpen = open;
  routePanel.classList.toggle('hidden', !routePanelOpen);
  btnRoute.classList.toggle('active', routePanelOpen);
  if(routePanelOpen) routePanel.classList.remove('collapsed');
  if(!open) hideRPTip();
}
btnRoute.onclick = function(){
  console.log('[btnRoute] click');
  setRoutePanel(!routePanelOpen);
};

/* ================== 精选行程预设（C1） ==================
   stops 必须与 spots.src.json 的景点名逐字一致 ——
   test/frontend/itineraries.test.js 会校验；那边改名、这边会红。
   mode 是导入时预选的出行方式；路线查询仍由用户点「查询路线」触发。 */
var ITINERARIES = [
  {emoji:'🏯',name:'经典一日游',desc:'登楼 → 过早 → 2元轮渡过江 → 步行街 → 江滩看灯光秀',mode:'transit',stops:['黄鹤楼','户部巷','长江轮渡（中华路码头）','江汉路步行街','汉口江滩']},
  {emoji:'🏛',name:'博物馆之旅',desc:'省博看越王勾践剑 → 红楼 → 江汉关 → 美术馆，全线免费需预约',mode:'transit',stops:['湖北省博物馆','辛亥革命博物院（武昌红楼）','江汉关博物馆','武汉美术馆（汉口馆）']},
  {emoji:'🌸',name:'东湖环线',desc:'听涛 → 绿道骑行 → 磨山樱花园（花期）→ 植物园',mode:'bicycling',stops:['东湖·听涛景区','东湖绿道','东湖·磨山樱花园','武汉植物园']},
  {emoji:'🧒',name:'亲子半日',desc:'科技馆互动展 → 江滩放风 → 江汉路晚餐',mode:'walking',stops:['武汉科技馆','汉口江滩','江汉路步行街']},
  {emoji:'🏘',name:'汉口老城漫步',desc:'黎黄陂路老租界 → 江汉关钟楼 → 江汉路 → 吉庆街夜宵',mode:'walking',stops:['黎黄陂路','江汉关博物馆','江汉路步行街','吉庆街']},
  {emoji:'⛰',name:'木兰远郊线',desc:'木兰山登顶 → 草原骑马 → 大余湾古村，全程自驾约 150 公里',mode:'driving',stops:['木兰山','木兰草原','大余湾']}
];

/* 切出行方式：rpModes 点击处理器 / restorePrefs / 行程导入三处共用的按钮同步 */
function setRouteMode(m){
  if(!routeModeName[m]) return false;
  curMode = m;
  rpModes.querySelectorAll('.rp-mode').forEach(function(b){
    var isActive = (b.dataset.mode === curMode);
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });
  return true;
}

/* 地图视野框住整条行程（视野调整失败不影响导入本身） */
function fitItineraryView(names){
  try{
    var byName = {};
    SPOTS.forEach(function(s){ byName[s.name] = s; });
    var b = new TMap.LatLngBounds();
    var n = 0;
    names.forEach(function(nm){ var s = byName[nm]; if(!s) return; b.extend(new TMap.LatLng(s.lat, s.lng)); n++; });
    if(n > 1) window.__tmapMap.fitBounds(b, { padding: 80 });
  }catch(e){ /* TMap 未就绪/坐标异常时静默跳过 */ }
}

/* 一键导入：替换 waypoints + 预选出行方式 + 展开路线面板 + 框住全程 */
function importItinerary(it){
  if(!it || !Array.isArray(it.stops) || !it.stops.length) return;
  // 先过滤再确认：全部站名失效时直接报错，不为一个空行程去弹确认框
  var byName = {};
  SPOTS.forEach(function(s){ byName[s.name] = s; });
  var stops = it.stops.filter(function(n){ return !!byName[n]; });
  if(!stops.length){ toast('该行程的景点都不在当前数据里', 'err'); return; }
  if(waypoints.length && !window.confirm('当前已有 ' + waypoints.length + ' 个途经景点，导入「' + it.name + '」将替换它们，继续吗？')) return;
  if(stops.length < it.stops.length) toast((it.stops.length - stops.length) + ' 个景点未找到，已跳过', 'info');
  waypoints = stops;
  setRouteMode(it.mode);
  renderWaypoints();          // 内部会同步起终点输入框
  syncAddButtons();
  setRoutePanel(true);
  savePrefs();
  fitItineraryView(stops);
  toast('已导入「' + it.name + '」' + stops.length + ' 站，点「查询路线」出全程方案', 'ok');
}

/* ================== 行程：左侧「+」添加途经景点 ================== */
var waypoints = [];   // 按添加顺序存储景点名称
var rpWaypoints = document.getElementById('rpWaypoints');
function syncAddButtons(){
  // 性能优化：走 listNodes 缓存的行节点 + 节点上缓存的按钮引用，
  // 不再对整个列表做 querySelectorAll；状态没变的按钮一个属性都不写。
  // title/aria-label 由 rowInnerHTML 生成一次，事件走 list 上的委托。
  listNodes.forEach(function(el){
    var btn = el._addBtn;
    if(!btn) return;
    var on = waypoints.indexOf(btn.dataset.name) >= 0;
    if(btn._on === on) return;
    btn._on = on;
    btn.classList.toggle('added', on);
    btn.textContent = on ? '✓' : '+';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');   // 此前只在创建时写死 false，加入路线后读屏仍报「未按下」
  });
}

// localStorage 异步写入：用 requestIdleCallback 包装，避免主线程同步阻塞
// 在空闲时间批量写入，不影响交互响应。回退到 setTimeout(fn, 50)。
function lsSet(key, value){
  var run = function(){
    try{ localStorage.setItem(key, value); }catch(e){ console.warn('[lsSet]', key, e); }
  };
  if(window.requestIdleCallback){ window.requestIdleCallback(run, {timeout: 1000}); }
  else { setTimeout(run, 50); }
}
/* 起终点输入框 ←→ 途经点列表的唯一同步点。
   早先这段逻辑散在 3 处（renderWaypoints 尾部、✗ 处理器、toggleWaypoint），
   而且都只在「≥2 个途经点」时才写 rpTo、「0 个」时一处都不清，于是有两个真 bug：
     · 行程 A→B，点 ✗ 删掉 B → waypoints=[A]，rpTo 仍残留 B，
       doQuery 里 waypoints.length===1 会拿 rpTo 当终点 → 查询仍走 A→刚删掉的 B；
     · 添加某景点为途经点、再点「+」取消 → waypoints=[]，rpFrom 仍残留该景点。
   收敛成单一真相源后只有一个地方决定「输入框该显示什么」。

   wpEcho 记的是**我们自己写进去的那个值**，只用于一个场景：行程被清空时回收。
   「途经点非空 → 接管输入框」是既有设计，不能改 —— doQuery 确实按 waypoints[0]/[last]
   取起终点，输入框显示别的名字就成了假信息。
   所以这里只在**列表变空**时才动回收，且只回收我们自己写的那份：
   用户从头到尾手敲的起点，不该因为「取消了最后一个途经点」而被抹掉。 */
var wpEcho = { from: null, to: null };
function syncRouteInputs(){
  var f = waypoints.length ? waypoints[0] : '';
  var t = waypoints.length >= 2 ? waypoints[waypoints.length - 1] : '';
  if(f) rpFrom.value = f;
  else if(wpEcho.from !== null && rpFrom.value === wpEcho.from) rpFrom.value = '';
  if(t) rpTo.value = t;
  else if(wpEcho.to !== null && rpTo.value === wpEcho.to) rpTo.value = '';
  wpEcho.from = f || null;
  wpEcho.to = t || null;
}
function renderWaypoints(){
  // 空列表也要同步：否则「取消最后一个途经点」时起点框会残留那个景点。
  syncRouteInputs();
  if(!waypoints.length){
    rpWaypoints.innerHTML = '<span class="rp-wp-empty">尚未添加途经景点</span>';
    return;
  }
  rpWaypoints.innerHTML = waypoints.map(function(n,i){
    return '<span class="rp-wp-chip"><span class="idx">'+(i+1)+'</span><span class="nm">'+n+'</span><span class="x" data-name="'+n+'" title="取消地点">✗</span></span>';
  }).join('');
  rpWaypoints.querySelectorAll('.x').forEach(function(x){
    x.onclick = function(e){
      e.stopPropagation();
      var n = x.dataset.name;
      waypoints = waypoints.filter(function(w){ return w !== n; });
      renderWaypoints();          // 内部已调 syncRouteInputs，这里不再重复同步
      syncAddButtons();
      savePrefs();
    };
  });
}
function toggleWaypoint(name){
  var i = waypoints.indexOf(name);
  if(i >= 0){ waypoints.splice(i, 1); }       // 再点一次 → 取消添加
  else { waypoints.push(name); }
  renderWaypoints();
  syncAddButtons();
  savePrefs();
  if(waypoints.length){                       // 有途经点才唤起寻路面版
    setRoutePanel(true);
    routePanel.classList.remove('collapsed');
  }
}
/* 互换起点与目的地 */
document.getElementById('rpSwap').onclick = function(){
  if(waypoints.length >= 2){
    waypoints.reverse();                      // 反转整个行程
    renderWaypoints();
    syncAddButtons();
  } else {
    var f = rpFrom.value;
    rpFrom.value = rpTo.value;
    rpTo.value = f;
  }
  savePrefs();
  if(rpFrom.value.trim() && rpTo.value.trim()){ doQuery(); }
};
/* 初始化（此刻列表尚未渲染，空操作即可） */
renderWaypoints();
syncAddButtons();

/* 路线方案滚动条：使用中自动加粗，闲置自动缩回 */
var rpScrollTimer = null;
function rpThicken(){ rpCards.classList.add('scrolling'); clearTimeout(rpScrollTimer); }
function rpShrinkSoon(){ clearTimeout(rpScrollTimer); rpScrollTimer = setTimeout(function(){ rpCards.classList.remove('scrolling'); }, 600); }
rpCards.addEventListener('mouseenter', rpThicken);
rpCards.addEventListener('mouseleave', rpShrinkSoon);
rpCards.addEventListener('scroll', function(){ rpThicken(); rpShrinkSoon(); });
rpCards.addEventListener('mousedown', rpThicken);
window.addEventListener('mouseup', rpShrinkSoon);
rpCards.addEventListener('touchstart', rpThicken);
rpCards.addEventListener('touchend', rpShrinkSoon);
// 重要：在路线面板/卡片滚动条上用滚轮时，拦截事件禁止其穿透到下方地图。
// 否则滚轮会缩放地图、把视野滚走（用户反馈「显示路况时不能滚动，滚动则窗口消失」的诱因）。
['wheel','DOMMouseScroll'].forEach(function(ev){
  routePanel.addEventListener(ev, function(e){ e.stopPropagation(); }, { passive:false });
  rpCards.addEventListener(ev, function(e){ e.stopPropagation(); }, { passive:false });
});

/* 地名→坐标 缓存（localStorage），避免重复查询触发接口配额上限 */
var gCache = (function(){ try{ return JSON.parse(localStorage.getItem('wuhan_geo_cache')||'{}'); }catch(e){ return {}; } })();
function saveGCache(){ lsSet('wuhan_geo_cache', JSON.stringify(gCache)); }
function geo(addr){
  var address = addr;
  if(address.indexOf('武汉') < 0){ address = '武汉' + address; }
  var hit = gCache[address];
  if(hit){ return Promise.resolve({ status: 0, result: { location: new TMap.LatLng(hit.lat, hit.lng) } }); }
  return withTimeout(geocoder.getLocation({ address: address }), 9000, '地址解析超时').then(function(r){
    if(r.status === 0 && r.result && r.result.location){
      gCache[address] = { lat: r.result.location.lat, lng: r.result.location.lng };
      saveGCache();
    }
    return r;
  });
}
/* 路线方案 缓存（localStorage）：命中则直接绘制，避免重复查询触发配额上限 */
var dCache = (function(){ try{ return JSON.parse(localStorage.getItem('wuhan_dir_cache')||'{}'); }catch(e){ return {}; } })();
function saveDCache(){ lsSet('wuhan_dir_cache', JSON.stringify(dCache)); }
function trimDCache(){ var ks = Object.keys(dCache); if(ks.length > 12){ ks.slice(0, ks.length - 12).forEach(function(k){ delete dCache[k]; }); } }
function latlngKey(L){
  if(!L) return '';
  if(L.getLat) return L.getLat().toFixed(5) + ',' + L.getLng().toFixed(5);
  return (L.lat||0).toFixed(5) + ',' + (L.lng||0).toFixed(5);
}
function dirKey(mode, from, to, mids){
  var k = mode + '|' + latlngKey(from) + '>' + latlngKey(to);
  if(mids.length) k += '|' + mids.map(latlngKey).join(';');
  return k;
}
var queryInFlight = false;
/* 若出发地未填写，引导用户定位或填写起点 */
function ensureOrigin(cb){
  var f = rpFrom.value.trim();
  if(!f){
    if(myPos){ rpFrom.value = "我的位置"; cb(); return; }
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(function(pos){
        myPos = new TMap.LatLng(pos.coords.latitude, pos.coords.longitude);
        rpFrom.value = "我的位置"; toast("已定位到你的位置", "ok"); cb();
      }, function(){ toast("无法获取你的位置，请在路线面板填写起点", "info"); }, {timeout:8000});
    } else {
      toast("请在路线面板「出发点」填写起点位置", "info");
      var panel = document.getElementById('panel');
      if(panel && panel.style.display === 'none') panel.style.display = '';
    }
    return;
  }
  cb();
}
function doQuery(){
  if(queryInFlight) return;
  ensureOrigin(function(){
  // 行程优先：第一个为起点、最后一个为终点，中间的作为途经点
  var f = rpFrom.value.trim(), t = rpTo.value.trim();
  var wps = [];
  if(waypoints.length){
    f = waypoints[0];
    t = waypoints.length > 1 ? waypoints[waypoints.length - 1] : t;
    wps = waypoints.slice(1, waypoints.length - 1);
  }
  if(!f || !t){ toast('请选择/输入出发点和到达点'); return; }
  queryInFlight = true; rpGo.disabled = true; rpGo.textContent = '查询中…';
  // 途经点的地址解析（先并行执行，不阻塞主起终点）
  var wpTasks = wps.map(function(w){
    return geo(w).then(function(r){ return (r.status === 0 && r.result && r.result.location) ? r.result.location : null; });
  });
  // 「到这去」用到的：出发地填了「我的位置」且有定位 → 直接用坐标，不再走地址解析
  function resolveLoc(addr){
    if(myPos && addr === '我的位置'){ return Promise.resolve({ status: 0, result: { location: myPos } }); }
    return geo(addr);
  }
  Promise.all([resolveLoc(f), resolveLoc(t)]).then(function(res){
    var fr = res[0], tr = res[1];
    if(fr.status !== 0 || !fr.result || !fr.result.location){ throw new Error('未找到出发点：'+f); }
    if(tr.status !== 0 || !tr.result || !tr.result.location){ throw new Error('未找到到达点：'+t); }
    var from = fr.result.location, to = tr.result.location;
    var lineDist = TMap.geometry.computeDistance([from, to]);
    // 按当前方式调对应服务
    var svc;
    if(curMode === 'walking') svc = walking;
    else if(curMode === 'bicycling') svc = bicycling;
    else if(curMode === 'transit') svc = transit;
    else svc = driving;
    return Promise.all(wpTasks).then(function(wpLocs){
      var opt = { from: from, to: to };
      var mids = wpLocs.filter(function(x){ return x; });
      if(mids.length) opt.waypoints = mids;   // 途经点（各方式均支持）
      var key = dirKey(curMode, from, to, mids);
      var cached = dCache[key];
      if(cached && cached.plan){                  // 命中缓存：免去方向接口请求（含 TTL，30 分钟内有效）
        if(Date.now() - (cached._t || 0) > 30 * 60 * 1000){ delete dCache[key]; saveDCache(); }
        else { return { from: from, to: to, lineDist: lineDist, plan: cached.plan }; }
      }
      return withTimeout(svc.search(opt), 15000, '路线查询超时').then(function(plan){
        dCache[key] = { plan: plan, _t: Date.now() }; trimDCache(); saveDCache();
        return { from: from, to: to, lineDist: lineDist, plan: plan };
      });
    });
  }).then(function(r){
    var routes = (r.plan.result && r.plan.result.routes) || [];
    renderRoutes(r.from, r.to, routes, curMode, r.lineDist);
    saveHistory(f, t);
  }).catch(function(e){
    toast(e && e.message ? e.message : '查询失败，请检查地点名称', 'error');
  }).finally(function(){
    queryInFlight = false; rpGo.disabled = false; rpGo.textContent = '查询路线';
  });
  }); // end ensureOrigin
}
rpGo.onclick = doQuery;

/* 路线卡片悬停：显示完整逐步指引（fixed 定位，不被父容器 overflow 裁剪）
   pointer-events:auto + 该元素上拦截 wheel/touch，使「在提示上滚轮」只会滚动提示自身，
   而不会穿透到地图把视野滚没了（即用户反馈的「滚动则窗口消失」）。 */
var rpTipEl = null;
var rpTipHover = false;   // 指针是否停留在提示上（用于卡片离开时不立即隐藏，避免闪烁）
var rpTipHideTimer = null;
function ensureRPTip(){
  if(!rpTipEl){
    rpTipEl = document.createElement('div'); rpTipEl.className = 'rp-tip'; document.body.appendChild(rpTipEl);
    rpTipEl.addEventListener('mouseenter', function(){ rpTipHover = true; clearTimeout(rpTipHideTimer); });
    rpTipEl.addEventListener('mouseleave', function(){ rpTipHover = false; hideRPTip(); });
    // 阻止滚轮/触摸穿透到地图（地图在提示下方），避免地图被滚轮缩放导致窗口消失
    rpTipEl.addEventListener('wheel', function(e){ e.stopPropagation(); }, { passive:false });
    rpTipEl.addEventListener('DOMMouseScroll', function(e){ e.stopPropagation(); }, { passive:false });
    rpTipEl.addEventListener('touchmove', function(e){ e.stopPropagation(); }, { passive:false });
  }
  return rpTipEl;
}
function buildStepsHtml(route, mode){
  var title = '详细路线 · ' + esc(fmtKm(route.distance)) + ' · ' + esc(route.duration) + ' 分钟';
  var steps = (route.steps || []).filter(function(s){ return (s.instruction || s.road_name); });
  if(!steps.length) return '<div class="rt-title">'+title+'</div><div class="fs-row"><span>无逐步指引</span></div>';
  var rows = steps.map(function(st, k){
    var txt = st.instruction || st.road_name || '';
    return '<div class="fs-row"><b>'+(k+1)+'</b><span>'+esc(txt)+'</span></div>';
  }).join('');
  return '<div class="rt-title">'+title+'</div>' + rows;
}
function showRPTip(card, stepHtml){
  var t = ensureRPTip();
  t.innerHTML = stepHtml;
  t.style.display = 'block';
  var r = card.getBoundingClientRect();
  var tw = t.offsetWidth, th = t.offsetHeight;
  var x = r.right + 8;
  if(x + tw > window.innerWidth - 8){ x = r.left - tw - 8; }   // 右侧放不下则翻到左侧
  if(x < 8){ x = 8; }
  var y = r.top + r.height/2 - th/2;
  y = Math.max(8, Math.min(y, window.innerHeight - th - 8));
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
function hideRPTip(){ clearTimeout(rpTipHideTimer); if(rpTipEl){ rpTipEl.style.display = 'none'; } }

function renderRoutes(from, to, routes, mode, lineDist){
  clearRoute();
  // 起终点标记
  routeMarkers = new TMap.MultiMarker({
    map: window.__tmapMap,
    styles: {
      from: new TMap.MarkerStyle({ width: 22, height: 22, anchor: { x: 11, y: 11 }, backgroundColor: '#30a46c', backgroundWidth: 22, backgroundHeight: 22, backgroundBorderRadius: 11, backgroundBorderWidth: 2, backgroundBorderColor: '#fff' }),
      to: new TMap.MarkerStyle({ width: 22, height: 22, anchor: { x: 11, y: 11 }, backgroundColor: '#e5484d', backgroundWidth: 22, backgroundHeight: 22, backgroundBorderRadius: 11, backgroundBorderWidth: 2, backgroundBorderColor: '#fff' })
    },
    geometries: [
      { id: 'from', styleId: 'from', position: from },
      { id: 'to', styleId: 'to', position: to }
    ]
  });
  // 红色虚线直线
  routeStraightLayer = new TMap.MultiPolyline({
    map: window.__tmapMap,
    styles: { line: new TMap.PolylineStyle({ color: 'rgba(229,72,77,.7)', width: 2, lineCap: 'round', dashArray: [8, 6], showArrow: false }) },
    geometries: [{ id: 'straight', styleId: 'line', paths: [from, to] }]
  });
  // 各方案路线（多方案不同色，单方案默认红）
  routeBounds = new TMap.LatLngBounds();
  routeBounds.extend(from); routeBounds.extend(to);
  routes.forEach(function(route, i){
    if(!route.polyline || route.polyline.length < 2) return;
    var color = routes.length > 1 ? ROUTE_COLORS[i % ROUTE_COLORS.length] : '#e5484d';
    var layer = new TMap.MultiPolyline({
      map: window.__tmapMap,
      styles: { line: new TMap.PolylineStyle({ color: color, width: 5, lineCap: 'round', borderColor: '#fff', borderWidth: 1, showArrow: false }) },
      geometries: [{ id: 'route'+i, styleId: 'line', paths: route.polyline }]
    });
    routeLineLayers.push(layer);
    route.polyline.forEach(function(p){ routeBounds.extend(p); });
  });
  window.__tmapMap.fitBounds(routeBounds, { padding: 80 });
  // 汇总
  rpSummary.style.display = 'block';
  rpLineSummary.textContent = fmtKm(lineDist);
  // 方案卡片
  rpCards.innerHTML = '';
  if(!routes.length){
    rpCards.innerHTML = '<div class="rp-card" style="cursor:default">未获取到' + routeModeName[mode] + '路线</div>';
    return;
  }
  routes.forEach(function(route, i){
    var card = document.createElement('div');
    card.className = 'rp-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', '路线' + (i + 1) + '：' + fmtKm(route.distance) + '，约' + route.duration + '分钟');
    card.addEventListener('keydown', function(e){
      if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); card.click(); }
    });
    var color = routes.length > 1 ? ROUTE_COLORS[i % ROUTE_COLORS.length] : ROUTE_COLORS[0];  // 单路线统一用首色
    card.style.borderLeft = '3px solid ' + color;
    // 标签
    var tags = '';
    if(mode === 'driving'){
      if(route.traffic_light_count != null) tags += '<span class="rp-tag">🚦 红绿灯 '+esc(route.traffic_light_count)+'</span>';
      if(route.toll != null && route.toll > 0) tags += '<span class="rp-tag t-orange">¥ 过路费 '+esc(route.toll)+'</span>';
      if(route.restriction && route.restriction.status === 1) tags += '<span class="rp-tag t-orange">⚠ 途经限行城市</span>';
      if(route.taxi_fare && route.taxi_fare.fare) tags += '<span class="rp-tag t-red">🚕 打车约¥'+esc(route.taxi_fare.fare)+'</span>';
      (route.tags || []).forEach(function(tg){ if(/红绿灯|时间|拥堵|收费|距离/.test(tg)) tags += '<span class="rp-tag t-green">'+esc(tg)+'</span>'; });
    }
    var roads = (route.steps || []).map(function(s){ return s.road_name || s.instruction || ''; }).filter(Boolean).slice(0,3).join(' → ');
    card.innerHTML =
      '<div class="rp-card-head"><span class="rp-card-dist">'+esc(fmtKm(route.distance))+'</span><span class="rp-card-time">⏱ '+esc(route.duration)+' 分钟</span></div>' +
      (tags ? '<div class="rp-card-tags">'+tags+'</div>' : '') +
      (roads ? '<div class="rp-card-road">🛣 '+esc(roads)+'</div>' : '');
    card.onclick = function(){
      hideRPTip();
      rpCards.querySelectorAll('.rp-card').forEach(function(c){ c.classList.remove('sel'); });
      card.classList.add('sel');
      // 高亮该路线 + 视野
      var b = new TMap.LatLngBounds();
      route.polyline.forEach(function(p){ b.extend(p); });
      window.__tmapMap.fitBounds(b, { padding: 60 });
    };
    // 悬停：显示完整逐步路线指引（提示本身可交互，可在其上滚动查看；离开卡片但移到提示上时不消失）
    card.onmouseenter = function(){ clearTimeout(rpTipHideTimer); showRPTip(card, buildStepsHtml(route, mode)); };
    card.onmouseleave = function(){ clearTimeout(rpTipHideTimer); rpTipHideTimer = setTimeout(function(){ if(!rpTipHover) hideRPTip(); }, 140); };
    rpCards.appendChild(card);
  });
  // 默认选中第一条
  rpCards.querySelector('.rp-card').classList.add('sel');
}
// 初始化历史记录
fillHistoryLists();

/* 图例：等级配色始终用红/橙/绿（列表/弹窗/榜单仍按此配色），
   仅当「人流着色」关闭时，附一行说明地图标记为中性色。 */
function renderLegend(){
  var el = document.getElementById('legend');
  if(!el) return;   // 图例已按需求移除（容器删于 index.html）；保留函数使三处调用安全空转
  var offNote = crowdColorOn ? '' : '<span class="lg-b" style="color:#9aa">地图标记已用中性色 · 点👥人流色恢复（列表/弹窗仍按此配色）</span>';
  var heatScale = crowdColorOn
    ? '<div class="heat-scale" title="热力强度（近10天历史热力）"><span class="hs-lbl">低</span><span class="hs-bar"></span><span class="hs-lbl">高</span></div>'
    : '';
  el.innerHTML =
    '<div style="font-weight:700;margin-bottom:4px">人流参考</div>'+
    '<span class="lg"><span class="dot" style="background:'+COLOR[2]+';box-shadow:0 0 6px '+COLOR[2]+',0 0 12px '+COLOR[2]+'"></span>高</span>'+
    '<span class="lg"><span class="dot" style="background:'+COLOR[1]+';box-shadow:0 0 6px '+COLOR[1]+',0 0 12px '+COLOR[1]+'"></span>中</span>'+
    '<span class="lg"><span class="dot" style="background:'+COLOR[0]+';box-shadow:0 0 6px '+COLOR[0]+',0 0 12px '+COLOR[0]+'"></span>低</span>'+
    heatScale+
    '<div style="margin-top:6px">'+
    '<span class="lg-res" style="color:#6e56cf">⏱ 需预约</span>'+
    '<span class="lg-res" style="color:#4f6f8f">¥ 需购票</span>'+
    '<span class="lg-res" style="color:#30a46c">✓ 免预约</span></div>'+
    offNote;
}
renderLegend();

/* ================== 实时数据层（天气 / 行政区划 / 路况 / 动态人流 + 外部数据源）================== */

/* ---- 天气：Open-Meteo（免费无 key，CORS 支持） ---- */
function pad2(n){ return (n<10?'0':'')+n; }

/* ---- 行政区划：geojson.cn 湖北省 TopoJSON（实时拉取，CORS 支持） ---- */
var hbLayer = null, wuhanLayer = null, boundarySeq = 0;
function decodeTopo(topo){
  var sc = topo.transform.scale, tr = topo.transform.translate;
  var arcs = topo.arcs.map(function(arc){
    var x=0, y=0;
    return arc.map(function(d){ x+=d[0]; y+=d[1]; return [x*sc[0]+tr[0], y*sc[1]+tr[1]]; });
  });
  function ringPts(indices){
    var pts = [];
    indices.forEach(function(idx,k){
      var a = idx < 0 ? arcs[~idx].slice().reverse() : arcs[idx];
      a.forEach(function(p,i){ if(!(k>0 && i===0)) pts.push(p); });
    });
    if(pts.length && (pts[0][0]!==pts[pts.length-1][0] || pts[0][1]!==pts[pts.length-1][1])) pts.push(pts[0]);
    return pts.map(function(p){ return new TMap.LatLng(p[1], p[0]); });
  }
  function geomRings(g){
    var polys = g.type === 'MultiPolygon' ? g.arcs : [g.arcs];
    var out = [];
    polys.forEach(function(rings){ rings.forEach(function(idx){ out.push(ringPts(idx)); }); });
    return out;
  }
  return { geomRings: geomRings };
}
function drawBoundary(){
  /* 边界数据已本地化（O2）：原为每次访问从第三方 file.geojson.cn 拉取（144KB，
     且它挂了边界就没了）。数据源：阿里 DataV GeoAtlas（geojson.cn）1.6.3 版
     湖北省 TopoJSON，收进仓库随应用部署，同源出 + SW 预缓存（离线也有边界）。 */
  fetch('hubei.topo.json')
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
    .then(function(topo){
      var dec = decodeTopo(topo);
      var geoms = topo.objects.default.geometries;
      var hbGeoms = [], whGeoms = [];
      geoms.forEach(function(g){
        dec.geomRings(g).forEach(function(ring){
          var geo = { id: 'hb' + (boundarySeq++), paths: ring };
          hbGeoms.push(geo);
          if(g.properties.code === '420100') whGeoms.push(geo);
        });
      });
      if(hbGeoms.length){
        hbLayer = new TMap.MultiPolyline({
          map: window.__tmapMap,
          styles: { line: new TMap.PolylineStyle({ color: 'rgba(120,130,150,.45)', width: 1, lineCap: 'round' }) },
          geometries: hbGeoms
        });
      }
      if(whGeoms.length){
        wuhanLayer = new TMap.MultiPolyline({
          map: window.__tmapMap,
          styles: { line: new TMap.PolylineStyle({ color: '#0ba360', width: 3, lineCap: 'round', borderColor: 'rgba(255,255,255,.85)', borderWidth: 1 }) },
          geometries: whGeoms
        });
      }
    })
    .catch(function(){ /* 行政区划为可选图层，失败不影响主功能 */ });
}

/* ---- 实时路况：腾讯内建 traffic 底图类型 ---- */
var btnTraffic = document.getElementById('btn-traffic');
var trafficOn = false;
function setTrafficOff(){ trafficOn = false; if(btnTraffic){ btnTraffic.classList.remove('active'); btnTraffic.setAttribute('aria-pressed','false'); btnTraffic.textContent = '🚦 路况'; } }
btnTraffic.onclick = function(){
  trafficOn = !trafficOn;
  window.__tmapMap.setBaseMap({ type: trafficOn ? 'traffic' : 'vector' });
  btnTraffic.classList.toggle('active', trafficOn);
  btnTraffic.setAttribute('aria-pressed', trafficOn ? 'true' : 'false');
  btnTraffic.textContent = trafficOn ? '🚦 关路况' : '🚦 路况';
};

/* ---- 人流着色开关：默认开；可关闭以净化地图（中性灰） ---- */
var btnCrowdColor = document.getElementById('btn-crowd-color');
function syncCrowdColorBtn(){
  btnCrowdColor.textContent = crowdColorOn ? '👥 关人流色' : '👥 人流色';
  btnCrowdColor.setAttribute('aria-pressed', crowdColorOn ? 'true' : 'false');
}
btnCrowdColor.classList.toggle('active', crowdColorOn);
syncCrowdColorBtn();
btnCrowdColor.onclick = function(){
  crowdColorOn = !crowdColorOn;
  btnCrowdColor.classList.toggle('active', crowdColorOn);
  syncCrowdColorBtn();
  spotOverlays.forEach(function(o){ if(o.refresh) o.refresh(); });   // 原位刷新颜色，不销毁重建 DOM
  renderLegend();           // 同步图例配色
  drawHeatLayer();          // 热力层也随"人流着色"开关隐藏/显示
  savePrefs();
};

/* ---- 热力图层（C1：把及客智能真实 S2 栅格画成半透明色块） ---- */
/* 后端 normalizePoi 已把每个格子的 cell_center 从 WGS84 转成 GCJ-02 并透传 _cells；
   这里用一个覆盖整个地图容器的 canvas，在 projectToContainer 的像素坐标上逐格绘制径向渐变。 */
var heatCanvas = null, heatCtx = null, heatPts = [];   // heatPts: [{lng,lat,heat}]
var heatContainer = null, heatInited = false;
// 热力渐变三色（与 COLOR 反转后的 低/中/高 = 绿/橙/红 一致）：
//   #30a46c 绿 → #c2410c 橙 → #e5484d 红
var HEAT_STOPS = [[48,164,108],[194,65,12],[229,72,77]];
function lerp(a, b, t){ return Math.round(a + (b - a) * t); }
function heatRGB(t){                      // t∈[0,1] → 绿→橙→红 连续渐变（低→高）
  t = Math.max(0, Math.min(1, t));
  var seg = t < 0.5 ? 0 : 1;
  var tt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  var a = HEAT_STOPS[seg], b = HEAT_STOPS[seg + 1];
  return [lerp(a[0], b[0], tt), lerp(a[1], b[1], tt), lerp(a[2], b[2], tt)];
}
/* 容器 CSS 像素尺寸。Worker 模式下可见 canvas 可能还没挂上，退回用容器尺寸。 */
function heatSize(){
  var w = 0, h = 0;
  if(heatCanvas){ w = heatCanvas.clientWidth; h = heatCanvas.clientHeight; }
  if(!w && heatContainer) w = heatContainer.clientWidth;
  if(!h && heatContainer) h = heatContainer.clientHeight;
  return { w: w || 0, h: h || 0 };
}
function resizeHeatCanvas(){
  if(!heatCanvas) return;
  var sz = heatSize(), dpr = window.devicePixelRatio || 1;
  var w = Math.max(1, Math.round(sz.w * dpr));
  var h = Math.max(1, Math.round(sz.h * dpr));
  // 性能优化：仅在 size 变化时重设 width/height（避免每帧 pan/zoom 触发 canvas 重置 + clear）
  if(heatCanvas._lastW !== w || heatCanvas._lastH !== h){
    heatCanvas.style.width = sz.w + 'px'; heatCanvas.style.height = sz.h + 'px';
    heatCanvas._lastW = w; heatCanvas._lastH = h;
    if(heatWorkerReady){
      heatWorker.postMessage({ t:'size', w:sz.w, h:sz.h, dpr:dpr });
    } else if(heatCtx){
      heatCanvas.width = w; heatCanvas.height = h;
    }
  }
  drawHeatLayer();
}
// 预渲染「径向渐变精灵」：按 t 分桶缓存圆形光斑，pan/zoom 重绘时用 drawImage 贴图，
// 避免逐格 createRadialGradient + arc + fill 的昂贵路径（最多数千格时尤为明显）。
var HEAT_BUCKETS = 16;
var heatSprites = null, heatSpriteR = [];
function buildHeatSprites(){
  heatSprites = []; heatSpriteR = [];
  for(var i = 0; i < HEAT_BUCKETS; i++){
    var t = HEAT_BUCKETS === 1 ? 0 : i / (HEAT_BUCKETS - 1);
    var r = 10 + t * 26;              // 半径随热度增大（约 10–36px）
    var alpha = 0.10 + t * 0.32;      // 透明度随热度增大
    var col = heatRGB(t);
    var css = Math.ceil(r * 2);       // 精灵 CSS 尺寸（= 2r）
    var spr = document.createElement('canvas');
    spr.width = spr.height = css * 2; // 2x 超采样，缩放绘制时不糊
    var sc = spr.getContext('2d');
    sc.scale(2, 2);
    var g = sc.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',' + alpha + ')');
    g.addColorStop(1, 'rgba(' + col[0] + ',' + col[1] + ',' + col[2] + ',0)');
    sc.fillStyle = g;
    sc.beginPath(); sc.arc(r, r, r, 0, Math.PI * 2); sc.fill();
    heatSprites.push({ r: r, sprite: spr });
    heatSpriteR.push(r);
  }
}
/* 投影：经纬度 → 容器像素 + 热度分桶。结果写进复用的 Float32Array（刻意不做所有权转移，
   否则缓冲被转移后主线程就得每帧重新分配，反而制造 GC 抖动）。
   返回有效浮点数个数（= 3 × 视口内格子数）。 */
var heatProjLat = null, heatProjBuf = new Float32Array(0);
function projectHeatPoints(W, H){
  var n = heatPts.length;
  if(!n) return 0;
  if(!heatProjLat){ try{ heatProjLat = new TMap.LatLng(0, 0); }catch(e){ heatProjLat = null; } }
  var maxHeat = 0, i;
  for(i = 0; i < n; i++){ if(heatPts[i].heat > maxHeat) maxHeat = heatPts[i].heat; }
  if(maxHeat <= 0) maxHeat = 1;
  var last = HEAT_BUCKETS - 1;
  if(heatProjBuf.length < n * 3) heatProjBuf = new Float32Array(n * 3);
  var buf = heatProjBuf, m = 0;
  for(i = 0; i < n; i++){
    var p = heatPts[i];
    var px;
    if(heatProjLat){ heatProjLat.lat = p.lat; heatProjLat.lng = p.lng; px = window.__tmapMap.projectToContainer(heatProjLat); }
    else px = window.__tmapMap.projectToContainer(new TMap.LatLng(p.lat, p.lng));
    if(px == null) continue;
    var x = px.getX(), y = px.getY();
    if(x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;   // 视口外裁剪（最大半径 ~36px，留 40px 余量）
    var b = Math.round((p.heat / maxHeat) * last);
    if(b < 0) b = 0; else if(b > last) b = last;
    buf[m] = x; buf[m + 1] = y; buf[m + 2] = b; m += 3;
  }
  return m;
}
function drawHeatLayer(){
  if(!heatCanvas) return;
  var sz = heatSize(), dpr = window.devicePixelRatio || 1;
  var W = sz.w, H = sz.h;
  if(W <= 0 || H <= 0) return;
  var m = (crowdColorOn && heatPts.length) ? projectHeatPoints(W, H) : 0;   // 人流着色关闭 → m=0，清空热力层
  if(heatWorkerReady){
    heatWorker.postMessage({ t:'draw', w:W, h:H, dpr:dpr, count:m, buf:heatProjBuf });
    return;
  }
  if(!heatCtx) return;
  heatCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  heatCtx.clearRect(0, 0, W, H);
  if(!m) return;
  if(!heatSprites) buildHeatSprites();
  for(var i = 0; i < m; i += 3){
    var sp = heatSprites[heatProjBuf[i + 2]];
    if(!sp) continue;
    var r = sp.r;
    heatCtx.drawImage(sp.sprite, heatProjBuf[i] - r, heatProjBuf[i + 1] - r, r * 2, r * 2);   // 精灵中心对齐 (x,y)
  }
}
var heatDrawQueued = false;
function scheduleHeatDraw(){               // rAF 合并高频 pan/zoom 重绘，避免每帧都全量重画
  if(heatDrawQueued) return;
  heatDrawQueued = true;
  requestAnimationFrame(function(){ heatDrawQueued = false; drawHeatLayer(); });
}
function setHeatPts(cells){              // cells: [{c:[lng,lat], heat}]（GCJ-02）
  heatPts = (cells || []).map(function(cc){
    return { lng: cc.c[0], lat: cc.c[1], heat: Number(cc.heat) || 0 };
  }).filter(function(p){ return Number.isFinite(p.lng) && Number.isFinite(p.lat); });
  drawHeatLayer();
}
/* ---- Worker 渲染：把最贵的「成百上千次半透明 drawImage 混合」搬离主线程 ----
   可见 canvas 用 bitmaprenderer，只负责贴一帧 ImageBitmap；真正的合成在 Worker 里的
   OffscreenCanvas 上做完，transferToImageBitmap 后回传。主线程只剩一次投影计算 + 一次贴图。
   浏览器不支持、或 blob worker 被 file:// 拦掉 → 2.5s 内没等到 ready，干净地退回主线程渲染。 */
var HEAT_WORKER_OK = (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function');
var heatWorker = null, heatWorkerReady = false, heatWorkerTimer = null, heatBmpCtx = null;
var HEAT_WORKER_SRC = [
  "var cv=null,ctx=null,sp=[],rad=[],dpr=1;",
  "self.onmessage=function(ev){",
  "  var m=ev.data;",
  "  if(m.t==='init'){cv=m.canvas;ctx=cv.getContext('2d');dpr=m.dpr||1;ctx.setTransform(dpr,0,0,dpr,0,0);self.postMessage({t:'ready'});return;}",
  "  if(m.t==='sprites'){sp=m.sprites;rad=m.rad;return;}",
  "  if(m.t==='size'){dpr=m.dpr||1;var w=Math.max(1,Math.round(m.w*dpr)),h=Math.max(1,Math.round(m.h*dpr));if(cv.width!==w)cv.width=w;if(cv.height!==h)cv.height=h;ctx.setTransform(dpr,0,0,dpr,0,0);return;}",
  "  if(m.t==='draw'){",
  "    var f=m.count,buf=m.buf;",
  "    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,cv.width,cv.height);",
  "    if(f>0){ctx.setTransform(dpr,0,0,dpr,0,0);",
  "      for(var i=0;i+2<f;i+=3){var b=buf[i+2],s=sp[b];if(!s)continue;var r=rad[b];ctx.drawImage(s,buf[i]-r,buf[i+1]-r,r*2,r*2);}",
  "    }",
  "    var bmp=cv.transferToImageBitmap();",
  "    self.postMessage({t:'frame',bmp:bmp},[bmp]);",
  "    return;}",
  "};"
].join('');
function mountHeatCanvas(ctxType){
  var cv = document.createElement('canvas');
  cv.className = 'heat-layer';
  var st = cv.style;
  st.position = 'absolute'; st.left = '0'; st.top = '0'; st.width = '100%'; st.height = '100%';
  st.pointerEvents = 'none'; st.zIndex = '5';
  (heatContainer || document.getElementById('map')).appendChild(cv);
  heatCanvas = cv;
  return cv.getContext(ctxType);       // 返回上下文即可，不要在这里写 heatCtx/heatBmpCtx，避免与调用方二次赋值互相覆盖
}
function onHeatWorkerReady(){
  heatWorkerReady = true;
  heatBmpCtx = mountHeatCanvas('bitmaprenderer');
  resizeHeatCanvas();
  // 精灵仍在主线程构建（渐变与 fallback 路径逐像素一致），转成 ImageBitmap 一次性交给 Worker
  buildHeatSprites();
  var jobs = heatSprites.map(function(sp){ return createImageBitmap(sp.sprite).catch(function(){ return null; }); });
  Promise.all(jobs).then(function(bms){
    var transfer = [];
    bms.forEach(function(b){ if(b) transfer.push(b); });
    if(heatWorker){ try{ heatWorker.postMessage({ t:'sprites', sprites:bms, rad:heatSpriteR }, transfer); }catch(e){} }
    drawHeatLayer();
  });
}
function heatWorkerFallback(reason){
  if(heatWorkerTimer){ clearTimeout(heatWorkerTimer); heatWorkerTimer = null; }
  if(heatWorker){ try{ heatWorker.terminate(); }catch(e){} }
  heatWorker = null; heatWorkerReady = false; HEAT_WORKER_OK = false;
  if(heatCanvas){ console.warn('[heat] Worker 已启动但异常（'+reason+'），热力层停留在最后一帧'); return; }
  console.warn('[heat] Worker 不可用（'+reason+'），退回主线程渲染');
  heatCtx = mountHeatCanvas('2d');
  resizeHeatCanvas();
  drawHeatLayer();
}
function startHeatWorker(){
  if(!HEAT_WORKER_OK || heatWorker || heatCanvas) return false;
  var url = null;
  try{
    url = URL.createObjectURL(new Blob([HEAT_WORKER_SRC], { type:'application/javascript' }));
    heatWorker = new Worker(url);
    URL.revokeObjectURL(url); url = null;
  }catch(e){
    if(url){ try{ URL.revokeObjectURL(url); }catch(e2){} }
    heatWorker = null; HEAT_WORKER_OK = false;
    console.warn('[heat] Worker 创建失败：', e);
    return false;
  }
  heatWorker.onmessage = function(ev){
    var m = ev.data;
    if(m.t === 'ready'){
      if(heatWorkerTimer){ clearTimeout(heatWorkerTimer); heatWorkerTimer = null; }
      onHeatWorkerReady();
    } else if(m.t === 'frame'){
      if(heatBmpCtx){ heatBmpCtx.transferFromImageBitmap(m.bmp); }
      else if(m.bmp && m.bmp.close) m.bmp.close();
    }
  };
  heatWorker.onerror = function(e){ heatWorkerFallback((e && e.message) || 'error'); };
  try{
    var sz = heatSize(), dpr = window.devicePixelRatio || 1;
    var off = new OffscreenCanvas(Math.max(1, Math.round(sz.w * dpr)), Math.max(1, Math.round(sz.h * dpr)));
    heatWorker.postMessage({ t:'init', canvas:off, dpr:dpr }, [off]);
  }catch(e){
    heatWorkerFallback('init 失败');
    return true;
  }
  heatWorkerTimer = setTimeout(function(){ heatWorkerTimer = null; heatWorkerFallback('启动超时'); }, 2500);
  return true;
}
function initHeatLayer(){
  if(heatInited) return;
  var c = null;
  try { c = window.__tmapMap.getContainer(); } catch(e){ c = null; }
  if(!c) c = document.getElementById('map');
  if(!c) return;
  heatContainer = c;
  heatInited = true;
  window.__tmapMap.on('zoom', scheduleHeatDraw);
  window.__tmapMap.on('center_changed', scheduleHeatDraw);
  window.__tmapMap.on('resize', resizeHeatCanvas);
  if(startHeatWorker()) return;      // ready 之前不挂可见 canvas，启动失败还能干净回退
  heatCtx = mountHeatCanvas('2d');
  resizeHeatCanvas();
  drawHeatLayer();
}

/* ---- 动态人流模型 + 外部数据源 feed ---- */
/* 默认指向本地代理（server/server.js），前端不再持有任何 API key。
   生产部署时改成你的真实域名，如 'https://crowd.your-domain.com/api/crowd' */
var LIVE_DATA_URL = '/api/crowd';
var feedConnected = false;
var feedLastOk = 0;   // 上次外部数据源成功刷新的时间戳
var feedWasBlocked = false;   // 上一次刷新时是否处于配额降级（只在状态翻转时提示，避免每轮重复弹 toast）
function tierFor(s, h, dow, month){
  var base = CROWD[s.crowd0 != null ? s.crowd0 : s.crowd];
  var weekend = (dow === 0 || dow === 6);
  var peakSeason = (month >= 3 && month <= 5) || (month >= 9 && month <= 11);
  var outdoor = !/馆|园|博物馆|剧院|演出/.test(s.cat);
  var adj = 0;
  if(weekend) adj += 1;
  if(peakSeason && outdoor) adj += 1;
  if(h >= 10 && h <= 16) adj += 1;
  else if(h >= 22 || h <= 6) adj -= 1;
  return Math.max(0, Math.min(2, base + adj));
}
function liveCrowdFor(s, now){
  return ['低','中','高'][tierFor(s, now.getHours(), now.getDay(), now.getMonth()+1)];
}
function applyLiveCrowd(){
  var now = new Date();
  SPOTS.forEach(function(s){
    s.crowd = (s._liveCrowd != null) ? s._liveCrowd : liveCrowdFor(s, now);
  });
}

/* ================== 人流优化：择时建议 + 未来几小时趋势 + 最佳去处榜 ================== */
// 注意：必须用 window.xxx = function(){} 而非 function xxx(){} 声明，
// 因为腾讯地图 SDK 会把内联脚本放在 with(map){} 块里执行，
// 导致普通 function 声明无法提升到 window 全局作用域。
window.peakClean = function(s){ return String(s.peak || s._typPeak || '').replace(/^高峰：/, '').trim(); };
window.getCrowdAdvice = function(s){
  var pk = peakClean(s);
  if(s.crowd === '高') return { short:'避开', shortCls:'adv-hi', full:'现在人流较多，建议避开高峰（' + pk + '），改工作日或清早前往更从容。' };
  if(s.crowd === '中') return { short:'错峰', shortCls:'adv-mid', full:'人流适中可前往；' + pk + ' 会更挤，错峰体验更佳。' };
  return { short:'可去', shortCls:'adv-lo', full:'当前人少，随时可去；' + pk + ' 人会稍多，早到更佳。' };
};
/* 实时开放状态（利用 hours / 周一闭馆 数据；无数据或全天开放则返回 null，不展示） */
function openState(s){
  var h = s.hours || '';
  if(/全天/i.test(h)) return null;
  var closedMon = /周一闭馆/.test(h) || /周一闭馆/.test(s.reserveNote || '');
  var now = new Date();
  if(closedMon && now.getDay() === 1) return { cls:'closed', text:'今日闭馆' };
  var m = h.match(/(\d{1,2}):(\d{2})\s*[\-–—~]\s*(\d{1,2}):(\d{2})/);
  if(!m) return null;
  var openMin = (+m[1])*60 + (+m[2]);
  var closeMin = (+m[3])*60 + (+m[4]);
  var nowMin = now.getHours()*60 + now.getMinutes();
  if(nowMin < openMin) return { cls:'off', text:'未开放' };
  if(nowMin >= closeMin) return { cls:'closed', text:'已闭馆' };
  return { cls:'open', text:'营业中' };
}
/* 未来 8 小时逐小时等级（构造 Date 组件，跨天自动生效） */
function crowdForecast(s){
  var out = [], now = new Date();
  for(var i = 0; i < 8; i++){
    var dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + i, 0, 0);
    out.push({ h: dt.getHours(), lv: tierFor(s, dt.getHours(), dt.getDay(), dt.getMonth() + 1), now: i === 0 });
  }
  return out;
}
function trendHTML(s){
  var fc = crowdForecast(s);
  var bars = fc.map(function(f){
    var hgt = 10 + f.lv * 9;   // 低=10 中=19 高=28
    var lbl = f.now ? '现在' : (f.h + ':00');
    return '<div class="tr-col' + (f.now ? ' now' : '') + '" title="' + lbl + ' 人流' + CROWD_TXT_ARR[f.lv] + '">' +
      '<div class="tr-bar" style="height:' + hgt + 'px;background:' + COLOR[f.lv] + '"></div>' +
      '<div class="tr-h">' + lbl + '</div></div>';
  }).join('');
  return '<div class="tr-wrap">' + bars + '<div class="tr-note">未来8小时 · 估算</div></div>';
}
var CROWD_TXT_ARR = ['低', '中', '高'];

/* 侧栏「现在适合去 / 建议避开」榜单 */
var boardEl = document.getElementById('board');
function boardChips(arr){
  return arr.map(function(s){
    return '<button class="b-chip" data-i="' + getSpotIndex(s) + '" title="' + esc(s.name + ' · 人流' + s.crowd) + '">' + esc(s.emoji) + ' ' + esc(s.name) + '</button>';
  }).join('');
}
function renderBoard(){
  if(!boardEl) return;
  var good = [], bad = [];
  SPOTS.forEach(function(s){
    if(s.crowd === '低') good.push(s);
    else if(s.crowd === '高') bad.push(s);
  });
  var gHTML = good.length ? '<div class="b-row"><span class="b-t ok">✅ 现在人少 · 适合去</span><div class="b-c">' + boardChips(good.slice(0, 5)) + '</div></div>' : '';
  var bHTML = bad.length ? '<div class="b-row"><span class="b-t warn">⚠ 人流高 · 建议避开</span><div class="b-c">' + boardChips(bad.slice(0, 5)) + '</div></div>' : '';
  // 性能优化：用 DOM diff 替代完整 innerHTML 重建，避免 60 秒一次的 GC 压力
  var newHtml = (gHTML + bHTML) || '<div class="b-empty">没有需要提醒的景点</div>';
  if(boardEl._lastHtml !== newHtml){
    boardEl.innerHTML = newHtml;
    boardEl._lastHtml = newHtml;
    // 事件委托：一次绑定替代每次重建后逐个绑 onclick
    if(!boardEl._chipBound){
      boardEl.addEventListener('click', function(e){
        var ch = e.target.closest('.b-chip');
        if(ch && boardEl.contains(ch)){
          e.stopPropagation();
          select(ch.dataset.i, true);
        }
      });
      boardEl._chipBound = true;
    }
  }
}
/* ---- 天气：Open-Meteo（免费无 key，CORS 友好）----
   武汉城区定点预报，今天+明天，随人流的 10 分钟周期一起刷新。
   定位是辅助信息：拉取失败只留旧卡片/保持隐藏，绝不弹 toast 打扰。 */
var WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=30.5928&longitude=114.3055' +
  '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode' +
  '&timezone=Asia%2FShanghai&forecast_days=2';

/* WMO weathercode → {emoji, txt}。只覆盖游客关心的档位，未知的归「天气」。 */
function wmoInfo(code){
  var c = (code == null) ? -1 : code;
  if(c === 0) return {emoji:'☀️', txt:'晴'};
  if(c === 1) return {emoji:'🌤️', txt:'大致晴'};
  if(c === 2) return {emoji:'⛅', txt:'多云'};
  if(c === 3) return {emoji:'☁️', txt:'阴'};
  if(c === 45 || c === 48) return {emoji:'🌫️', txt:'雾'};
  if(c >= 51 && c <= 57) return {emoji:'🌦️', txt:'毛毛雨'};
  if(c >= 61 && c <= 67) return {emoji:'🌧️', txt:'雨'};
  if(c >= 71 && c <= 77) return {emoji:'🌨️', txt:'雪'};
  if(c >= 80 && c <= 82) return {emoji:'🌦️', txt:'阵雨'};
  if(c === 85 || c === 86) return {emoji:'🌨️', txt:'阵雪'};
  if(c >= 95) return {emoji:'⛈️', txt:'雷暴'};
  return {emoji:'🌡️', txt:'天气'};
}

/* 依据「今天」给一句出行建议（弹在卡片尾部） */
function weatherAdvice(day){
  if(!day) return '';
  if(day.code >= 95) return '可能有雷暴，户外行程留足余量';
  if(day.pop != null && day.pop >= 60) return '今天降水概率高，记得带伞 ☂';
  if(day.code >= 61 && day.code <= 82) return '有降雨，安排些室内备选（博物馆/美术馆）';
  if(day.max != null && day.max >= 35) return '高温酷暑，注意防晒补水，正午避开户外';
  if(day.max != null && day.max <= 5) return '气温较低，注意保暖';
  return '天气适宜出游，玩得开心';
}

/* open-meteo 响应 → {days:[{date,max,min,pop,code}]}；包不合法返回 null */
function parseWeather(j){
  var d = j && j.daily;
  if(!d || !Array.isArray(d.time) || d.time.length < 2 ||
     !Array.isArray(d.temperature_2m_max) || !Array.isArray(d.temperature_2m_min)) return null;
  var days = [];
  for(var i = 0; i < Math.min(2, d.time.length); i++){
    days.push({
      date: d.time[i],
      max: Math.round(d.temperature_2m_max[i]),
      min: Math.round(d.temperature_2m_min[i]),
      pop: (Array.isArray(d.precipitation_probability_max) && d.precipitation_probability_max[i] != null)
        ? Math.round(d.precipitation_probability_max[i]) : null,
      code: Array.isArray(d.weathercode) ? d.weathercode[i] : null
    });
  }
  return { days: days };
}

function renderWeatherCard(w){
  var el = document.getElementById('weatherCard');
  if(!el || !w || !w.days.length) return;
  var labels = ['今天', '明天'];
  el.innerHTML = '<div class="w-head">🌤 武汉天气</div>' +
    '<div class="w-days">' + w.days.map(function(day, i){
      var info = wmoInfo(day.code);
      return '<div class="w-day" title="' + esc(labels[i] || day.date) + '">' +
        '<span class="w-emoji">' + info.emoji + '</span>' +
        '<span class="w-body"><b>' + (labels[i] || day.date) + '</b> ' + esc(info.txt) +
        ' · ' + day.max + '° / ' + day.min + '°' +
        (day.pop != null ? ' · 💧' + day.pop + '%' : '') + '</span></div>';
    }).join('') + '</div>' +
    (weatherAdvice(w.days[0]) ? '<div class="w-tip">💬 ' + esc(weatherAdvice(w.days[0])) + '</div>' : '');
  el.hidden = false;
}

function fetchWeather(){
  return withTimeout(fetch(WEATHER_URL).then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }), 9000, '天气超时')
    .then(function(j){
      var w = parseWeather(j);
      if(w) renderWeatherCard(w);
    })
    .catch(function(e){ console.warn('[weather] 获取失败：', e && e.message); });
}

function fetchLiveData(){
  if(liveStatus){ liveStatus.classList.add('loading'); liveStatus.classList.remove('ok','sim'); }
  if(!LIVE_DATA_URL){ feedConnected = false; return Promise.resolve(); }
  SPOTS.forEach(function(s){ s._liveCrowd = null; s._stale = false; });   // 先还原为动态估算
  return withTimeout(fetch(LIVE_DATA_URL).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }), 10000, '数据源超时')
    .then(function(data){
      // 兼容两种包形态：{spots:[...]} 或 {ok,spots:[...],source}
      var spots = Array.isArray(data) ? data : (data && Array.isArray(data.spots) ? data.spots : null);
      // 只有「连数组都没有」才算包格式不对。
      // 空数组是**合法回答**：上游配额耗尽、而本地又没有 last-good 快照时，后端如实回
      // {ok:true, source:'jikeai', spots:[], failed:[...]}。
      // 早先写成 `!spots || !spots.length`，把这种情况当成「数据格式不符」抛出去，
      // catch 里一律弹「人流数据源连接失败」—— 数据源明明连着，是配额没了；
      // 更糟的是 failed 明细在抛错之前就被丢掉了，用户既看不到原因也看不到数量。
      if(!spots) throw new Error('数据格式不符');
      window.__feedSource = data.source || '';   // 给 updateLiveStatus 显示来源
      window.__feedFailed = Array.isArray(data.failed) ? data.failed.length : 0;
      // 配额熔断状态。后端已经在 response 里如实透出，这里不读的话，
      // 降级时用户只看到含糊的「本地 mock」，完全看不出是上游配额耗尽。
      window.__feedQuotaBlocked = !!(data && data.quotaBlocked);
      window.__feedQuotaReason = (data && data.quotaReason) || '';
      window.__feedStale = (data && typeof data.stale === 'number') ? data.stale : 0;
      window.__feedEmpty = spots.length === 0;
      var byName = {};
      var feedWin = null;
      spots.forEach(function(x){ if(x && x.name) byName[x.name] = x; });
      SPOTS.forEach(function(s){
        var x = byName[s.name]; if(!x) return;
        if(x.crowd === '高' || x.crowd === '中' || x.crowd === '低') s._liveCrowd = x.crowd;
        if(x._stale) s._stale = true;   // 来自 last-good 快照（数据源暂不可用）
        // 只接受白名单内的 reserve，避免非法值让 RESERVE_TXT 解构崩溃
        if(x.reserve && RESERVE_TXT[x.reserve]) s.reserve = x.reserve;
        if(x.reserveNote != null) s.reserveNote = String(x.reserveNote);
        if(x.ticket != null) s.ticket = String(x.ticket);
        if(x.peak != null) s.peak = String(x.peak);
        // 历史热力栅格与数据窗口（及客智能近10天）
        if(Array.isArray(x._cells)) s._heatCells = x._cells;
        if(x._window && x._window.from){ s._heatWindow = x._window; if(!feedWin) feedWin = x._window; }
        if(x._typPeak) s._typPeak = x._typPeak;
        if(x._totalHeat != null) s._totalHeat = x._totalHeat;
      });
      window.__feedWindow = feedWin;   // 给 updateLiveStatus 显示数据窗口
      // 汇总全部栅格 → 刷新热力图层
      var cells = [];
      SPOTS.forEach(function(s){ if(Array.isArray(s._heatCells)) cells = cells.concat(s._heatCells); });
      setHeatPts(cells);
      if(liveStatus){ liveStatus.classList.remove('loading'); }
      // 只在「刚进入降级」的那一刻提示一次。状态徽标会一直挂着这条信息，
      // 每 10 分钟再弹一次同样的 toast 只会变成噪音。
      if(window.__feedQuotaBlocked){
        if(!feedWasBlocked){
          toast('上游及客智能配额已用尽，已切换到' + (window.__feedStale ? '缓存数据' : '本地估算'));
        }
      } else if(window.__feedFailed > 0 && !window.__feedEmpty){
        toast(window.__feedFailed + ' 个景点数据获取失败，已显示可用数据');
      }
      feedWasBlocked = !!window.__feedQuotaBlocked;
      feedConnected = true; feedLastOk = Date.now();
      // 取到新数据后必须重绘一次。原先这里什么都不做，只有 catch 分支调 updateLiveStatus()，
      // 于是：① 状态徽标停在「本地动态估算」② 列表/地图的人流颜色也停在旧值，
      // 两者都要等满 60s 的 refreshtick() 才对。pollExternal 里那句
      // 「fetchLiveData 内部已经处理了 refreshView」与实际代码并不符。
      // startLive() 是先存好 crowd0 再 pollExternal()，所以这里调 refreshView() 顺序安全。
      // 它内部已包含 updateLiveStatus()。
      refreshView();
    })
    .catch(function(err){
      feedConnected = false;
      if(liveStatus){ liveStatus.classList.remove('loading'); }
      console.warn('[live] 数据源失败：', err && err.message);
      toast('人流数据源连接失败，已切换到缓存/估算');
      updateLiveStatus();
    });
}
var liveStatus = document.getElementById('liveStatus');
if(liveStatus && !document.getElementById('liveRefreshBtn')){
  var btn = document.createElement('button');
  btn.id = 'liveRefreshBtn';
  btn.className = 'live-refresh';
  btn.type = 'button';
  btn.title = '手动刷新人流数据';
  btn.setAttribute('aria-label', '手动刷新人流数据');
  btn.textContent = '↻';
  btn.onclick = function(){
    btn.disabled = true;
    btn.style.opacity = '.4';
    fetchLiveData().then(function(){
      btn.disabled = false;
      btn.style.opacity = '';
      updateLiveStatus();
    }).catch(function(){
      btn.disabled = false;
      btn.style.opacity = '';
    });
  };
  liveStatus.parentNode.insertBefore(btn, liveStatus.nextSibling);
}
function fmtHeatWindow(w){   // {from:'YYYYMMDD',to:'YYYYMMDD'} → 'MM-DD ~ MM-DD'
  if(!w) return '';
  var f = String(w.from || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$2-$3');
  var t = String(w.to || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$2-$3');
  if(!f && !t) return '';
  return (f && t) ? (' · 数据窗口 ' + f + ' ~ ' + t) : (f ? (' · 数据窗口 ' + f) : '');
}
function updateLiveStatus(){
  var now = new Date();
  var t = pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());
  var winTxt = fmtHeatWindow(window.__feedWindow);
  var blocked = !!window.__feedQuotaBlocked;
  var empty = !!window.__feedEmpty;
  if(feedConnected){
    var src = window.__feedSource;
    var label, dot = '🟡', cls = 'live-status sim';
    if(blocked){
      // 上游配额耗尽是明确的故障态，得让它在视觉上和「一切正常」分得开。
      dot = '🟠'; cls = 'live-status warn';
      label = window.__feedStale ? '上游配额已用尽 · 显示缓存数据' : '上游配额已用尽 · 已切到本地估算';
    } else if(src === 'jikeai' && !empty){
      label = '及客智能 · 已连接';
      dot = '🟢'; cls = 'live-status ok';
      if(Date.now() - feedLastOk > 25 * 60 * 1000){   // 已连接但迟迟未刷新：诚实降级提示
        dot = '🟡'; cls = 'live-status sim'; label += ' · 长时间未刷新';
      }
    } else if(src === 'jikeai'){
      label = '及客智能 · 本次无数据';    // 连上了却一个景点都没回来，不该给绿点
    } else if(src === 'cached'){
      label = '缓存数据 · 数据源暂不可用';
    } else if(src === 'mock'){
      // 绿点只留给真实上游数据。mock / 估算不是「已连接」，早先一律挂 🟢。
      label = '本地 mock · 未接真实数据源';
    } else {
      label = '外部数据源 · 已连接';
    }
    liveStatus.innerHTML = dot + ' ' + label + winTxt + ' · 更新于 ' + t;
    liveStatus.className = cls;
  } else {
    liveStatus.innerHTML = '🟡 本地动态估算 · 更新于 ' + t;
    liveStatus.className = 'live-status sim';
  }
}

/* ---- 选中状态保持 + 定时刷新 ---- */
var selectedId = null;
/* 只原位更新「人流 tag」与「标记/聚合颜色」，不重建列表与聚合 —— 60s tick 的关键优化 */
function patchLiveUI(){
  list.querySelectorAll('.item').forEach(function(el){
    var s = SPOTS[+el.dataset.id]; if(!s) return;
    var tag = el.querySelector('.it-tags .tag');
    if(tag){ tag.textContent = CROWD_TXT[s.crowd]; tag.className = 'tag ' + (CROWD_CLS[s.crowd] || 't-lo'); }
    var sb = el.querySelector('.it-src');
    if(sb){ sb.textContent = s._liveCrowd ? (s._stale ? '缓存' : '近10天') : '估算'; }
  });
  spotOverlays.forEach(function(o){ if(o.refresh) o.refresh(); });
}
function refreshView(){
  applyLiveCrowd();
  applyFilters();
  renderBoard();
  if(popupSpot){ var sp = popupSpot; openInfo(sp); }
  updateLiveStatus();
}
function fieldSig(s){ return [s.crowd, s.reserve, s.reserveNote, s.ticket, s.peak, s._typPeak].join('|'); }   // 动态字段签名，判断是否需要重建弹窗
function refreshtick(){                     // 60s 轻量刷新：只做人流颜色 patch，不重建列表/聚合
  var popSig = popupSpot ? fieldSig(popupSpot) : null;
  applyLiveCrowd();
  patchLiveUI();                        // 内部已调用 spotOverlays.forEach(o => o.refresh())
  renderBoard();
  if(popupSpot){
    // 内容（人流/预约/门票）变了才重建弹窗，否则只微调位置 —— 避免每 60s 无谓重建 + 抢焦点
    if(fieldSig(popupSpot) !== popSig){ var sp = popupSpot; openInfo(sp); }
    else { positionPopup(); }
  }
  updateLiveStatus();
}
function startLive(){
  SPOTS.forEach(function(s){ s.crowd0 = s.crowd; });   // 保存原始基线
  refreshView();
  setInterval(function(){ if(!document.hidden) refreshtick(); }, 60000);   // 人流/状态每 60s（轻量 patch）
  // 性能优化（E）：把天气和人流数据合并到同一个 setInterval 周期性并发请求（10 分钟）
  // 启动时：一次性并发拉取首屏数据
  function pollExternal(){
    fetchWeather();   // 天气与人流并发拉取：天气独立成败，失败不打扰人流链路
    return fetchLiveData().then(function(){
      // 成功路径已在 fetchLiveData 内部重绘（refreshView + 徽标），这里不用再动
    }, function(err){ console.warn('[live] 更新失败', err); });
  }
  pollExternal();
  initMenu();                                            // ☰ 工具菜单（收纳原工具条与图例）
  initFilterToggles();                                   // 筛选折叠成图标
  initHeatLayer();                                      // 真实热力图层（读 _cells）
  drawBoundary();                                       // 行政区划
  setInterval(function(){ if(!document.hidden) pollExternal(); }, 10 * 60 * 1000);   // 10 分钟一次，2 个请求并发
}
/* 后台标签页暂停轮询（省电）；回到前台立即补一次人流刷新 */
document.addEventListener('visibilitychange', function(){
  if(!document.hidden && typeof refreshtick === 'function') refreshtick();
});
/* ---- 行程 / 筛选 / 主题 持久化（刷新后恢复） ---- */
var PREFS_KEY = 'wuhan_map_prefs';
// 性能优化：连续触发（chip 切换/暗色切换/行程增删）合并为 1 次 lsSet
var _savePrefsTimer = 0;
function savePrefs(){
  if(_savePrefsTimer) return;
  _savePrefsTimer = setTimeout(function(){
    _savePrefsTimer = 0;
    lsSet(PREFS_KEY, JSON.stringify({
      waypoints: waypoints, mode: curMode, crowdF: crowdF, resF: resF,
      zoneF: zoneF, metroF: metroF,
      crowdColorOn: crowdColorOn, sortBy: sortBy
    }));
  }, 250);
}
function applyChipActive(el, v){
  el.querySelectorAll('.chip').forEach(function(c){ c.classList.toggle('active', c.dataset.v === v); });
}
function restorePrefs(){
  var p; try{ p = JSON.parse(localStorage.getItem(PREFS_KEY)||'{}'); }catch(e){ p = {}; }
  if(p.waypoints && Array.isArray(p.waypoints)) waypoints = p.waypoints.slice(0, 50);
  if(p.mode && routeModeName[p.mode]){
    curMode = p.mode;
    rpModes.querySelectorAll('.rp-mode').forEach(function(b){
      var isActive = b.dataset.mode === curMode;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-checked', isActive ? 'true' : 'false');
    });
  }
  if(p.crowdF){ crowdF = p.crowdF; applyChipActive(document.getElementById('cf-crowd'), crowdF); } else { applyChipActive(document.getElementById('cf-crowd'), ''); }
  if(p.resF){ resF = p.resF; applyChipActive(document.getElementById('cf-reserve'), resF); } else { applyChipActive(document.getElementById('cf-reserve'), ''); }
  // 区域/地铁：restorePrefs 在 initZoneMetro 之后执行，metroChips 已渲染，可安全置 active
  if(p.zoneF){ zoneF = p.zoneF; applyChipActive(document.getElementById('zoneChips'), zoneF); }
  if(p.metroF){ metroF = p.metroF; applyChipActive(document.getElementById('metroChips'), metroF); }
  if('sortBy' in p){ sortBy = p.sortBy; applyChipActive(document.getElementById('cf-sort'), sortBy); }
  if('crowdColorOn' in p){
    crowdColorOn = !!p.crowdColorOn;
    var _bcc = document.getElementById('btn-crowd-color');
    if(_bcc){ _bcc.classList.toggle('active', crowdColorOn); syncCrowdColorBtn(); }
    renderLegend();
  }
  // 主题不再从 localStorage 恢复，每次打开一律日间。
  // 之前 dark 是持久化的：只要误按过一次 d 键（全局快捷键，输入框外都会触发），
  // 整个应用就被永久翻成夜间，而且入口藏在 ☰工具 → 🌙夜间 里面，
  // 用户看到的是一个「莫名其妙变黑」的界面，找不到地方退出来。
  // 现在切换只在当前会话内有效，刷新即恢复日间 —— 想用夜间/紫晶就现开一次。
  applyTheme('light');
  if(waypoints.length){ renderWaypoints(); setRoutePanel(true); routePanel.classList.remove('collapsed'); }
}
/* ================== 分享链接（C4）==================
   当前筛选（区域/地铁/人群/预约/排序）+ 行程（途经点/出行方式）编码进 URL hash，
   形如 #z=汉阳&ml=6&wp=黄鹤楼→汉口江滩&mode=transit（值经 encodeURIComponent）。
   打开带 hash 的链接：hash 优先于 localStorage 恢复，一次生效后从地址栏清掉
   （history.replaceState），避免和后续手动保存的偏好打架；不自动发起路线查询。 */
var ZONE_OK_LIST = ['武昌', '汉口', '汉阳', '远郊'];
var CROWD_OK_LIST = ['高', '中', '低'];
var SORT_OK_LIST = ['dist', 'heat'];

function buildShareHash(){
  var p = [];
  if(zoneF) p.push('z=' + encodeURIComponent(zoneF));
  if(metroF) p.push('ml=' + encodeURIComponent(metroF));
  if(crowdF) p.push('crowd=' + encodeURIComponent(crowdF));
  if(resF) p.push('reserve=' + encodeURIComponent(resF));
  if(sortBy) p.push('sort=' + encodeURIComponent(sortBy));
  if(waypoints.length){
    p.push('wp=' + encodeURIComponent(waypoints.join('→')));
    if(curMode !== 'driving') p.push('mode=' + encodeURIComponent(curMode));
  }
  return p.length ? '#' + p.join('&') : '';
}

/* 解析并应用分享 hash。所有值过白名单 —— 分享链接是外部输入，
   伪造的 hash（z=北京&crowd=超高）必须静默忽略而不是污染状态。
   返回是否应用了任何状态。 */
function applyShareHash(h){
  if(!h || h.charAt(0) !== '#') return false;
  var q = {};
  new URLSearchParams(h.slice(1)).forEach(function(v, k){ q[k] = v; });
  var touched = false;
  if(ZONE_OK_LIST.indexOf(q.z) >= 0){ zoneF = q.z; applyChipActive(document.getElementById('zoneChips'), zoneF); touched = true; }
  if(/^\d+$/.test(q.ml || '')){ metroF = q.ml; applyChipActive(document.getElementById('metroChips'), metroF); touched = true; }
  if(CROWD_OK_LIST.indexOf(q.crowd) >= 0){ crowdF = q.crowd; applyChipActive(document.getElementById('cf-crowd'), crowdF); touched = true; }
  if(q.reserve && RESERVE_TXT[q.reserve]){ resF = q.reserve; applyChipActive(document.getElementById('cf-reserve'), resF); touched = true; }
  if(SORT_OK_LIST.indexOf(q.sort) >= 0){ sortBy = q.sort; applyChipActive(document.getElementById('cf-sort'), sortBy); touched = true; }
  if(typeof q.wp === 'string' && q.wp){
    // 站名过滤：链接可能是旧的（景点已改名/下架），只导入仍存在的
    var byName = {};
    SPOTS.forEach(function(s){ byName[s.name] = s; });
    var stops = q.wp.split('→').filter(function(n){ return !!byName[n]; });
    if(stops.length){
      waypoints = stops;
      setRouteMode(routeModeName[q.mode] ? q.mode : 'transit');
      renderWaypoints();          // 内部会同步起终点输入框
      syncAddButtons();
      setRoutePanel(true);
      touched = true;
    }
  }
  return touched;
}

/* 启动入口：restorePrefs 之后、startLive 之前调用（refreshView 会统一按新状态重绘） */
/* 分享 hash 用完不立刻清（SW 更新自动刷新会丢状态，见下），挂到用户首次交互再清。
   启动与 hashchange（F4）两条路都走这里武装，重复武装是幂等的。 */
function armShareHashClear(){
  var clear = function(){
    history.replaceState(null, '', location.pathname + location.search);
    window.removeEventListener('pointerdown', clear);
    window.removeEventListener('keydown', clear);
  };
  window.addEventListener('pointerdown', clear);
  window.addEventListener('keydown', clear);
}
function applyShareFromLocation(){
  if(!location.hash) return;
  try { applyShareHash(location.hash); } catch(e) { console.warn('[share] hash 应用失败：', e); }
  armShareHashClear();
}
/* 已打开的标签页里点分享链接只会触发同文档 hashchange（F4）：
   应用状态 + 重绘 + 重新武装「交互后清除」。replaceState 清除不会触发 hashchange，无循环。 */
function onShareHashChange(){
  if(!location.hash) return;
  var applied = false;
  try { applied = applyShareHash(location.hash); } catch(e) { console.warn('[share] hash 应用失败：', e); }
  if(applied){
    refreshView();
    armShareHashClear();
  }
}
window.addEventListener('hashchange', onShareHashChange);

function copyShareUrl(){
  var h = buildShareHash();
  var url = location.origin + location.pathname + (h || '');
  var done = function(){ toast(h ? '分享链接已复制（筛选 + 行程）' : '当前没有可分享的筛选/行程，已复制页面链接', 'ok'); };
  var fail = function(){
    // 剪贴板 API 在 http 环境/未授权时会失败 —— 降级为可手选复制的输入框
    window.prompt('长按或 Ctrl+C 复制分享链接：', url);
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(url).then(done, fail);
  } else { fail(); }
}
var rpShareBtn = document.getElementById('rpShare');
if(rpShareBtn) rpShareBtn.onclick = copyShareUrl;

restorePrefs();
applyShareFromLocation();
startLive();

/* 暴露给外部 / 无头测试的只读调试句柄 */
window.__app = {
  getWaypoints: function(){ return waypoints.slice(); },
  doQuery: doQuery, renderRoutes: renderRoutes, clearRoute: clearRoute,
  geo: geo, gCache: gCache, dCache: dCache, applyTheme: applyTheme,
  toggleWaypoint: toggleWaypoint, refreshView: refreshView, refreshtick: refreshtick,
  buildShareHash: buildShareHash, applyShareHash: applyShareHash
};
window.__appReady = true;

} /* end startApp */

// 鼠标光斑（--px/--py 跟随 + ::before 径向渐变）已整体移除。
// 原因：那套光斑按 4% 量化后每帧往 11 个类写内联自定义属性，靠重绘表达「命中」，
// 但它压的其实是控件本身的底色 —— 小控件（.zoom-btn/.pp-close 只有 24px，.rp-mode 28px）
// 上一个 16~26px 的白色径向渐变几乎盖满整个按钮，emoji 和灰字被冲淡，
// 看上去就是「一层白光压在功能按钮上面」，反而比没有反馈更糟。
// 现在统一改成由控件自己的 hover 背景/位移/阴影表达反馈，
// 对应的规则是 :where(.rp-mode,.b-chip):hover / :where(.zoom-btn,.zoom-help,.pp-close):hover
// 以及 .btn:hover / .chip:hover / .rp-card:hover / .menu-item:hover / .item-add:hover / .pp-close:hover。
// 少一层合成、少一次 mousemove 重绘，深色模式下也不再需要单独把光斑调暗。

// 拖动地图期间：覆盖物层不吃指针事件，hover 光影全部压制。
// 没有这个的话，拖动过程中途经的 pin / 标签会一路被点亮，看起来像「碰到了文字」。
(function(){
  var wrap = document.getElementById('mapwrap') || document.getElementById('map');
  if(!wrap) return;
  function setDragging(on){ document.body.classList.toggle('map-dragging', !!on); }
  wrap.addEventListener('mousedown', function(){ setDragging(true); });
  window.addEventListener('mouseup', function(){ setDragging(false); });
  window.addEventListener('blur', function(){ setDragging(false); });
  window.addEventListener('touchend', function(){ setDragging(false); });
})();

// 重写 maxCrowdLevel/clusterSummary 在 startApp 外（SDK 内部 createDOM 需要全局可见）
function maxCrowdLevel(geoms){
  var lv = 0;
  if(!geoms) return 0;
  for(var i=0;i<geoms.length;i++){
    var g = geoms[i];
    if(g && g.properties && SPOTS[g.properties.index]){
      lv = Math.max(lv, CROWD[SPOTS[g.properties.index].crowd]);
    }
  }
  return lv;
}
function clusterSummary(geoms){
  var hi=0, mid=0, lo=0;
  if(!geoms) return {total:0, hi:0, mid:0, lo:0};
  for(var i=0;i<geoms.length;i++){
    var c = geoms[i] && geoms[i].properties ? CROWD[SPOTS[geoms[i].properties.index].crowd] : 0;
    if(c === 2) hi++; else if(c === 1) mid++; else lo++;
  }
  return { total: geoms.length, hi: hi, mid: mid, lo: lo };
}

/* ========== 动态加载腾讯地图 GL（Key 已提取到 TMAP_KEY，见文件顶部） ========== */
/* 启动容错：捕获 startApp 异常，避免 Key 失效/网络异常时留下空白页 */
function safeStartApp(){
  if(safeStartApp._started) return;      // 防重入
  safeStartApp._started = false;   // 第一次执行失败时允许重试；真正执行成功后再设为 true
  // 防御性检查：所有 innerHTML 操作依赖的关键 DOM 元素
  if(!document.getElementById('liveStatus')) console.warn('[safeStartApp] liveStatus not found');
  if(!document.getElementById('board')) console.warn('[safeStartApp] board not found');
  if(!document.getElementById('spotPopup')) console.warn('[safeStartApp] spotPopup not found');
  if(!document.getElementById('mapwrap')){ console.error('[safeStartApp] CRITICAL: mapwrap not found'); return; }
  try{
    startApp();
    safeStartApp._started = true;   // 真正成功后标记已启动
  }catch(err){
    var b = document.getElementById('boot');
    if(!b){ b = document.createElement('div'); b.id='boot'; document.getElementById('mapwrap').appendChild(b); }
    b.textContent = '🚧 初始化失败：'+((err && err.message) || err)+'（请检查 Key / 网络 / 域名白名单）';
    console.error('[startApp error]', err && err.stack || err);
    b.style.display = 'flex';
    b.innerHTML += '<br><button id="mapRetryBtn" style="margin-top:12px;padding:8px 20px;background:#e5484d;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;" onclick="location.reload()">🔄 重新加载地图</button>';
    safeStartApp._started = false;       // 允许重试
  }
}
(function loadGl(){
  if(window.TMap){ safeStartApp(); return; }
  var s = document.createElement('script');
  s.charset = 'utf-8';
  s.src = 'https://map.qq.com/api/gljs?libraries=geometry,tools,service&v=1&key=' + TMAP_KEY;
  s.onload = function(){ safeStartApp(); };
  s.onerror = function(){
    var b = document.getElementById('boot');
    if(b) b.textContent = '🚧 腾讯地图 API 加载失败，请检查 Key / 网络 / 域名白名单';
  };
  document.head.appendChild(s);
})();
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').then(function(reg){
    reg.addEventListener('updatefound', function(){
      var nw = reg.installing;
      if(!nw) return;
      nw.addEventListener('statechange', function(){
        // 有更新（非首次安装）且新 SW 已缓存好 → 提示并接管刷新
        if(nw.state === 'installed' && navigator.serviceWorker.controller){
          toast('✨ 新版本已就绪，正在刷新…', 'info');
          if(reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
  }).catch(function(){ /* SW registration failed silently */ });
  // SKIP_WAITING 后新 SW 接管旧页面 → 触发自动刷新
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    window.location.reload();
  });
}

/* ---- PWA 安装引导（F5）----
   beforeinstallprompt 只有 Chromium 系浏览器满足安装条件时才发（https/localhost、
   图标齐全、未安装过）。iOS Safari 不发这个事件 —— 菜单按钮保持隐藏，
   用户手动「添加到主屏幕」由 apple-touch-icon 支持。 */
var deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();
  deferredInstallPrompt = e;
  var b = document.getElementById('btnInstall');
  if(b) b.hidden = false;
});
(function(){
  var b = document.getElementById('btnInstall');
  if(!b) return;
  b.onclick = function(){
    if(!deferredInstallPrompt){ b.hidden = true; return; }
    deferredInstallPrompt.prompt();
    Promise.resolve(deferredInstallPrompt.userChoice).then(function(choice){
      if(choice && choice.outcome === 'accepted') toast('已添加到桌面，之后可离线打开 ✨', 'ok');
      deferredInstallPrompt = null;
      b.hidden = true;
    }).catch(function(){ deferredInstallPrompt = null; b.hidden = true; });
  };
})();
window.addEventListener('appinstalled', function(){
  deferredInstallPrompt = null;
  var b = document.getElementById('btnInstall');
  if(b) b.hidden = true;
});

