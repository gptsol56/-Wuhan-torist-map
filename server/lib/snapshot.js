// last-good 快照：把最近一次成功 normalize 的景点数据落盘，作为配额用尽/上游宕机时的陈旧兜底。
// 结构与 routes/crowd.js 返回的 spot 一致（含 _cells/_window/_typPeak/_totalHeat，坐标已是 GCJ-02）。
// 文件路径 server/.cache/last-good.json（已加入 .gitignore）。

const fs = require('fs');
const path = require('path');

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.cache');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'last-good.json');

/**
 * 读取快照。缺失/损坏/结构非法一律返回 null（不抛异常）。
 * @param {string} [filePath] 测试可注入的路径
 * @returns {{ spots: Record<string, object>, savedAt: string } | null}
 */
function load(filePath = SNAPSHOT_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!data || typeof data !== 'object' || !data.spots || typeof data.spots !== 'object') return null;
    return { spots: data.spots, savedAt: typeof data.savedAt === 'string' ? data.savedAt : null };
  } catch (_) {
    return null;
  }
}

/**
 * 原子写入快照（tmp + rename）。失败打印警告并返回 null。
 * @param {Record<string, object>} spotsByName
 * @param {string} [filePath] 测试可注入的路径
 * @returns {string|null} 成功返回 savedAt（ISO），失败返回 null
 */
function save(spotsByName, filePath = SNAPSHOT_PATH) {
  const savedAt = new Date().toISOString();
  const payload = { spots: spotsByName || {}, savedAt };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
    fs.renameSync(tmp, filePath);
    return savedAt;
  } catch (e) {
    console.warn('[snapshot] 写入失败：' + e.message);
    return null;
  }
}

module.exports = { load, save, SNAPSHOT_PATH };
