import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 守卫：spots.json 和 spots.data.js 都是**产物**，spots.src.json 是唯一真相源
// （tools/build-spots.js 生成）。防的是 A3 修掉的那种漂移：
// 两份手维护的数据静默分叉（曾漂移 85 处，武汉欢乐谷的 url 字段在 spots.json 丢失），
// 测试全绿但 HTTP 环境下弹窗少一个按钮。
//
// `npm test` 会先跑 tools/build-spots.js；这里防的是直接 `npx vitest run` 绕过构建。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SRC = path.join(ROOT, 'spots.src.json');
const OUT_JSON = path.join(ROOT, 'spots.json');
const OUT_JS = path.join(ROOT, 'spots.data.js');
const APP = path.join(ROOT, 'app.js');
const HTML = path.join(ROOT, 'index.html');

const read = (p) => fs.readFileSync(p, 'utf8');

describe('spots 产物', () => {
  it('三个文件都存在', () => {
    expect(fs.existsSync(SRC), 'spots.src.json 不见了').toBe(true);
    expect(fs.existsSync(OUT_JSON), 'spots.json 不见了').toBe(true);
    expect(fs.existsSync(OUT_JS), 'spots.data.js 不见了').toBe(true);
  });

  it('产物与源文件同步（改完 spots.src.json 要跑 npm run build:spots）', async () => {
    const { build } = await import('../../tools/build-spots.js');
    expect(() => build(), '源数据没通过校验').not.toThrow();
    const src = JSON.parse(read(SRC));
    expect(JSON.parse(read(OUT_JSON)), 'spots.json 与 spots.src.json 不同步')
      .toEqual(src);
    const jsBody = read(OUT_JS).slice(read(OUT_JS).indexOf('['), read(OUT_JS).lastIndexOf(']') + 1);
    expect(JSON.parse(jsBody), 'spots.data.js 与 spots.src.json 不同步').toEqual(src);
  });

  it('数据完整性（50 个、不重名、字段合法）', async () => {
    const { validate } = await import('../../tools/build-spots.js');
    const src = JSON.parse(read(SRC));
    expect(() => validate(src)).not.toThrow();
    expect(src.length, '景点数应为 50').toBe(50);
    expect(new Set(src.map((s) => s.name)).size).toBe(src.length);
  });

  it('zone 分区全覆盖且四个片区都非空（C2：三镇分区筛选的依据）', () => {
    const zones = new Set(['武昌', '汉口', '汉阳', '远郊']);
    const counts = {};
    for (const s of JSON.parse(read(SRC))) {
      expect(zones, `${s.name} 的 zone 非法：${s.zone}`).toContain(s.zone);
      counts[s.zone] = (counts[s.zone] || 0) + 1;
    }
    for (const z of zones) expect(counts[z], `${z} 片区为空，筛选 chip 会空转`).toBeGreaterThan(0);
  });

  it('回归哨兵：武汉欢乐谷的 url 在两份产物里都在（A3 修的就是它丢在 spots.json）', () => {
    const url = 'https://www.happyvalley.com.cn/';
    expect(JSON.parse(read(OUT_JSON)).find((s) => s.name === '武汉欢乐谷')?.url).toBe(url);
    const jsBody = JSON.parse(read(OUT_JS).slice(read(OUT_JS).indexOf('['), read(OUT_JS).lastIndexOf(']') + 1));
    expect(jsBody.find((s) => s.name === '武汉欢乐谷')?.url).toBe(url);
  });

  it('app.js 不再内嵌景点数据（防止数据双源悄悄长回来）', () => {
    expect(read(APP), 'app.js 里出现了内嵌 SPOTS 数组 —— 数据只应住在 spots.src.json')
      .not.toMatch(/var SPOTS\s*=\s*\[/);
  });

  it('HTML 里 spots.data.js 在 app.min.js 之前加载（defer 按序执行，SPOTS 先就位）', () => {
    const html = read(HTML);
    const iData = html.indexOf('spots.data.js');
    const iApp = html.indexOf('app.min.js');
    expect(iData, 'HTML 应引用 spots.data.js').toBeGreaterThan(0);
    expect(iApp, 'HTML 应引用 app.min.js').toBeGreaterThan(0);
    expect(iData, 'spots.data.js 必须排在 app.min.js 之前').toBeLessThan(iApp);
  });
});
