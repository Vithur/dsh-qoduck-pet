"""极简 asar 读取器：只用标准库，用来在 DSH 源码里查证事实。

这个 asar 的头比 npm `asar` 文档描述的多一个 uint32（实测偏移 16 处才是 JSON）：
  0..3    UInt32LE   = 4
  4..7    UInt32LE   = pickle 总长
  8..11   UInt32LE   = 补齐后的长度
  12..15  UInt32LE   = JSON 实际长度
  16..    headerJson  (UTF-8)
  之后    文件数据；每个文件头里带 offset / size
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

DEFAULT_ASAR = Path(r"D:\Program\deepseek\resources\app.asar")


def _as_int(value, default: int = 0) -> int:
    """这个 asar 把 offset/size 存成十进制字符串，不能直接参与运算。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class Asar:
    def __init__(self, path: Path = DEFAULT_ASAR) -> None:
        self.path = Path(path)
        self._fh = self.path.open("rb")
        head = self._fh.read(16)
        _a, _b, _c, json_size = struct.unpack("<IIII", head)
        self.header = json.loads(self._fh.read(json_size).decode("utf-8"))
        self._base = 16 + json_size + (4 - json_size % 4) % 4

    def _walk(self, node: dict, prefix: str):
        for name, child in (node.get("files") or {}).items():
            p = f"{prefix}/{name}"
            if "files" in child:
                yield from self._walk(child, p)
            else:
                yield p, child

    def entries(self):
        return list(self._walk(self.header, ""))

    def _node(self, inner: str) -> dict:
        node = self.header
        for part in inner.strip("/").split("/"):
            node = (node.get("files") or {})[part]
        return node

    def read(self, inner: str, limit: int | None = None) -> bytes:
        node = self._node(inner)
        # unpacked 的文件不在归档里，落在同级的 app.asar.unpacked 目录
        if node.get("unpacked"):
            ext = self.path.with_name(self.path.name + ".unpacked")
            return (ext / inner.strip("/")).read_bytes()[: limit or None]
        size = _as_int(node.get("size", 0))
        off = _as_int(node.get("offset", 0))
        if limit:
            size = min(size, limit)
        self._fh.seek(self._base + off)
        return self._fh.read(size)

    def text(self, inner: str) -> str:
        return self.read(inner).decode("utf-8", "replace")


def main() -> int:
    asar = Asar()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        pat = sys.argv[2] if len(sys.argv) > 2 else ""
        for p, e in asar.entries():
            if pat in p:
                print(f"{e.get('size', 0):>9}  {p}")
        return 0
    if cmd == "read":
        print(asar.text(sys.argv[2])[: int(sys.argv[3]) if len(sys.argv) > 3 else 100000])
        return 0
    if cmd == "grep":
        needle = sys.argv[2]
        exts = tuple(sys.argv[3].split(",")) if len(sys.argv) > 3 else (".js",)
        found = 0
        for p, e in asar.entries():
            if not p.endswith(exts):
                continue
            body = asar.text(p)
            if needle in body:
                found += 1
                print(p)
        print(f"--- 命中 {found} 个文件")
        return 0
    raise SystemExit(f"未知命令: {cmd}")


if __name__ == "__main__":
    raise SystemExit(main())
