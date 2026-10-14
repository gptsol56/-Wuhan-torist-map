// 生成 app.min.js（浏览器真正加载的那个文件）
//
// 与 tools/build-css.js 同一套哲学：
//   - 带注释的 app.js 是唯一真相源（改代码改它），本脚本生成产物给浏览器；
//   - 两者都进仓库，项目保持零构建 —— 不装任何东西也能直接打开跑起来；
//   - `npm test` 会先跑本脚本；test/frontend/jsBuild.test.js 单独校验产物同步，
//     防止有人直接 `npx vitest run` 绕过构建、静默用旧代码。
//
// 压缩只做三件事：去注释、压空白、按「证明安全」的规则并行。**不做**标识符重命名、
// 不做死代码消除 —— 那需要完整的词法/作用域分析，手写状态机做不到可靠，
// 引 terser/esbuild 又违背零依赖。现状（注释占原始体积 ~15% + 缩进 ~5%）
// 只靠删注释和空白就能省下可观的一块，风险收益比最好。
//
// 三条安全底线：
//   1. 换行是 ASI（自动分号插入）的一部分。只在「该行结尾字符不可能是语句结尾」
//      时才并到下一行（分号/逗号/左括号/二元运算符等）——一条合法的 ECMAScript
//      语句不可能以这些字符结尾，所以并行的行定义上就是续行，删掉换行不改变语义。
//      相反，标识符 / 数字 / ) / ] / " 结尾的行一律保留换行。
//   2. 字符串与正则字面量整段原样输出（状态机进入后一个字节都不碰）。
//      'https://…' 里的 // 不能当注释吃掉，/[&<>"']/g 里的引号也不能当字符串边界。
//      正则 vs 除法用「上一个有效字符」判定：跟在 ( , = : ; 等后面是正则，
//      跟在标识符/数字/)/] 后面是除法（app.js 里的除法全是 w/2、clientWidth/2 这种）。
//   3. 含换行的块注释按规范（ECMA-262 §11.3）等价于一个换行符 —— 替换成 \n 而不是
//      空格，保住它可能承担的 ASI 作用（虽然本仓库没这么写过，防患于未然）。
//
// 产物自检（build() 内，比 CSS 的括号配平更强）：
//   a. 用同一个分词器分别收集「源文件」和「产物」的 token 流（标识符/标点/字符串/
//      正则，不含空白与注释），要求逐项相等 —— 并行规则吃掉/多出任何 token 都会炸；
//   b. new Function(产物) 编译一遍 —— 语法坏了立刻知道，不会等到浏览器白屏。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'app.js');
const OUT = path.join(ROOT, 'app.min.js');

// 「/ 前面是这些字符」→ 正则字面量。集合外的（标识符/数字/)/]/字符串结尾）→ 除法。
const REGEX_OK_AFTER = new Set('([,=:!&|?;{}+-*%^~<>');
// 这些关键字后面直接跟 / 也按正则处理（本仓库目前没有这种写法，纯防御）。
const REGEX_OK_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

// 去注释 + 压空白（保留换行结构）。同时收集 token 流用于产物自检。
function stripComments(src) {
  let out = '';
  let pendingSpace = false;
  let lastCh = '';        // 上一个输出的非空白字符（正则/除法判定用）
  let word = '';          // 当前连续的标识符字符（关键字判定用）
  const tokens = [];
  let tok = '';           // 标识符/数字在积累，标点单发

  const flushTok = () => { if (tok) { tokens.push(tok); tok = ''; } };

  // 发射一个「代码」字符：先补上攒着的空格，再维护 lastCh / word
  function emit(ch) {
    if (pendingSpace) { out += ' '; pendingSpace = false; }
    out += ch;
    lastCh = ch;
    if (/[A-Za-z0-9_$]/.test(ch)) word += ch; else word = '';
  }

  // 发射一个完整的字面量（字符串/正则）
  function emitLit(lit) {
    if (pendingSpace) { out += ' '; pendingSpace = false; }
    out += lit;
    lastCh = lit[lit.length - 1];
    word = '';
  }

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    // --- 行注释：整段丢弃，\n 留给下一轮循环原样输出（ASI！） ---
    if (c === '/' && src[i + 1] === '/') {
      flushTok();
      while (i < src.length && src[i] !== '\n') i++;
      pendingSpace = true;   // 注释两侧仍可能需要一个分隔（如 a /*c*/ b 同行的行注释版）
      continue;
    }

    // --- 块注释：含换行的按规范折算成 \n（见文件头底线 3），否则占一个空格 ---
    if (c === '/' && src[i + 1] === '*') {
      flushTok();
      let hasNl = false;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') hasNl = true;
        i++;
      }
      i += 2;
      if (hasNl) { out += '\n'; pendingSpace = false; }
      else pendingSpace = true;
      continue;
    }

    // --- 字符串字面量（含反引号；本仓库无模板字符串，${} 嵌套不在支持范围）---
    if (c === '"' || c === "'" || c === '`') {
      flushTok();
      const q = c;
      let lit = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { lit += src[i] + (src[i + 1] || ''); i += 2; continue; }
        lit += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      emitLit(lit);
      tokens.push(lit);
      continue;
    }

    // --- 斜杠：正则字面量 or 除法 ---
    if (c === '/') {
      const isRegex = (word && REGEX_OK_KEYWORDS.has(word)) || REGEX_OK_AFTER.has(lastCh) || lastCh === '';
      if (isRegex) {
        // 正则整段原样输出；字符类 [...] 里的 '/' 不终止字面量
        let lit = '/';
        i++;
        let inClass = false;
        while (i < src.length) {
          if (src[i] === '\\') { lit += src[i] + (src[i + 1] || ''); i += 2; continue; }
          const r = src[i];
          if (r === '\n') break;   // 裸换行不可能在合法正则里 —— 走到这说明判定错了，让自检去抓
          if (r === '[') inClass = true;
          else if (r === ']') inClass = false;
          else if (r === '/' && !inClass) { lit += '/'; i++; break; }
          lit += r;
          i++;
        }
        while (i < src.length && /[a-z]/i.test(src[i])) { lit += src[i]; i++; }   // flags
        emitLit(lit);
        tokens.push(lit);
      } else {
        flushTok();
        tokens.push('/');
        emit('/');
        i++;
      }
      continue;
    }

    // --- 换行：原样输出（ASI 语义），不参与空白折叠 ---
    if (c === '\n') {
      flushTok();
      pendingSpace = false;   // 行首不留前导空格（收尾 trim 也会兜一遍）
      out += '\n';
      lastCh = '';            // 换行后重置：语句边界，斜杠只可能是正则
      word = '';
      i++;
      continue;
    }

    // --- 其他空白（空格/制表符/\r/\f）：折叠成一个待定空格 ---
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      flushTok();
      pendingSpace = true;
      i++;
      continue;
    }

    // --- 普通字符：标识符/数字积累成词，标点单发 ---
    if (/[A-Za-z0-9_$]/.test(c)) {
      tok += c;
      emit(c);
    } else {
      flushTok();
      tokens.push(c);
      emit(c);
    }
    i++;
  }
  flushTok();
  return { code: out, tokens };
}

// 行尾是这些字符时，该行「定义上就是续行」，可与下一行合并（见文件头底线 1）。
const SAFE_LINE_END = new Set([
  ';', ',', '{', '(', '[', '?', ':',
  '=', '+', '-', '*', '%', '&', '|', '^', '<', '>', '!', '~',
]);

// 并行：只删「证明安全」的换行。返回以 \n 结尾的最终产物。
function joinLines(code) {
  const lines = code.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '\n';
  let res = lines[0];
  for (let k = 1; k < lines.length; k++) {
    const prev = lines[k - 1];
    const cur = lines[k];
    const endsSafe = SAFE_LINE_END.has(prev[prev.length - 1]);
    // 下一行以 . ) ] 开头也安全：`.b` 单独不成句（必是成员访问续行）；
    // 括号内的换行无 ASI，删掉不改变解析。
    const startsContinuation = cur[0] === '.' || cur[0] === ')' || cur[0] === ']';
    if (endsSafe) res += ' ' + cur;
    else if (startsContinuation) res += cur;
    else res += '\n' + cur;
  }
  return res + '\n';
}

function minify(src) {
  const pass1 = stripComments(src);
  const code = joinLines(pass1.code);
  // 产物自检 a：token 流逐项相等（同一分词器、两种上下文跑出的序列必须一致）
  const pass2 = stripComments(code);
  if (JSON.stringify(pass1.tokens) !== JSON.stringify(pass2.tokens)) {
    const a = pass1.tokens, b = pass2.tokens;
    let d = 0;
    while (d < Math.min(a.length, b.length) && a[d] === b[d]) d++;
    throw new Error(
      `token 流在第 ${d} 项分叉：源=${JSON.stringify(a[d])} 产物=${JSON.stringify(b[d])}。` +
      '并行/去注释规则改坏了代码，禁止写出产物。'
    );
  }
  return { code, tokens: pass1.tokens };
}

function build() {
  const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');   // 源文件带 BOM 则剥掉
  const { code } = minify(raw);

  // 产物自检 b：语法门 —— 编译一遍（不执行），坏了立刻失败
  try { new Function(code); }
  catch (e) { throw new Error(`app.min.js 语法检查失败：${e.message}`); }

  fs.writeFileSync(OUT, code, 'utf8');   // 纯 LF、无 BOM：HTML 已声明 UTF-8
  return { bytes: Buffer.byteLength(code, 'utf8') };
}

if (require.main === module) {
  const r = build();
  const srcBytes = fs.statSync(SRC).size;
  const gz = (p) => zlib.gzipSync(fs.readFileSync(p)).length;
  console.log(
    `[build-js] app.min.js  ${(r.bytes / 1024).toFixed(1)} KB（源 app.js ${(srcBytes / 1024).toFixed(1)} KB，` +
    `省 ${((1 - r.bytes / srcBytes) * 100).toFixed(0)}%；gzip ${gz(OUT)} → ${gz(SRC)} 字节）`
  );
}

module.exports = { build, minify, stripComments, joinLines, SRC, OUT };
