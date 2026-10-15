// 武汉景点人流代理后端
// 启动：cd server && cp .env.example .env && npm i && npm start

require('dotenv').config();
const express = require('express');
const path = require('path');
const zlib = require('zlib');
const crowdRouter = require('./routes/crowd');
const metricsRouter = require('./routes/metrics');
const { HttpError } = require('./lib/errors');

const app = express();
app.disable('x-powered-by');

// 压缩中间件：按 Accept-Encoding 选 br/gzip。三条硬约束（2026-10 实测定稿）：
//   1. 必须异步 —— *Sync 会卡死事件循环：brotli 默认 q11 压 113KB 的 app.min.js
//      要 79ms（gzip 仅 2ms，40 倍），首屏 4 个资源同步串起来 = 200-300ms 里
//      整个服务器（含 /api/crowd）无响应。异步版跑在 libuv 线程池，不碰事件循环。
//   2. brotli 用 q4 —— 实测 1.5ms / 34KB（q11 是 79ms / 28KB：40 倍 CPU 只换来 6KB）。
//   3. Vary 一律 res.vary()（追加语义）—— setHeader 是覆盖：压缩分支的
//      'Accept-Encoding' 会踩掉 CORS 分支的 'Origin'（反之亦然），缓存可能串包。
function compressionMiddleware(req, res, next){
  const accept = (req.headers['accept-encoding'] || '').toLowerCase();
  if(!accept.match(/\b(br|gzip)\b/)) return next();
  const encoding = accept.indexOf('br') >= 0 ? 'br' : 'gzip';
  res.vary('Accept-Encoding');   // 未压缩的响应也要声明：同一 URL 存在编码变体
  const originalEnd = res.end.bind(res);
  const chunks = [];
  res.write = function(chunk){
    if(chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  res.end = function(chunk){
    if(chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    // 仅压缩 >1KB 的文本/JSON
    if(!(body.length > 1024 && /text|json|javascript|css/.test(res.getHeader('content-type') || ''))){
      return originalEnd(body);
    }
    const finish = function(err, compressed){
      if(!err && compressed && compressed.length < body.length){
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', compressed.length);
        return originalEnd(compressed);
      }
      originalEnd(body);   // 压缩失败或反而变大 → 原样发送
    };
    if(encoding === 'br'){
      zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, finish);
    } else {
      zlib.gzip(body, finish);
    }
  };
  next();
}

// CORS
const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && origins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.vary('Origin');   // 追加而非 setHeader 覆盖 —— 与压缩中间件的 Accept-Encoding 共存
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 简易访问日志
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    console.log('[%s] %s %s %d %dms', new Date().toISOString(), req.method, req.url, res.statusCode, Date.now() - t0);
  });
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Gzip/Brotli 压缩（必须放在静态路由之前）
app.use(compressionMiddleware);

app.use('/api/crowd', crowdRouter);
app.use('/metrics', metricsRouter);

/* 静态托管：把前端单页地图和 assets 从同一来源提供（可选）。
   这样直接开 http://localhost:PORT 就是完整应用，/api/crowd 同源即可用。

   用 express.static 替掉原来 5 个逐行重复的 handler，并统一缓存策略：
   - ETag + Last-Modified（express.static 默认开）：内容没变回 304，
     139KB 的 app.js / 67KB 的 CSS 不必每次重复传输
   - 一律 max-age=0 + must-revalidate：文件名不带内容哈希，不能上 immutable，
     否则改了 app.js 浏览器也不会再来拿新版本
   注意 STATIC_DIR 就是项目根目录，所以前面必须挂白名单守卫 ——
   否则 /server/server.js、/node_modules/**、测试文件都会被当静态资源发出去。 */
const STATIC_DIR = path.resolve(__dirname, '..');
const HTML_FILE = 'index.html';
// 旧中文文件名入口保留为一枚重定向页（透传 hash/query，收藏的分享链接不丢）
const LEGACY_ENTRY = '武汉景点地图.html';
const PUBLIC_ASSETS = new Set([
  '/app.min.js', '/app.js',           // app.js 是源文件（测试用），保留直连兼容
  '/spots.data.js', '/spots.json',
  '/hubei.topo.json',                 // 行政边界数据（O2 本地化）
  '/style.min.css', '/sw.js', '/manifest.json',
]);
const PUBLIC_PAGES = new Set(['/', '/index.html', '/' + LEGACY_ENTRY]);

app.use(function publicOnly(req, res, next){
  const p = req.path.split('?')[0];
  if(!PUBLIC_ASSETS.has(p) && !PUBLIC_PAGES.has(p)){
    return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Not found' });
  }
  // 探针/冒烟脚本用 ?nocache 强制绕过缓存
  if(req.query.nocache != null) res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

// 入口单独路由一次：要给 HTML 挂 no-cache（express.static 的 setHeaders 也能做，
// 但显式路由把「入口必须每次回源」这个约束写在离白名单最近的地方）
app.get(['/', '/index.html'], function serveIndex(req, res, next){
  if(!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(path.join(STATIC_DIR, HTML_FILE), function(err){
    if(!err) return;
    if(err.code === 'ENOENT') return next();   // 文件不在，交给兜底 404
    next(err);
  });
});

app.use(express.static(STATIC_DIR, {
  index: false,                     // '/' 由 PUBLIC_PAGES 白名单放行后交给下面的显式处理
  etag: true,
  lastModified: true,
  maxAge: 0,
  dotfiles: 'ignore',
  setHeaders(res, filePath){
    if(res.getHeader('Cache-Control')) return;   // ?nocache 旁路已设好，不覆盖
    const base = path.basename(filePath);
    // HTML 与 sw.js 必须每次回源校验，否则前端更新和 Service Worker 更新都推不下去
    if(base.endsWith('.html') || base === 'sw.js') res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  },
}));

// 兜底 404
app.use((req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Not found' }));

// 统一错误处理：必须放在最后；优先识别 HttpError 子类
app.use((err, _req, res, next) => {
  if (err instanceof HttpError) {
    if (err.retryAfter != null) res.setHeader('Retry-After', String(err.retryAfter));
    return res.status(err.status).json({ ok: false, code: err.code, message: err.message });
  }
  // 兼容限流中间件塞进来的 { status, retryAfter } 形态
  if (err && err.status && err.code) {
    if (err.retryAfter != null) res.setHeader('Retry-After', String(err.retryAfter));
    return res.status(err.status).json({ ok: false, code: err.code, message: err.message || 'error' });
  }
  // 未知错误
  console.error('[error]', err.stack || err);
  res.status(500).json({ ok: false, code: 'INTERNAL', message: err.message });
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
let server;
server = app.listen(PORT, () => {
  const hasKey = !!(process.env.JIKE_API_KEY || '').trim();
  console.log('--- 武汉景点人流代理已启动 ---');
  console.log('监听：http://localhost:' + PORT);
  console.log('接口：');
  console.log('  GET /health');
  console.log('  GET /api/crowd?spots=黄鹤楼,东湖');
  console.log('  GET /api/crowd           （返回全部 50 个武汉景点）');
  console.log('  GET /api/crowd/stats');
  console.log('配置：');
  console.log('  JIKE_API_KEY     = ' + (hasKey ? '已配置（长度 ' + process.env.JIKE_API_KEY.length + '）' : '未配置（将使用 mock）'));
  console.log('  JIKE_API_BASE    = ' + (process.env.JIKE_API_BASE || 'https://data-api.isjike.com'));
  console.log('  JIKE_API_PATH    = ' + (process.env.JIKE_API_PATH || '/api/v1/heat_map'));
  console.log('  JIKE_HTTP_METHOD = ' + (process.env.JIKE_HTTP_METHOD || 'POST'));
  console.log('  CACHE_TTL        = ' + (process.env.CACHE_TTL_SECONDS || '300') + 's');
  console.log('  ALLOWED_ORIGINS  = ' + origins.join(','));
  if (!hasKey) {
    console.log('');
    console.log('⚠️  未配置 JIKE_API_KEY，已启用 mock 数据。请复制 .env.example 为 .env 并填入 key。');
  }
});

// 优雅停机：排空 in-flight 请求后退出
function gracefulShutdown(signal) {
  console.log('\n收到 ' + signal + '，正在停机…');
  // 清理限流定时器
  try {
    const { limiter } = require('./routes/crowd');
    if (limiter && limiter._sweepTimer) {
      clearInterval(limiter._sweepTimer);
    }
  } catch (_) { /* 忽略 */ }
  if (server) {
    server.close(() => {
      console.log('服务器已关闭');
      process.exit(0);
    });
    // 强制退出（最多等 30s）
    setTimeout(() => {
      console.error('强制退出（超时）');
      process.exit(1);
    }, 30_000);
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获的 async 错误上报 metric（不导致静默崩溃）
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
  try { require('./lib/metrics').inc('crowd_unhandled_rejections_total'); } catch (_) {}
});
