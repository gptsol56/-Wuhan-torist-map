import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 守卫：sw.js 的 A1/A2 修复不被回归。
// 没有真正的 SW 运行时环境，这里做的是结构级断言 —— 每一条都对应一个真实故障：
//   - 根绝对路径预缓存（A2）：部署到子路径时 addAll 404 → SW 安装失败 → PWA 全死
//   - 入口页不预缓存 / navigate 不走 HTML 分支（A1）：断网刷新只能看到「离线模式」错误页
// 断网/子路径的真实行为在浏览器里人工验证过（见 sw.js 注释），这里防手滑改回去。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

describe('sw.js 缓存策略', () => {
  it('预缓存地址以 scope 为基准解析（A2：子路径部署不能 404）', async () => {
    // 剥掉注释再断言：sw.js 的注释里引用旧写法 '/style.min.css' 作说明，是合法的
    const { stripComments } = await import('../../tools/build-js.js');
    const code = stripComments(SW).code;
    expect(code).toContain('new URL(p, SCOPE).href');
    expect(code).toContain('self.registration.scope');
    // 根绝对路径的资产字面量一个都不该再出现
    expect(code, '预缓存/资产清单里出现了根绝对路径').not.toMatch(/'\/(style|app|spots|manifest|index)/);
  });

  it('预缓存清单包含全部关键资源（A1：断网也有完整应用外壳）', () => {
    for (const f of ['style.min.css', 'app.min.js', 'spots.data.js', 'manifest.json',
      'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
      'hubei.topo.json']) {
      expect(SW, `应预缓存 ${f}`).toContain(`scoped('${f}')`);
    }
    expect(SW, '应预缓存入口 HTML').toMatch(/ENTRY_HTML = scoped\('/);
    expect(SW, 'install 里应写入入口 HTML').toMatch(/addAll\(\[\s*ENTRY_HTML\s*\]\)/);
  });

  it('HTML 分支按 navigate 模式判定（A1：中文文件名入口页也要走 network-first）', () => {
    expect(SW).toContain("e.request.mode === 'navigate'");
    // 离线兜底必须能落到预缓存的入口 HTML（覆盖 Express 部署下入口是 scope 根的情况）
    expect(SW).toContain('c.match(ENTRY_HTML)');
  });

  it('VERSION 是数字（每次改前端文件要 +1，activate 靠它清旧缓存）', () => {
    expect(SW).toMatch(/var VERSION = \d+/);
  });

  it('地图 SDK 走 SWR 缓存（O1）：1.6MB 的 SDK 不该让回头客每次重下', () => {
    expect(SW).toContain("var SDK_CACHE = 'wuhan-map-sdk'");          // 不随 VERSION 走：发版不重下 SDK
    expect(SW).toContain('mapapi.qq.com');                              // SDK 大包命中缓存分支
    expect(SW, 'SDK 分支须在 external 网络only 分支之前').toMatch(/mapapi\.qq\.com[\s\S]*?if\(isExternalAPI/);
    expect(SW, 'activate 清理须放行 SDK_CACHE').toMatch(/k !== RUNTIME_CACHE && k !== SDK_CACHE/);
  });
});
