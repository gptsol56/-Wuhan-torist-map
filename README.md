# 武汉景点地图

零构建的单页 Web 应用 + 可选的人流代理后端：在腾讯地图上呈现武汉 50 个精选景点，提供近 10 天人流参考、预约/购票信息、多方式路线规划，并可作为 PWA 离线使用。

## 功能特性

**地图与景点**
- 腾讯地图 GL（3D 可俯仰），50 个景点标记 + 缩放聚合 + 标签防碰撞
- 景点弹窗：开放时间 / 建议游玩时长 / 地铁交通 / 门票 / 预约要求 / 人流等级 / 游玩贴士
- 人流热力图层（近 10 天历史热力栅格）、人流着色、聚合气泡按人流分级
- 实时路况、行政区划边界、测距工具、卫星底图

**筛选与行程**
- 筛选：三镇分区（武昌 / 汉口 / 汉阳 / 远郊）× 地铁线路（自动从交通文本提取）× 人流 × 预约类型，任意组合
- 路线规划：驾车 / 步行 / 骑行 / 公交，支持多途经点，结果带多方案卡片与逐步提示
- 精选行程一键导入：经典一日游、博物馆之旅、东湖环线、亲子半日、汉口老城漫步、木兰远郊线
- 分享链接：当前筛选 + 行程编码进 URL hash，打开即还原（`#z=汉阳&ml=6&wp=黄鹤楼→汉口江滩&mode=transit`）

**PWA / 离线**
- Service Worker 分级缓存：入口页与静态资源预缓存，断网刷新仍可完整使用
- 预缓存地址以注册 scope 为基准解析，部署在域名根路径或任意子路径（如 GitHub Pages 项目页）均可正常安装

**外观**
- 日间 / 夜间 / 紫晶三套主题，列表 / 地图 / 面板全面适配

## 快速开始

三种方式，按需选择：

**① 直接打开（file://）** —— 双击 `武汉景点地图.html` 即可运行，使用内嵌景点数据兜底（无后端人流，按本地时间估算）。

**② 任意静态服务器（推荐）** —— 与后端同机部署时可用真实人流数据：

```bash
python -m http.server 8000
# 打开 http://127.0.0.1:8000/武汉景点地图.html
```

**③ 连同人流代理一起跑（完整体验）**：

```bash
cd server
cp .env.example .env        # 填入 JIKE_API_KEY（不填则自动使用 mock 数据）
npm install
npm start                   # 监听 :3000，前端与 /api/crowd 同源
```

## 项目结构与构建管线

应用本体**零构建**：不装任何依赖也能直接打开跑起来。三份「产物」进仓库，各有唯一的真相源，由 `tools/` 下的脚本生成：

| 真相源（改这里） | 产物（浏览器加载） | 生成命令 |
|---|---|---|
| `spots.src.json` | `spots.json` + `spots.data.js` | `npm run build:spots` |
| `app.js` | `app.min.js` | `npm run build:js` |
| `style.src.css` | `style.min.css` | `npm run build:css` |

`npm test` 会先依次跑完三个构建再执行测试；产物与源文件不同步会被测试当场拦下（不会静默用旧代码）。

```
武汉景点地图.html    # 入口页（PWA）
app.js / style.src.css / spots.src.json    # 三份真相源
server/              # 人流代理后端（Express，可选）
test/frontend/       # 前端单测（vitest + jsdom，抽取真实源码执行）
tools/               # 三个零依赖构建脚本
```

## 数据维护

- **改景点数据**：编辑 `spots.src.json`（字段含 `zone` 分区、`metro` 交通文本、`reserve` 预约类型等），跑 `npm run build:spots`
- **改行程预设**：编辑 `app.js` 里的 `ITINERARIES`（站名必须与 spots.src.json 逐字一致，测试会校验）
- **改样式**：只改 `style.src.css`，`style.min.css` 是产物

## 测试

```bash
npm test              # 前端：3 个构建 + 350 个用例
npm run test:server   # 后端：149 个用例
```

前端测试的思路是「抽真实源码执行」——直接从 app.js 文本中截取被测函数在桩件作用域里运行，避免测试和实现各写一份造成漂移。

## 部署

- **纯前端**：把仓库根目录的文件丢到任意静态托管即可（GitHub Pages / Vercel / Nginx），根路径与子路径都支持
- **带后端**：`server/` 提供 Dockerfile 与 docker-compose.yml；后端仅暴露白名单内的静态资源，`/api/crowd` 供前端同源调用，`/metrics` 输出 Prometheus 指标
- 后端内置：5 分钟 TTL + LRU + 请求合并缓存、每 IP 限流、上游熔断、配额耗尽时 last-good 快照兜底

## 配置与安全

- **前端地图 Key（`TMAP_KEY`，app.js 顶部）**：以前端明文形式使用，这是 JSAPI 的固有限制。请务必到[腾讯位置服务控制台](https://lbs.qq.com/)为该 Key 配置**域名白名单**，否则任何拿到源码的人都能消耗你的配额
- **后端 Key（`server/.env`）**：及客智能热力 API 的 key 只存在服务端，已被 `.gitignore` 排除；克隆后从 `.env.example` 复制填写
- 后端未配置 key 时自动降级为 mock 数据（按景点名哈希出稳定热度），UI 会如实标注「本地 mock」
