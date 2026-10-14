// PWA Service Worker v30 — 分级缓存策略
// 改任何前端文件后把 VERSION 加 1：三个缓存名都跟着它走，
// activate 会顺手把上一个 VERSION 的缓存删掉（见下方 activate）。
var VERSION = 38;
var CACHE = 'wuhan-map-v' + VERSION;
var BYPASS = false;
var STATIC_CACHE = 'wuhan-map-static-v' + VERSION;
var RUNTIME_CACHE = 'wuhan-map-runtime-v' + VERSION;

/* 所有预缓存地址一律以 SW 注册的 scope 为基准解析（A2）。
   之前写死 '/style.min.css' 这类根绝对路径：部署到子路径（GitHub Pages 项目页、
   内网子目录）时 addAll 会去请求 https://host/style.min.css → 404 → SW 整个安装失败。
   scope 永远以 '/' 结尾，new URL('app.min.js', scope) 即本目录下的绝对地址。 */
var SCOPE = new URL(self.registration.scope);
function scoped(p){ return new URL(p, SCOPE).href; }
var ENTRY_HTML = scoped('index.html');

// install: 预缓存关键资源（含入口 HTML —— A1）
// 入口页进缓存后，「从未在线访问过的设备」断网打开也能拿到完整应用外壳；
// fetch 里 navigate 分支的兜底也用它（见下）。
self.addEventListener('install', function(e){
  e.waitUntil(Promise.all([
    caches.open(STATIC_CACHE).then(function(c){
      return c.addAll([
        scoped('style.min.css'),
        scoped('app.min.js'),
        scoped('spots.data.js'),
        scoped('manifest.json')
      ]);
    }),
    caches.open(CACHE).then(function(c){
      return c.addAll([ ENTRY_HTML ]);
    })
  ]).then(function(){
    self.skipWaiting();
  }));
});

// activate: 清理旧版本
self.addEventListener('activate', function(e){
  e.waitUntil(Promise.all([
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){
        return k.indexOf('wuhan-map-') === 0 && k !== CACHE && k !== STATIC_CACHE && k !== RUNTIME_CACHE;
      }).map(function(k){ return caches.delete(k); }));
    }),
    self.clients.claim()
  ]));
});

self.addEventListener('message', function(e){
  if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if(e.data && e.data.type === 'CLEAR_CACHE'){
    BYPASS = true;
    Promise.all([caches.delete(CACHE), caches.delete(STATIC_CACHE), caches.delete(RUNTIME_CACHE)])
      .then(function(){ e.source.postMessage({type:'CACHE_CLEARED'}); });
  }
});

// 资源分类
function isStaticAsset(url){
  return url.indexOf('style.min.css') >= 0 ||
         url.indexOf('app.min.js') >= 0 ||
         url.indexOf('spots.data.js') >= 0 ||
         url.indexOf('app.js') >= 0 ||       // 旧页面还可能直接请求源文件，同样按静态资源对待
         url.indexOf('manifest.json') >= 0;
}
function isHTML(url){
  return url === SCOPE.href || url.slice(-1) === '/';
}
function isSpots(url){
  return url.indexOf('spots.json') >= 0;
}
function isExternalAPI(url){
  return url.indexOf('map.qq.com') >= 0 ||
         url.indexOf('open-meteo') >= 0 ||
         url.indexOf('geojson') >= 0 ||
         url.indexOf('/api/') >= 0;
}

var OFFLINE_MSG = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>离线 — 武汉景点地图</title><style>body{font-family:sans-serif;padding:24px;background:#f5f5f5;display:flex;flex-direction:column;align-items:center;gap:16px}h1{color:#e5484d;margin:0}p{color:#666;text-align:center;max-width:300px}a{background:#e5484d;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none}</style></head><body><h1>📍 离线模式</h1><p>地图数据暂时不可用，请检查网络连接后重试。</p><a href="/">刷新重试</a></body></html>';

self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  var url = e.request.url;

  if(BYPASS || url.indexOf('nocache') >= 0 || url.indexOf('fresh=') >= 0){
    e.respondWith(fetch(e.request));
    return;
  }

  // 外部 API：网络 only，失败返回离线
  if(isExternalAPI(url)){
    e.respondWith(fetch(e.request).catch(function(){
      if(isSpots(url)){
        return new Response(JSON.stringify({ok:true,spots:[],source:'offline'}), {
          headers:{'Content-Type':'application/json'}
        });
      }
      return new Response(OFFLINE_MSG, {headers:{'Content-Type':'text/html'}});
    }));
    return;
  }

  /* 静态资源（CSS/JS/manifest）：stale-while-revalidate。
     原来是 cache-first，注释还写着「文件名带版本后缀，永不过期」——
     但 HTML 里引的就是裸的 app.min.js / style.min.css，根本没有版本后缀。
     两者凑在一起的后果是：改完代码推上去，用户永远拿不到新版，
     非得手动清缓存才行。现在改成先给缓存（秒开），同时后台拉新的写回缓存，
     下次刷新自然就是新代码；离线时也还有缓存可看。
     真正保证「一定拿到新版」的是上面 skipWaiting + app.js 里的 controllerchange 自动刷新。 */
  if(isStaticAsset(url)){
    e.respondWith(
      caches.open(STATIC_CACHE).then(function(cache){
        return cache.match(url).then(function(cached){
          var networkFetch = fetch(e.request).then(function(resp){
            if(resp && resp.ok) cache.put(url, resp.clone());
            return resp;
          }).catch(function(){
            return cached || new Response('', {status: 504, statusText: 'offline'});
          });
          return cached || networkFetch;
        });
      })
    );
    return;
  }

  // spots.json：stale-while-revalidate
  if(isSpots(url)){
    e.respondWith(
      caches.open(RUNTIME_CACHE).then(function(cache){
        return cache.match(url).then(function(cached){
          var networkFetch = fetch(e.request).then(function(resp){
            if(resp && resp.ok) cache.put(url, resp.clone());
            return resp;
          }).catch(function(){
            return cached || new Response(JSON.stringify({ok:true,spots:[],source:'offline'}), {
              headers:{'Content-Type':'application/json'}
            });
          });
          return cached || networkFetch;
        });
      })
    );
    return;
  }

  /* HTML 导航：network-first —— 页面内容经常更新，在线时永远拿最新的。
     判定用 request.mode === 'navigate'（A1）：原来按 URL 字符串匹配 scope 根路径，
     入口页「index.html」永远匹配不上，掉进最底下的「默认网络」分支 ——
     断网刷新只能看到 OFFLINE_MSG 错误页，预缓存的完整应用根本用不上。
     navigate 模式覆盖所有页面地址（中文文件名、scope 根、index.html）。
     离线兜底顺序：当前地址的缓存 → 预缓存的入口 HTML → 离线提示页。
     第二级是关键：Express 部署下入口常是 scope 根（'/'），它不在预缓存清单里，
     但内容就是入口 HTML —— 直接回退到 ENTRY_HTML，别让用户看到错误页。 */
  if(e.request.mode === 'navigate' || isHTML(url)){
    e.respondWith(
      fetch(e.request).then(function(resp){
        if(resp && resp.ok){
          var copy = resp.clone();
          caches.open(CACHE).then(function(c){ c.put(url, copy); });
        }
        return resp;
      }).catch(function(){
        return caches.open(CACHE).then(function(c){
          return c.match(url).then(function(cached){
            return cached || c.match(ENTRY_HTML).then(function(entry){
              return entry || new Response(OFFLINE_MSG, {headers:{'Content-Type':'text/html'}});
            });
          });
        });
      })
    );
    return;
  }

  // 其他 GET：默认网络
  e.respondWith(fetch(e.request).catch(function(){
    return new Response(OFFLINE_MSG, {headers:{'Content-Type':'text/html'}});
  }));
});
