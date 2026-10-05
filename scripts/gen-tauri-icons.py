"""Generate a minimal Ghostping app icon set (pure stdlib, no PIL).

Design: dark rounded square, teal ring (ping motif), white core dot.
Outputs Tauri's required bundle icons into tauri-app/src-tauri/icons/.
"""
import math
import os
import struct
import subprocess
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "tauri-app", "src-tauri", "icons")
SIZE = 1024
BG = (13, 17, 23)
RING = (45, 212, 191)
DOT = (255, 255, 255)


def rounded_rect(x, y, radius, half):
    # signed distance-ish test for rounded square centered at (half, half)
    qx = abs(x - half) - (half - radius)
    qy = abs(y - half) - (half - radius)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - radius


def paint():
    half = SIZE / 2
    px = bytearray()
    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            d_edge = rounded_rect(x + 0.5, y + 0.5, 220.0, half)
            r = math.hypot(x + 0.5 - half, y + 0.5 - half)
            if d_edge > 0:
                c = (0, 0, 0, 0)
            elif abs(r - 300.0) < 26:
                c = (*RING, 255)
            elif r < 120:
                c = (*DOT, 255)
            else:
                c = (*BG, 255)
            row += bytes(c)
        px += b"\x00" + bytes(row)
    return px


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, size, raw):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(ICONS, exist_ok=True)
    master = os.path.join(ICONS, "icon-1024.png")
    write_png(master, SIZE, paint())
    print("wrote", master)
    # Downscale with sips for quality
    for out, px in [("icons/32x32.png", 32), ("icons/128x128.png", 128), ("icons/128x128@2x.png", 256)]:
        dest = os.path.join(ROOT, "tauri-app", "src-tauri", out)
        subprocess.run(["sips", "-z", str(px), str(px), master, "--out", dest], check=True, capture_output=True)
        print("wrote", dest)
    # .icns via iconset + iconutil
    iconset = os.path.join(ICONS, "ghostping.iconset")
    os.makedirs(iconset, exist_ok=True)
    for name, px in [("icon_16x16.png", 16), ("icon_32x32.png", 32), ("icon_128x128.png", 128),
                     ("icon_256x256.png", 256), ("icon_512x512.png", 512)]:
        dest = os.path.join(iconset, name)
        subprocess.run(["sips", "-z", str(px), str(px), master, "--out", dest], check=True, capture_output=True)
        subprocess.run(["sips", "-z", str(px * 2), str(px * 2), master, "--out",
                        os.path.join(iconset, name.replace(".png", "@2x.png"))],
                       check=True, capture_output=True)
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ICONS, "icon.icns")], check=True)
    print("wrote icon.icns")
    # .ico: single PNG-compressed 256x256 entry (valid Vista+ ICO)
    with open(os.path.join(ROOT, "tauri-app", "src-tauri", "icons/128x128@2x.png"), "rb") as f:
        png256 = f.read()
    ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png256), 6 + 16) + png256
    with open(os.path.join(ICONS, "icon.ico"), "wb") as f:
        f.write(ico)
    print("wrote icon.ico")


if __name__ == "__main__":
    main()
