# 武汉景点人流代理

把「及客智能」热力图 API 的 key 保护在后端，前端只看到 `/api/crowd`。

## 接口说明

**及客智能热力图 API**（`/api/v1/heat_map`，POST）：
- 输入：圆形或多边形围栏（WGS84 坐标）
- 输出：历史 10 天 S2 栅格热力数据（过去 14 天至前 3 天的滑动窗口，**不含当天实时数据**）
- 字段：`cell_heat`（10 天热力总和）、`time_range`（每日 24 小时数组）
- 本代理按景点坐标发圆形围栏查询，返回人流等级 `{低,中,高}` 和高峰时段

## 文件
- `server.js` — Express 入口
- `routes/crowd.js` — `/api/crowd` 路由（发圆形围栏 + 坐标转换）
- `lib/jikeClient.js` — 及客智能 HTTP 客户端
- `lib/normalize.js` — 把热力栅格映射成 `{name,crowd,peak}`
- `lib/cache.js` — 5 分钟 TTL + LRU + in-flight 请求合并
- `lib/metrics.js` — Prometheus 指标
- `lib/errors.js` — 错误类型（AuthError / TransientError / RateLimitError / …）
- `lib/rateLimit.js` — 每个 IP 60 req/min 限流

## 启动
```bash
cd server
# .env 已填好 key，确认 CELL_LEVEL / HEAT_RADIUS_METERS 合适
npm install
npm start     # 监听 :3000
```

未配置 `JIKE_API_KEY` 时自动用 mock 数据（按景点名 hash 出稳定热度），UI 显示「本地 mock」。

## 接口
| 路由 | 说明 |
|---|---|
| `GET /health` | 健康检查 |
| `GET /api/crowd?spots=黄鹤楼,东湖,户部巷` | 查询指定景点（URL-encode UTF-8） |
| `GET /api/crowd` | 不传 spots 时返回全部 50 个武汉景点 |
| `GET /api/crowd/stats` | 缓存统计（含 cell_level / radius 配置） |
| `GET /metrics` | Prometheus 指标（Prometheus text format） |

返回结构（前端直接消费）：
```json
{
  "ok": true,
  "source": "jikeai" | "mock",
  "cached": 2,
  "total": 3,
  "spots": [
    { "name": "黄鹤楼", "crowd": "高", "peak": "2025-04-16 14:00" }
  ],
  "ts": 1700000000000,
  "costMs": 12
}
```

## 配置参数（`.env`）
| 变量 | 默认值 | 说明 |
|---|---|---|
| `CELL_LEVEL` | `14` | S2 Cell 等级（10~18，越高栅格越细） |
| `HEAT_RADIUS_METERS` | `500` | 圆形围栏半径（米） |

## 调通步骤
1. 确认 `data-api.isjike.com` 网络可达：`curl https://data-api.isjike.com/api/v1/heat_map`
2. 确认 `JIKE_API_KEY` 有效（HTTP 401/403 → key 问题）
3. 确认坐标正确（武汉景点用 GCJ-02 坐标，`spots.json` 中的 `lng/lat` 已是 GCJ-02，代理内自动转换）
4. 热力阈值（`lib/normalize.js` 的 `HEAT_THRESHOLDS`）：按实际返回量级调参

## 安全
- `.env` 在 `.gitignore`，不会被提交
- 代码无硬编码 key
- Bearer Token 在后端发出，前端只看到 `/api/crowd`
- CORS 白名单，生产请限制 `ALLOWED_ORIGINS`

## Docker
```bash
docker build -t wuhan-crowd-proxy .
docker run --rm -p 3000:3000 --env-file .env wuhan-crowd-proxy
docker compose up -d
docker compose logs -f
```

## 部署
任意 Node 18+ 环境：`server.js` 监听 `process.env.PORT`。

## 前端已对接
`武汉景点地图.html` 的 `LIVE_DATA_URL` 已改为 `/api/crowd`。
`fetchLiveData()` 解析 `{ok, spots, source}`，状态栏显示「及客智能 / 本地 mock」。
