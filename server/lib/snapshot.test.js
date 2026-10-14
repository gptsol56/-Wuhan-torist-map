import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { load, save, SNAPSHOT_PATH } from './snapshot.js';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'last-good.json');

describe('snapshot.save/load', () => {
  it('round-trips spots and savedAt', () => {
    const spots = { 黄鹤楼: { name: '黄鹤楼', crowd: '高', _cells: [{ c: [114, 30], heat: 10 }] } };
    const savedAt = save(spots, file());
    expect(typeof savedAt).toBe('string');

    const loaded = load(file());
    expect(loaded.spots['黄鹤楼']).toEqual(spots['黄鹤楼']);
    expect(loaded.savedAt).toBe(savedAt);
  });

  it('load returns null when file missing', () => {
    expect(load(file())).toBeNull();
  });

  it('load returns null on corrupt JSON', () => {
    fs.writeFileSync(file(), '{not json', 'utf-8');
    expect(load(file())).toBeNull();
  });

  it('load returns null on wrong shape (no spots)', () => {
    fs.writeFileSync(file(), JSON.stringify({ foo: 1 }), 'utf-8');
    expect(load(file())).toBeNull();
  });

  it('save creates the directory tree', () => {
    const nested = path.join(dir, 'deep', 'sub', 'last-good.json');
    save({ a: { name: 'a' } }, nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('save returns null (does not throw) when dir cannot be created', () => {
    // 用一个普通文件挡住 mkdir，模拟不可写场景
    const blocker = path.join(dir, 'file.txt');
    fs.writeFileSync(blocker, 'x');
    const underFile = path.join(blocker, 'sub', 'last-good.json');
    expect(save({}, underFile)).toBeNull();
  });
});

describe('SNAPSHOT_PATH', () => {
  it('points under server/.cache/last-good.json', () => {
    expect(SNAPSHOT_PATH).toContain('last-good.json');
    expect(SNAPSHOT_PATH).toContain('.cache');
  });
});
