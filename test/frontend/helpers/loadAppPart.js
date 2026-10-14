import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_PATH = path.resolve(__dirname, '..', '..', '..', 'app.js');

let cachedSrc = null;
function source() {
  if (cachedSrc == null) cachedSrc = fs.readFileSync(APP_PATH, 'utf8');
  return cachedSrc;
}

/** 按花括号配平取出 `function NAME(){...}` 的真实源码 */
export function grabFunction(name) {
  const src = source();
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`app.js 中找不到 function ${name}`);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`function ${name} 花括号不匹配`);
}

/** 取出一行 `var NAME = ...;`（同一行可能还声明了别的变量，会一并带出） */
export function grabVar(name) {
  const src = source();
  const i = src.indexOf(`var ${name} =`);
  if (i < 0) throw new Error(`app.js 中找不到 var ${name}`);
  const end = src.indexOf('\n', src.indexOf(';', i));
  return src.slice(i, end).trim();
}

/**
 * 把 app.js 中指定的几段源码原样取出，在给定桩件作用域里执行。
 *
 * 为什么用「抽取源码」而不是 import：app.js 是 classic script，靠 TMap SDK 的
 * with(map){} 包裹运行，加载即产生副作用（initMarkerCluster / fetch / 定时器），
 * 无法在测试里安全 import。这里直接测真实源码文本 —— 改了 app.js，测试跟着变，
 * 不存在「测试和实现各写一份」的漂移。
 *
 * @param {object}  o
 * @param {string[]}o.parts   函数名数组，或 'var:NAME' 表示取变量声明
 * @param {object}  o.stubs   桩件（依赖的外部变量）
 * @param {string[]}o.exports 需要取回的标识符
 */
export function loadPart({ parts, stubs = {}, exports: exp = [] }) {
  const code = parts
    .map((p) => (p.startsWith('var:') ? grabVar(p.slice(4)) : grabFunction(p)))
    .join('\n');
  const keys = Object.keys(stubs);
  const values = keys.map((k) => stubs[k]);
  // 用 getter/setter 暴露闭包变量：直接返回值会拿到快照，
  // 测试里再赋值就改不到被测函数内部看到的那个变量了。
  //
  // ⚠ 同样地，**不要解构**：const { curTheme } = loadPart(...) 只会把 getter 调一次，
  // 拿到的只是 load 那一刻的值；之后被测函数改了内部变量，这个 const 也不会跟着变。
  // 症状特别有迷惑性：测「点按钮切主题」，DOM 明明变了（断言 body 的 class 全过），
  // 只有读变量的那几条一直读到初始值，看起来像「点了没反应」。
  // 正确写法：const mod = loadPart(...); 之后一律 mod.curTheme。
  const accessors = exp
    .map((n) => `get ${n}(){ return ${n}; }, set ${n}(v){ ${n} = v; }`)
    .join(', ');
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `${code}\n;return { ${accessors} };`);
  return fn(...values);
}

/** 桩件数组是按值传入闭包的，替换引用无效 —— 必须原地改写 */
export function setArr(arr, ...values) {
  arr.length = 0;
  arr.push(...values);
  return arr;
}

/** 列表相关函数的公共桩件 */
export function listStubs(list, SPOTS) {
  return {
    list,
    SPOTS,
    favs: [],
    keyword: '',
    CROWD_TXT: {},
    CROWD_CLS: {},
    getSpotIndex: (s) => SPOTS.indexOf(s),
    getSrcBadge: () => '',
    getReserveInfo: () => [''],
    getCrowdAdvice: () => ({ short: '', shortCls: '' }),
    openState: () => null,
    hl: (t) => t,
  };
}

export const LIST_PARTS = [
  'var:listNodes',
  'esc',
  'rowAttrs',
  'rowInnerHTML',
  'cacheRowButtons',
  'renderListRows',
];