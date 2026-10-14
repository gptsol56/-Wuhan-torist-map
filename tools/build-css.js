// 生成 style.min.css（浏览器真正加载的那个文件）
//
// 背景：`style.min.css` 这个名字一直在骗人 —— 它 88 KB、注释占 31.2%，
// gzip 后 26,636 字节；光把注释去掉就掉到 11,655 字节（省 56%）。
// gzip 压代码压得好，压不动中文散文，所以注释在这个文件里格外贵。
//
// 做法：带注释的 style.src.css 是唯一真相源（改样式改它），
// 本脚本生成 style.min.css 给浏览器。两者都进仓库，
// 因为项目是零构建的：不装任何东西也能直接打开跑起来。
//
// 保护措施：
//   1. `npm test` 会先跑本脚本，测试永远校验的是「刚生成的」产物；
//   2. test/frontend/cssBuild.test.js 单独检查产物是否与源同步，
//      万一有人直接跑 `npx vitest run` 而忘了重建，会立刻失败而不是静默用旧样式。
//
// 刻意不引入 clean-css/lightningcss 之类的依赖：为了省 376 字节（去注释之外的
// 那部分空白压缩只多省这么多）引入一个构建依赖不划算，而且它们的输出不稳定、
// 出问题时很难定位。这里是 30 行、输出确定、零依赖。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'style.src.css');
const OUT = path.join(ROOT, 'style.min.css');

function minify(css) {
  // 1. 去注释 + 2. 压空白 + 3. 删结构符两侧空格 —— 三件事在**同一个状态机**里做完。
  //
  //    为什么必须放在一起：早先拆成「状态机先拷贝出字符串字面量，再对整体跑一遍
  //    .replace(/\s+/g,' ')」—— 那等于白保护了，最后那遍正则照样扫进字面量里。
  //    本文件里唯一带空格的字面量是 font-family:"Microsoft YaHei"，
  //    恰好只有一个空格，\s+→' ' 之后看不出问题，所以第一版输出是对的；
  //    但只要将来出现 "a  b"（两个空格）或者 'x : y'（冒号两侧有空格），
  //    就会被静默改坏，而字体名改坏的后果是整页字体回退，肉眼很难立刻归因。
  //    所以：进入字面量就整段原样输出，后面一个字符都不再处理它。
  const STRUCT = '{}:;,>~+';

  let out = '';
  let pendingSpace = false;   // 攒着一个待定的空白，等到确认不在字面量里才吐出来

  const flushSpace = () => {
    if (pendingSpace) { out += ' '; pendingSpace = false; }
  };

  let i = 0;
  while (i < css.length) {
    const c = css[i];

    // --- 注释：整段丢弃 ---
    if (c === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) i++;
      i += 2;
      pendingSpace = true;              // 注释顶掉后，两侧仍可能需要一个分隔空格
      continue;
    }

    // --- 字符串字面量：整段原样输出，一个字节都不动 ---
    if (c === '"' || c === "'") {
      flushSpace();
      const quote = c;
      out += c;
      i++;
      while (i < css.length) {
        if (css[i] === '\\') { out += css[i] + (css[i + 1] || ''); i += 2; continue; }
        out += css[i];
        if (css[i] === quote) { i++; break; }
        i++;
      }
      pendingSpace = false;             // 字面量后面紧跟结构符时不需要空格
      continue;
    }

    // --- 空白：折叠成一个待定空格 ---
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      pendingSpace = true;
      i++;
      continue;
    }

    // --- 结构符：两侧空格一律不要 ---
    if (STRUCT.indexOf(c) !== -1) {
      pendingSpace = false;
      out += c;
      i++;
      continue;
    }

    flushSpace();
    out += c;
    i++;
  }

  // 收尾：去掉最后一个 } 前面残留的分号（最后一条声明不需要分号）
  return out.replace(/;}/g, '}').trim() + '\n';
}

function build() {
  const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');   // 源文件带 BOM，这里剥掉
  const min = minify(raw);

  // 产物自检：压缩器最怕的是把规则压坏。括号配平是最低限度的检查。
  const open = (min.match(/{/g) || []).length;
  const close = (min.match(/}/g) || []).length;
  if (open !== close) {
    throw new Error(`压缩后括号不配平：{ ${open} 个，} ${close} 个。源文件可能有问题。`);
  }
  if (!min.includes('@media')) {
    throw new Error('压缩后找不到 @media —— 压缩器可能把规则压坏了。');
  }

  fs.writeFileSync(OUT, min, 'utf8');   // 纯 LF、无 BOM：HTML 已声明 UTF-8
  return { bytes: Buffer.byteLength(min, 'utf8'), open, close };
}

if (require.main === module) {
  const r = build();
  const before = fs.statSync(OUT).size;
  console.log(`[build-css] style.min.css  ${(r.bytes / 1024).toFixed(1)} KB（写入后 ${(before / 1024).toFixed(1)} KB），括号 ${r.open}/${r.close}`);
}

module.exports = { build, minify, SRC, OUT };