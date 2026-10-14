import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RAW = fs.readFileSync(path.join(ROOT, 'style.src.css'), 'utf8');

// 去掉注释再数括号：注释里出现 { 或 } 会把计数带偏，
// 而「注释没闭合」本身就是下面单独要查的一类错误。
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, '');

describe('style.src.css 结构完整', () => {
  // 这一条是被真实事故逼出来的：给 .route-panel 补 transition 时，
  // 收尾的 } 被吃掉，整条规则没闭合，浏览器从那里开始一路吞括号 ——
  // 后面几十条规则（含 .rp-row{display:flex} / input{flex:1}）全被并进上一个块，
  // 页面上就表现为「输入框不撑满、按钮不撑满、右边空出一大块玻璃」，
  // 但 node --check 和所有按字符串匹配的测试照样全绿。
  it('大括号配平（少一个 } 就会把后面所有规则吞掉）', () => {
    const open = (CODE.match(/\{/g) || []).length;
    const close = (CODE.match(/\}/g) || []).length;
    expect(open - close, `style.src.css 少了 ${open - close} 个 }`).toBe(0);
  });

  it('注释成对闭合', () => {
    expect((RAW.match(/\/\*/g) || []).length).toBe((RAW.match(/\*\//g) || []).length);
  });

  it('每条规则都以 } 收尾，不会出现「{ 后面直接跟下一条选择器」', () => {
    // 去掉注释后按分号切成声明，同一个块里不该再冒出选择器特征（. # : [ 空格+{）
    const blocks = CODE.match(/\{[^{}]*\}/g) || [];
    expect(blocks.length).toBeGreaterThan(100);
    for (const b of blocks) {
      expect(b, '有块里混进了新的选择器，说明上一条规则漏了 }').not.toMatch(/\}\s*[\w.#:\[-]+\s*\{/);
    }
  });
});

describe('路线对话框的关键规则仍然是顶层规则', () => {
  // 上面那条配平检查只能发现「少了 }」，发现不了「多了 }」。
  // 这几个是之前被吞掉过的受害者，逐个钉死它们还在、且带着该有的声明。
  const cases = [
    ['.rp-modes', /(^|})\s*\.rp-modes\s*\{[^}]*display\s*:\s*flex/, '四个出行方式要并排'],
    ['.rp-mode', /(^|})\s*\.rp-mode\s*\{[^}]*flex\s*:\s*1/, '出行方式按钮要等分撑满'],
    ['.rp-row', /(^|})\s*\.route-panel \.rp-row\s*\{[^}]*display\s*:\s*flex/, '出发点/到达点那行要是 flex 容器'],
    ['input', /(^|})\s*\.route-panel input\s*\{[^}]*flex\s*:\s*1/, '输入框要撑满，否则右侧空一大块'],
    ['.rp-actions', /(^|})\s*\.route-panel \.rp-actions\s*\{[^}]*display\s*:\s*flex/, '查询路线/清除那行要是 flex 容器'],
    ['.rp-actions button', /(^|})\s*\.route-panel \.rp-actions button\s*\{[^}]*flex\s*:\s*1/, '查询路线/清除要等分撑满'],
  ];

  for (const [name, re, why] of cases) {
    it(`${name} 还是一条独立规则（${why}）`, () => {
      expect(CODE, `${name} 规则不见了，可能被并进了别的块`).toMatch(re);
    });
  }
});

describe('.sr-only 必须真的把 label 藏起来', () => {
  // HTML 里有两个 <label class="sr-only">出发点 / 到达点</label>，
  // 但这个类一开始在 CSS 里压根没定义 —— 于是两个无障碍标签当成普通文字显示出来，
  // 在 .rp-row(flex) 里各吃掉 ~45px：输入框被从 218px 挤到 172px，
  // placeholder「出发点，如：黄鹤楼」被截断，整列和面板右边缘也对不齐。
  // 教训：HTML 里出现了 class，CSS 里就必须有对应规则，别靠"它应该是隐藏的"。
  const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  it('HTML 里确实在用 class="sr-only"', () => {
    expect(HTML).toMatch(/class="sr-only"/);
  });

  it('.sr-only 是一条顶层规则，且用了移出可视区的写法', () => {
    expect(CODE).toMatch(/(^|})\s*\.sr-only\s*\{/);
    const m = CODE.match(/(^|})\s*\.sr-only\s*\{([^}]*)\}/);
    const body = m[2];
    expect(body, '不能只写 display:none，那样读屏软件也读不到 label').toMatch(
      /position\s*:\s*absolute/
    );
    expect(body).toMatch(/(clip-path\s*:\s*inset\(50%\)|clip\s*:\s*rect)/);
  });

  it('.sr-body 的 label 数量和 .rp-row 数量对得上（别再加新的裸 label）', () => {
    const labels = (HTML.match(/class="sr-only"/g) || []).length;
    expect(labels).toBeGreaterThan(0);
    // 两个 .rp-row 各一个；以后新增行必须同样带上 sr-only
    expect((HTML.match(/class="rp-row"/g) || []).length + 1).toBe(labels + 1);
  });
});

describe('主字体必须是微软雅黑', () => {
  // 原本 html,body 的 font-family 把 PingFang SC / Segoe UI 排在 Microsoft YaHei 前面，
  // 而且文件里还有第二条 html,body 规则覆盖上来（更短的字体栈）——
  // 在 Windows 上 Microsoft YaHei 实际是被吃掉的，渲染走 system-ui。
  // 修复：统一为一条规则，"Microsoft YaHei","微软雅黑" 排第一。
  it('html,body 字体栈以 "Microsoft YaHei" 开头', () => {
    const m = CODE.match(/(^|})\s*html,body\s*\{([^}]*)\}/);
    expect(m, '找不到 html,body{} 规则').toBeTruthy();
    expect(m[2]).toMatch(/font-family\s*:\s*"Microsoft YaHei"/);
    // 显式给出中文名，免得某些场景下字体回退丢字
    expect(m[2]).toMatch(/微软雅黑/);
  });

  it('html,body 规则只有一条（之前的重复声明必须清掉）', () => {
    const matches = CODE.match(/(^|})\s*html,body\s*\{/g) || [];
    expect(matches.length, 'html,body{} 出现多次，后面的会覆盖前面的字体特性').toBe(1);
  });

  it('#panel 字体栈也以 Microsoft YaHei 开头（侧栏单独指定了字体）', () => {
    const m = CODE.match(/(^|})\s*#panel\s*\{([^}]*)\}/);
    expect(m, '找不到 #panel{} 规则').toBeTruthy();
    expect(m[2]).toMatch(/font-family\s*:\s*"Microsoft YaHei"/);
  });

  it('.help-table kbd 仍然是等宽字体（不能被全局字体覆盖成微软雅黑）', () => {
    const m = CODE.match(/(^|})\s*\.help-table kbd\s*\{([^}]*)\}/);
    expect(m).toBeTruthy();
    expect(m[2]).toMatch(/ui-monospace|SFMono-Regular|Consolas|monospace/);
  });
});
