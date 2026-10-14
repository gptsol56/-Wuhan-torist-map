import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'style.src.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// 抽屉宽 = min(320px, 88vw)；对话框让位后左边界 = 抽屉宽 + 12px
const DRAWER = 'min(320px, 88vw)';

describe('窄屏：侧栏抽屉不能压住路线查询对话框', () => {
  // 抽屉 z-index 1500 > 对话框 1300，靠层级是压不住的（侧栏里的工具菜单还得浮在上面），
  // 只能靠位移让位。少了这条，对话框左半边（出发点/到达点/查询路线）直接点不到。
  it('抽屉打开时把对话框推到抽屉右边，而不是压在下面', () => {
    expect(CSS).toMatch(/body\.panel-open\s+\.route-panel\.route-panel\s*\{[^}]*left\s*:\s*calc\(/);
  });

  it('对话框让位后的宽度 = 视口 - 抽屉宽 - 左右各 12px', () => {
    const m = CSS.match(/body\.panel-open\s+\.route-panel\.route-panel\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m[1];
    expect(body).toContain(`left:calc(${DRAWER} + 12px)`);
    expect(body).toContain(`width:calc(100vw - ${DRAWER} - 24px)`);
  });

  // 用双类 .route-panel.route-panel 提特异性，压过基础规则和窄屏那条单类的 top。
  it('让位规则用双类提特异性，不靠书写顺序', () => {
    expect(CSS).toContain('body.panel-open .route-panel.route-panel{');
  });

  // 604px 以下剩下的宽度已经装不下 260px 的对话框，这时必须让抽屉优先，
  // 否则对话框被挤成一条缝，比被盖住更难用。
  it('宽度不够时改为隐藏对话框（抽屉优先），不留一条缝', () => {
    expect(CSS).toMatch(
      /@media\s*\(max-width:603px\)\s*\{\s*body\.panel-open\s+\.route-panel\.route-panel\s*\{\s*display\s*:\s*none/
    );
  });

  // 位移要有过渡，否则 body.panel-open 一加上就是瞬移，看起来像闪了一下
  it('left / width 有过渡', () => {
    expect(CSS).toMatch(/\.route-panel\s*\{\s*transition\s*:[^}]*left[^}]*width/);
  });
});

describe('body.panel-open 必须跟着 #panel.open 走', () => {
  // 断言只认代码：注释里到处都在解释 panel-open，不能一并算进去
  const CODE = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('有一个统一的同步函数，值从 #panel.open 派生', () => {
    expect(CODE).toMatch(
      /function\s+syncPanelOpenState\s*\(\s*\)\s*\{\s*document\.body\.classList\.toggle\(\s*'panel-open'\s*,\s*panelEl\.classList\.contains\('open'\)\s*\);?\s*\}/
    );
  });

  // 之前只有 #toggle 的 onclick 在维护 body.panel-open，
  // collapseBtn / expandBtn 只动 #panel.open → class 残留在 body 上：
  // 收起抽屉后 ☰ 被永久藏掉，路线面板也一直按「抽屉开着」让位，回不到原位。
  it('panel-open 只允许出现在同步函数里，别处一律不许再碰', () => {
    const fn = CODE.match(/function\s+syncPanelOpenState\s*\(\s*\)\s*\{[^}]*\}/);
    expect(fn).not.toBeNull();
    // 把同步函数本身挖掉，剩下的代码再出现 panel-open 就是有人绕过了它
    expect(CODE.replace(fn[0], '')).not.toMatch(/panel-open/);
  });

  it('改 #panel.open 的四个入口都调了同步函数', () => {
    // collapseBtn / expandBtn 走的是 document.getElementById('panel')，
    // toggle / measureBtn 走的是 panelEl —— 两种写法都得同步到。
    for (const id of ['toggle', 'collapseBtn', 'expandBtn']) {
      const handler = CODE.match(
        new RegExp("getElementById\\(\\s*'" + id + "'\\s*\\)\\.onclick\\s*=\\s*function\\s*\\(\\s*\\)\\s*\\{([\\s\\S]*?)\\n\\};")
      );
      expect(handler, id + ' 的 onclick 没找到').not.toBeNull();
      expect(handler[1], id + ' 忘了调 syncPanelOpenState()').toContain('syncPanelOpenState()');
    }
    // measureBtn 在窄屏自动收抽屉那段
    expect(CODE).toMatch(/innerWidth\s*<=\s*820[\s\S]{0,200}syncPanelOpenState\(\)/);
  });
});
