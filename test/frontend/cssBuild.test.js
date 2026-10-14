import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 守卫：style.min.css 是**产物**，style.src.css 是真相源。
// 这一条专门抓「改了源文件但忘了重建产物」——
// 那是最阴的一种 bug：不报错、测试全绿，但浏览器加载的仍是旧样式，
// 表现为「我明明改了却没变化」，极难定位。
//
// `npm test` 会先跑 tools/build-css.js，所以走正常流程时这条必然通过；
// 它防的是有人直接 `npx vitest run` 绕过构建。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const SRC = path.join(ROOT, 'style.src.css');
const OUT = path.join(ROOT, 'style.min.css');

describe('style.min.css 产物', () => {
  it('两个文件都存在', () => {
    expect(fs.existsSync(SRC), 'style.src.css 不见了').toBe(true);
    expect(fs.existsSync(OUT), 'style.min.css 不见了').toBe(true);
  });

  it('产物与源文件同步（改完 style.src.css 要跑 npm run build:css）', async () => {
    const { build } = await import('../../tools/build-css.js');
    const expected = build();            // 重新生成
    const after = fs.readFileSync(OUT, 'utf8');
    const { minify } = await import('../../tools/build-css.js');
    const fromSrc = minify(fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, ''));
    expect(
      after,
      'style.min.css 与 style.src.css 不同步 —— 请跑 `npm run build:css`，否则浏览器加载的是旧样式',
    ).toBe(fromSrc);
    expect(expected.open).toBe(expected.close);
  });

  it('产物里一条注释都不剩（注释占原始体积 31%，gzip 压不动中文散文）', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    expect(min).not.toMatch(/\/\*/);
    expect(min).not.toMatch(/<!--/);
  });

  it('产物是纯 LF、无 BOM，且以换行结尾', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    expect(min.charCodeAt(0), '产物不应带 BOM —— HTML 已声明 UTF-8').not.toBe(0xFEFF);
    expect(min, '产物不应含 CRLF').not.toMatch(/\r/);
    expect(min.endsWith('\n')).toBe(true);
  });

  it('产物括号配平（压缩器最怕把规则压坏）', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    const open = (min.match(/{/g) || []).length;
    const close = (min.match(/}/g) || []).length;
    expect(open, `产物少了 ${open - close} 个 }`).toBe(close);
  });

  it('压缩没有误伤字符串字面量（字体名被改坏 = 整页字体静默回退）', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    // 源文件里唯一带空格的双引号字面量。压缩器早先是「状态机先保护字面量、
    // 再对整体跑一遍正则」，等于白保护 —— 这里刚好只有一个空格所以看不出问题，
    // 但只要出现 "a  b" 或 'x : y' 就会被静默改坏。
    expect(min, 'font-family 字面量里的空格被吃掉了').toMatch(/font-family:"Microsoft YaHei"/);
    expect(min, 'font-feature-settings 字面量被改坏了').toMatch(/font-feature-settings:"tnum"/);
  });

  it('保留了 @media 断点', () => {
    const min = fs.readFileSync(OUT, 'utf8');
    expect(min).toMatch(/@media\s*\(max-width:820px\)/);
    expect(min).toMatch(/@media\s*\(min-width:604px\)/);
  });

  it('压缩确实带来了体积收益（否则压缩器白写）', () => {
    const zlib = require('node:zlib');
    const gz = (p) => zlib.gzipSync(fs.readFileSync(p)).length;
    expect(gz(OUT), '产物 gzip 不应大于源文件').toBeLessThan(gz(SRC));
    // 实测省 58%；留出余量但不放松到「基本没省」
    expect(gz(OUT), '压缩收益不足 30%，压缩器可能没生效').toBeLessThan(gz(SRC) * 0.7);
  });
});

describe('测试读的是源文件而不是产物', () => {
  it('没有测试还在读 style.min.css', () => {
    const dir = path.join(ROOT, 'test', 'frontend');
    const SELF = path.basename(fileURLToPath(import.meta.url));
    // 判定收紧为「同一行既有 readFileSync 又有产物字面量」：只抓真的把产物当数据读的测试。
    // 仅在断言里提及文件名的结构测试（如 swCache.test.js 校验 sw.js 是否预缓存
    // style.min.css）不该被算进去 —— 第一版按「文件名字符串出现」判，全误报。
    const readsArtifact = (content, name) =>
      content.split('\n').some((l) => l.includes('readFileSync') && l.includes(`'${name}'`));
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.test.js'))
      .filter((f) => f !== SELF)
      .filter((f) => readsArtifact(fs.readFileSync(path.join(dir, f), 'utf8'), 'style.min.css'));
    expect(
      offenders,
      '这些测试读的是产物，改了源文件它们不会报警：' + offenders.join(', '),
    ).toEqual([]);
  });
});