# 生成 PWA 图标（icons/*.png）—— 纯标准库（zlib+struct），不依赖 PIL
#
# 设计：品牌红 #e5484d 底 + 白色黄鹤楼剪影（三层檐 + 塔身 + 基座 + 塔尖）。
# 产物（A4）：
#   icons/icon-192.png           常规图标（圆角方块、四角透明）
#   icons/icon-512.png           常规图标 512（Chrome 安装硬性要求）
#   icons/icon-maskable-512.png  maskable：全出血无边框圆角，主体收进中心 80% 安全区
#   icons/apple-touch-icon.png   iOS 主屏图标 180（全出血、不透明）
#
# 图标是视觉产物，改设计改本脚本后重跑 `python tools/gen-icons.py` 并提交。

import math
import os
import struct
import zlib

RED = (229, 72, 77)      # 品牌红 #e5484d
WHITE = (255, 255, 255)
SS = 3                    # 每像素超采样 3x3，抗锯齿


def write_png(path, size, pixel_fn):
    """pixel_fn(u, v) -> (r, g, b, a)，u/v ∈ [0,1)"""
    width = height = size
    rows = []
    for py in range(height):
        row = bytearray([0])  # filter type 0
        for px in range(width):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    u = (px + (sx + 0.5) / SS) / width
                    v = (py + (sy + 0.5) / SS) / height
                    pr, pg, pb, pa = pixel_fn(u, v)
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n = SS * SS
            if a == 0:
                row += b'\x00\x00\x00\x00'
            else:
                row += bytes((min(255, round(r / a)), min(255, round(g / a)),
                              min(255, round(b / a)), min(255, round(a / n * 255))))
        rows.append(bytes(row))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(f'[gen-icons] {path}  {width}x{height}  {len(png)} bytes')


def in_rect(u, v, u0, v0, u1, v1):
    return u0 <= u <= u1 and v0 <= v <= v1


def in_trapezoid(u, v, v0, v1, half_top, half_bottom):
    """以 x=0.5 为轴的竖直梯形（檐口：下缘更宽，模拟飞檐）"""
    if not (v0 <= v <= v1):
        return False
    t = (v - v0) / (v1 - v0)
    half = half_top + (half_bottom - half_top) * t
    return abs(u - 0.5) <= half


def pagoda(u, v, scale=1.0):
    """黄鹤楼剪影。scale<1 时整体向中心收缩（maskable 安全区用）。"""
    if scale != 1.0:
        u = 0.5 + (u - 0.5) * (1 / scale)
        v = 0.5 + (v - 0.5) * (1 / scale)
    # 三层塔身（下宽上窄）
    if in_rect(u, v, 0.40, 0.60, 0.60, 0.80): return True
    if in_rect(u, v, 0.425, 0.575, 0.44, 0.60): return True
    if in_rect(u, v, 0.45, 0.55, 0.29, 0.44): return True
    # 三层出檐（梯形：上窄下宽，飞檐轮廓）
    if in_trapezoid(u, v, 0.575, 0.625, 0.20, 0.255): return True
    if in_trapezoid(u, v, 0.41, 0.46, 0.175, 0.225): return True
    if in_trapezoid(u, v, 0.25, 0.30, 0.15, 0.19): return True
    # 塔尖 + 基座
    if in_rect(u, v, 0.482, 0.518, 0.15, 0.26): return True
    if in_rect(u, v, 0.21, 0.79, 0.80, 0.87): return True
    return False


def rounded_square(u, v, radius):
    """圆角正方形（满幅），返回是否在方块内"""
    r = radius
    x = min(u, 1 - u)
    y = min(v, 1 - v)
    if x >= r or y >= r:
        return True
    return math.hypot(r - x, r - y) <= r


def icon_any(u, v):
    """常规图标：红圆角方块 + 白塔，四角透明"""
    if not rounded_square(u, v, 0.22):
        return (0, 0, 0, 0.0)
    if pagoda(u, v):
        return (*WHITE, 1.0)
    return (*RED, 1.0)


def icon_maskable(u, v):
    """maskable：全出血红底，主体收进中心 80% 安全区"""
    if pagoda(u, v, scale=0.8):
        return (*WHITE, 1.0)
    return (*RED, 1.0)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), '..', 'icons')
    os.makedirs(out, exist_ok=True)
    write_png(os.path.join(out, 'icon-192.png'), 192, icon_any)
    write_png(os.path.join(out, 'icon-512.png'), 512, icon_any)
    write_png(os.path.join(out, 'icon-maskable-512.png'), 512, icon_maskable)
    write_png(os.path.join(out, 'apple-touch-icon.png'), 180, icon_maskable)
