// 及客智能热力图 API 客户端
// POST https://data-api.isjike.com/api/v1/heat_map
// 输入：{ fence: [[lng,lat],...] } 或 { circle: { center_point:[lng,lat], radius:meters } }
// 输出：{ data: { items: [{ cell_token, cell_center, cell_heat, time_range: [{date, heat:[24h]}] }] } }

const https = require('https');
const { AuthError, QuotaError, RateLimitError, TransientError, UpstreamBadDataError } = require('./errors');

function parseRetryAfter(v) {
  if (!v) return null;
  const n = parseInt(v, 10);
  if (!Number.isNaN(n) && n >= 0 && String(n) === String(v).trim()) return n;
  const t = Date.parse(String(v).trim());
  if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return null;
}

class JikeClient {
  constructor({ apiKey, base, path, method = 'POST', timeoutMs = 15000 }) {
    if (!apiKey) throw new Error('JIKE_API_KEY 未配置');
    this.apiKey = apiKey;
    this.base = (base || 'https://data-api.isjike.com').replace(/\/+$/, '');
    this.path = path.startsWith('/') ? path : '/' + path;
    this.method = method.toUpperCase();
    this.timeoutMs = timeoutMs;
  }

  // 查询指定坐标区域的热力数据
  // params: { type: 'circle'|'fence', center?: [lng,lat], radius?: number, fence?: [lng,lat][] }
  // 返回原始响应对象（{ response_id, code, biz_code, data: { items: [...] } }）
  async queryHeatMap(params) {
    const url = new URL(this.base + this.path);

    const body = JSON.stringify(params);
    const opts = {
      method: this.method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'wuhan-crowd-proxy/1.0',
      }
    };

    return new Promise((resolve, reject) => {
      const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB 上限，防异常大响应无限累加撑爆内存
      const req = https.request(url, opts, (res) => {
        let data = '';
        let received = 0;
        res.on('data', c => {
          received += c.length;
          if (received > MAX_RESPONSE_BYTES) { req.destroy(new Error('__oversize__')); return; }
          data += c;
        });
        res.on('end', () => {
          const status = res.statusCode;
          if (status === 401) {
            return reject(new AuthError('及客智能鉴权失败 HTTP 401'));
          }
          if (status === 403) {
            // 403 可能是配额耗尽（"API调用次数已用完或套餐已过期"），也可能是无权限/密钥失效。
            // 读 body 文本区分，让上层能走「快照兜底」而不是把配额耗尽误报成 401。
            const body = data.slice(0, 500);
            if (/调用次数已用完|套餐已过期|余额不足|quota|exhausted/i.test(body)) {
              return reject(new QuotaError('及客智能配额已用完或套餐已过期'));
            }
            return reject(new AuthError('及客智能鉴权失败 HTTP 403'));
          }
          if (status === 429) {
            const ra = parseRetryAfter(res.headers['retry-after']) || 60;
            return reject(new RateLimitError(ra));
          }
          if (status >= 500) {
            return reject(new TransientError('及客智能 HTTP ' + status, 8));
          }
          if (status >= 400) {
            return reject(new UpstreamBadDataError('及客智能 HTTP ' + status + ': ' + data.slice(0, 300)));
          }
          if (status < 200 || status >= 300) {
            return reject(new TransientError('及客智能 HTTP ' + status, 8));
          }
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new UpstreamBadDataError('及客智能返回非 JSON: ' + data.slice(0, 200)));
          }
        });
      });
      req.on('error', (err) => {
        const isTimeout = err && err.message === '__timeout__';
        const isOversize = err && err.message === '__oversize__';
        reject(new TransientError(
          isTimeout ? '及客智能请求超时（>' + this.timeoutMs + 'ms）'
          : isOversize ? '及客智能响应过大（>' + MAX_RESPONSE_BYTES + ' bytes）'
          : '及客智能网络错误: ' + err.message,
          8
        ));
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('__timeout__')));
      req.write(body);
      req.end();
    });
  }
}

module.exports = JikeClient;
