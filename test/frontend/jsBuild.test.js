import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 守卫：app.min.js 是**产物**，app.js 是真相源（tools/build-js.js 生成）。
// 这一条专门抓「改了 app.js 但忘了重建产物」—— 和 cssBuild.test.js 同一种阴招：
// 不报错、测试全绿，但浏览器加载的仍是旧代码，表现为「我明明改了却没变化」。
//
// `npm test` 会先跑 tools/build-js.js，所以走正常流程时必然通过；
// 防的是有人直接 `npx vitest run` 绕过构建。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SRC = path.join(ROOT, 'app.js');
const OUT = path.join(ROOT, 'app.min.js');
const HTML = path.join(ROOT, 'index.html');

describe('app.min.js 产物', () => {
  it('两个文件都存在', () => {
    expect(fs.existsSync(SRC), 'app.js 不见了').toBe(true);
    expect(fs.existsSync(OUT), 'app.min.js 不见了').toBe(true);
  });

  it('产物与源文件同步（改完 app.js 要跑 npm run build:js）', async () => {
    const { minify } = await import('../../tools/build-js.js');
    const expected = minify(fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, ''));
    const after = fs.readFileSync(OUT, 'utf8');
    expect(
      after,
      'app.min.js 与 app.js 不同步 —— 请跑 `npm run build:js`，否则浏览器加载的是旧代码',
    ).toBe(expected.code);
  });

  it('产物语法有效（压缩器最怕把代码压坏；token 流校验在 build 里，这里补语法门）', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    expect(() => new Function(min), 'app.min.js 编译失败').not.toThrow();
  });

  it('字符串与正则字面量未被误伤（URL 里的 // 不能当注释吃掉）', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    expect(min, '地图 SDK 地址被改坏').toContain("'https://map.qq.com/api/gljs?libraries=geometry,tools,service&v=1&key='");
    expect(min, 'esc() 的正则字面量被改坏').toContain("/[&<>\"']/g");
    expect(min, 'Key 配置行被改坏').toContain("var TMAP_KEY = 'KLDBZ");
    // 景点数据已挪到 spots.data.js（A3），中文哨兵换成常驻 UI 字符串
    expect(min, '中文 UI 字符串被改坏').toContain('本地动态估算');
  });

  it('产物是纯 LF、无 BOM，且以换行结尾', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    expect(min.charCodeAt(0), '产物不应带 BOM —— HTML 已声明 UTF-8').not.toBe(0xFEFF);
    expect(min, '产物不应含 CRLF').not.toMatch(/\r/);
    expect(min.endsWith('\n')).toBe(true);
  });

  it('HTML 加载的是产物而不是源文件', () => {
    const html = fs.readFileSync(HTML, 'utf8');
    expect(html, 'script 应引用 app.min.js').toMatch(/<script src="app\.min\.js" defer>/);
    expect(html, '不应再引用源文件 app.js').not.toMatch(/src="app\.js"/);
  });

  it('压缩确实带来了体积收益（否则压缩器白写）', () => {
    const gz = (p) => zlib.gzipSync(fs.readFileSync(p)).length;
    // 实测 raw 省 31%、gzip 省 41%；gzip 收益不应低于 30%
    expect(gz(OUT), '产物 gzip 不应大于源文件').toBeLessThan(gz(SRC));
    expect(gz(OUT), 'gzip 收益不足 30%，压缩器可能没生效').toBeLessThan(gz(SRC) * 0.7);
  });
});

describe('测试读的是源文件而不是产物', () => {
  it('没有测试还在读 app.min.js', () => {
    const dir = path.join(ROOT, 'test', 'frontend');
    const SELF = path.basename(fileURLToPath(import.meta.url));
    // 判定收紧为「同一行既有 readFileSync 又有产物字面量」（与 cssBuild.test.js 同步，
    // 原因见彼处注释：提及文件名的结构断言不是读产物）。
    const readsArtifact = (content, name) =>
      content.split('\n').some((l) => l.includes('readFileSync') && l.includes(`'${name}'`));
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.test.js'))
      .filter((f) => f !== SELF)
      .filter((f) => readsArtifact(fs.readFileSync(path.join(dir, f), 'utf8'), 'app.min.js'));
    expect(
      offenders,
      '这些测试读的是产物，改了源文件它们不会报警：' + offenders.join(', '),
    ).toEqual([]);
  });
});
