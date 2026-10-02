"""
把 Qoduck 的动画 WebP 转成 WPF 能吃的 spritesheet PNG。

WPF 没有动画 WebP 解码器，所以桌面宠物那一侧必须自己推帧。这里把每个动画
的全部帧按 8 列拼成一张 PNG（保持原始 256x277 单帧尺寸），并产出一份
manifest.json 说明每个动画的行列数、帧时长与循环语义。

用法：python scripts/build-frames.py
"""

import json
import os
import struct
from PIL import Image, ImageSequence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "frames")
COLS = 8

# 动画名 -> 源文件名。键名与 lib/index.js 的状态机一致。
ANIMATIONS = {
    "idle": "idle.webp",
    "running": "running.webp",
    "waiting": "waiting.webp",
    "review": "review.webp",
    "failed": "failed.webp",
    "waving": "waving.webp",
    "jumping": "jumping.webp",
    "runningLeft": "running-left.webp",
    "runningRight": "running-right.webp",
    "lookLeft": "look-left.webp",
    "lookRight": "look-right.webp",
    "idleEye": "idle-eye.webp",
}

# 单次播放的动作（播完回到基础姿态）
ONE_SHOT = {"waving", "jumping"}


def webp_durations(path):
    """解析 WebP 的 ANMF 块，返回每帧的显示时长（毫秒）。"""
    data = open(path, "rb").read()
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        return []
    pos, durations = 12, []
    while pos + 8 <= len(data):
        fourcc = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        if fourcc == b"ANMF":
            # ANMF 载荷的第 12..14 字节是 24 位帧时长
            dur = struct.unpack("<I", data[pos + 8 + 12:pos + 8 + 15] + b"\x00")[0]
            durations.append(dur)
        pos += 8 + size + (size & 1)
    return durations


def main():
    os.makedirs(OUT, exist_ok=True)

    # 先扫一遍所有帧，求全局并集包围盒：窗口只覆盖角色真正占用的像素，
    # 无效点击区最小，解码内存也按比例下降。所有动画共用同一个裁剪框，
    # 这样切换动画时角色不会跳位。
    union = None
    frame_size = None
    loaded = {}
    for name, filename in ANIMATIONS.items():
        src = os.path.join(ASSETS, filename)
        if not os.path.exists(src):
            raise SystemExit("缺少素材：" + src)
        im = Image.open(src)
        frames = [f.convert("RGBA") for f in ImageSequence.Iterator(im)]
        loaded[name] = frames
        if frame_size is None:
            frame_size = frames[0].size
        for frame in frames:
            box = frame.getbbox()
            if box is None:
                continue
            union = box if union is None else (
                min(union[0], box[0]), min(union[1], box[1]),
                max(union[2], box[2]), max(union[3], box[3]),
            )
    if union is None:
        raise SystemExit("所有帧都是空的")
    # 留 2px 余量避免裁掉抗锯齿边缘，但不许超出原图——超出去只会补出透明边，
    # 白白撑大单元格。素材本身已经画到画布边缘时这里就是个恒等变换。
    pad = 2
    crop = (
        max(0, union[0] - pad),
        max(0, union[1] - pad),
        min(frame_size[0], union[2] + pad),
        min(frame_size[1], union[3] + pad),
    )
    print(f"全局包围盒 {union} -> 裁剪框 {crop}  "
          f"({crop[2]-crop[0]}x{crop[3]-crop[1]})")

    manifest = {"_cell": {"width": crop[2] - crop[0], "height": crop[3] - crop[1]}}
    total_bytes = 0

    for name, filename in ANIMATIONS.items():
        frames = [f.crop(crop) for f in loaded[name]]
        count = len(frames)
        fw, fh = frames[0].size

        rows = (count + COLS - 1) // COLS
        sheet = Image.new("RGBA", (fw * COLS, fh * rows), (0, 0, 0, 0))
        for index, frame in enumerate(frames):
            if frame.size != (fw, fh):
                frame = frame.resize((fw, fh))
            col, row = index % COLS, index // COLS
            sheet.paste(frame, (col * fw, row * fh))

        dest = os.path.join(OUT, name + ".png")
        sheet.save(dest, "PNG", optimize=True)
        size = os.path.getsize(dest)
        total_bytes += size

        durations = webp_durations(os.path.join(ASSETS, filename))
        manifest[name] = {
            "file": name + ".png",
            "frames": count,
            "cols": COLS,
            "rows": rows,
            "frameWidth": fw,
            "frameHeight": fh,
            "durationsMs": durations if len(durations) == count else [33] * count,
            "totalMs": sum(durations) if len(durations) == count else 33 * count,
            "loop": name not in ONE_SHOT,
        }
        print(f"{name:14s} {count:3d} 帧  {COLS}x{rows} 表  {size/1024:8.1f} KB")

    # 16 向注视帧同样裁到同一个框，保持与动画帧同一坐标系
    looks = sorted(f for f in os.listdir(ASSETS) if f.startswith("look-") and "-still" not in f
                   and f not in ("look-left.webp", "look-right.webp"))
    for filename in looks:
        stem = os.path.splitext(filename)[0]
        dest = os.path.join(OUT, stem + ".png")
        Image.open(os.path.join(ASSETS, filename)).convert("RGBA").crop(crop).save(dest, "PNG", optimize=True)
        total_bytes += os.path.getsize(dest)
    manifest["_lookFrames"] = [os.path.splitext(f)[0] + ".png" for f in looks]
    print(f"注视帧          {len(looks)} 张独立 PNG")

    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    print(f"\n合计 {total_bytes/1024/1024:.1f} MB -> {OUT}")


if __name__ == "__main__":
    main()
