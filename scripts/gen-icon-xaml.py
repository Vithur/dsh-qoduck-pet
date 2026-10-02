"""从 assets/icons/native-icons.json 生成 pet.ps1 用的 XAML Geometry 资源块。

为什么要有这个脚本：原生图标是 16x16 viewBox 的 SVG path（含 C 曲线），而 pet.ps1 里
原来是手写的 14x14 WPF 迷你语言。逐条手抄 14 个图标容易抄错，所以机械转写。

拆两组的原因：WPF 一个 Path 只有一个 Fill 和一个 Stroke，而原生图标里既有「只描边」的
开放路径（如 commands 的 `M3 4L7 8L3 12` 折线，若被填充会变成一个三角形），也有
「既填充又描边」的闭合路径（如 read 的圆角矩形环）。所以分成：
  - 描边组（fill=none）        -> DetailIcon
  - 填充组（fill=currentColor）-> DetailIconFill，同时带 Stroke（与原 SVG 一致）
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "icons" / "native-icons.json"

# 与 lib/step-summary.js 的 PROCESS_ICONS 值一致的旧名 -> 新类别名
ALIAS = {
    "think": "thinking",
    "browse": "read",
    "search": "search",
    "edit": "edit",
    "api": "commands",
    "code": "code",
    "globe": "webSearch",
    "agent": "subagents",
    "plan": "plan",
    "question": "questions",
    "sparkle": "tools",
}

ORDER = ["thinking", "read", "readImage", "search", "edit", "write", "commands",
         "code", "webSearch", "webFetch", "subagents", "plan", "questions", "tools"]


def norm_d(d: str) -> str:
    """SVG path 的 d 原样保留（WPF 迷你语言与 SVG 在 M/C/L/H/V/Z 上语法一致）。

    这里只做一件事：把逗号去掉、压缩空白，便于比对；数字精度不动，避免改变图形。
    """
    d = d.replace(",", " ")
    return re.sub(r"\s+", " ", d).strip()


def main() -> int:
    data = json.loads(SRC.read_text(encoding="utf-8"))

    assert set(data) == set(ORDER), f"类别集合不符: {sorted(set(data) ^ set(ORDER))}"

    # 逐个核对：不允许出现 A（圆弧）——WPF 与 SVG 的 A 参数格式不同，必须人工转写。
    # 出现就报错退出，而不是静默批量替换。
    arcs = []
    for cat, spec in data.items():
        for p in spec["paths"]:
            if re.search(r"[Aa]", p["d"]):
                arcs.append(cat)
    if arcs:
        print(f"发现圆弧指令，需人工逐条转换: {sorted(set(arcs))}", file=sys.stderr)
        return 2

    lines = []
    lines.append("  <Border.Resources>")
    lines.append("    <!-- DSH 原生图标（16x16 viewBox，stroke=currentColor）。")
    lines.append("         由 scripts/gen-icon-xaml.py 从 assets/icons/native-icons.json 生成，别手改。")
    lines.append("         分描边/填充两组：WPF 一个 Path 只有一组 Fill/Stroke，而原生图标里既有")
    lines.append("         纯描边的开放折线（被填充会变成实心块），也有既填充又描边的闭合环。 -->")

    stroke_keys, fill_keys = {}, {}
    for cat in ORDER:
        spec = data[cat]
        stroke_ds, fill_ds = [], []
        for p in spec["paths"]:
            d = norm_d(p["d"])
            fill = p.get("fill")
            if fill and fill != "none":
                fill_ds.append(d)
            else:
                stroke_ds.append(d)
        assert stroke_ds or fill_ds, cat
        skey, fkey = f"Icon.{cat}", f"IconFill.{cat}"
        if stroke_ds:
            lines.append(f'    <Geometry x:Key="{skey}">')
            for d in stroke_ds:
                lines.append(f"      {d}")
            lines.append("    </Geometry>")
            stroke_keys[cat] = skey
        if fill_ds:
            lines.append(f'    <Geometry x:Key="{fkey}">')
            for d in fill_ds:
                lines.append(f"      {d}")
            lines.append("    </Geometry>")
            fill_keys[cat] = fkey

    lines.append("  </Border.Resources>")
    xaml_block = "\n".join(lines)

    # 生成的 PS 映射表
    ps = []
    ps.append("# 类别 -> XAML 里的 Geometry 资源键。旧名（think/browse/...）经 $script:IconAlias 归一。")
    ps.append("$script:IconStrokeKeys = @{")
    for cat in ORDER:
        if cat in stroke_keys:
            ps.append(f"    {cat} = '{stroke_keys[cat]}'")
    ps.append("}")
    ps.append("$script:IconFillKeys = @{")
    for cat in ORDER:
        if cat in fill_keys:
            ps.append(f"    {cat} = '{fill_keys[cat]}'")
    ps.append("}")

    out = ROOT / "scripts" / ".icon-xaml.generated.txt"
    out.write_text(xaml_block + "\n\n===== PS KEYS =====\n" + "\n".join(ps) + "\n", encoding="utf-8")

    print(f"OK 类别 {len(ORDER)} 个；描边组 {len(stroke_keys)} 个，填充组 {len(fill_keys)} 个")
    print("填充组类别:", ", ".join(sorted(fill_keys)))
    print("输出:", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
