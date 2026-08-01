"""A tiny YAML-subset loader — zero dependencies.

Used as a fallback when PyYAML isn't installed (e.g. bleeding-edge Python with
no wheel). It supports exactly the shape lane configs use:

  - top-level ``key: scalar``
  - ``key:`` followed by an indented ``- scalar`` list
  - ``key:`` followed by an indented list of ``- subkey: value`` maps
  - ``# comments`` and blank lines, single/double-quoted scalars

It is intentionally NOT a general YAML parser. Lane files are simple and
validated by ``LaneConfig`` after loading, so anything malformed is caught.
"""
from __future__ import annotations

from typing import Any


def _strip_comment(line: str) -> str:
    out: list[str] = []
    quote: str | None = None
    for ch in line:
        if quote:
            out.append(ch)
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            out.append(ch)
        elif ch == "#":
            break
        else:
            out.append(ch)
    return "".join(out)


def _scalar(v: str) -> Any:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        return v[1:-1]
    return v


def _lines(text: str) -> list[tuple[int, str]]:
    rows: list[tuple[int, str]] = []
    for raw in text.splitlines():
        s = _strip_comment(raw)
        if s.strip() == "":
            continue
        rows.append((len(s) - len(s.lstrip(" ")), s.strip()))
    return rows


def _parse_map(rows: list[tuple[int, str]], pos: list[int], indent: int) -> dict:
    result: dict[str, Any] = {}
    while pos[0] < len(rows):
        ind, content = rows[pos[0]]
        if ind != indent or content.startswith("- "):
            break
        key, _, val = content.partition(":")
        key, val = key.strip(), val.strip()
        pos[0] += 1
        if val:
            result[key] = _scalar(val)
        elif pos[0] < len(rows) and rows[pos[0]][0] > indent:
            child_indent = rows[pos[0]][0]
            if rows[pos[0]][1].startswith("- "):
                result[key] = _parse_list(rows, pos, child_indent)
            else:
                result[key] = _parse_map(rows, pos, child_indent)
        else:
            result[key] = None
    return result


def _parse_list(rows: list[tuple[int, str]], pos: list[int], indent: int) -> list:
    items: list[Any] = []
    while pos[0] < len(rows):
        ind, content = rows[pos[0]]
        if ind != indent or not content.startswith("- "):
            break
        body = content[2:].strip()
        pos[0] += 1
        if ":" in body:
            k, _, v = body.partition(":")
            item: dict[str, Any] = {k.strip(): _scalar(v.strip())}
            while (pos[0] < len(rows) and rows[pos[0]][0] > indent
                   and not rows[pos[0]][1].startswith("- ")):
                ck, _, cv = rows[pos[0]][1].partition(":")
                item[ck.strip()] = _scalar(cv.strip())
                pos[0] += 1
            items.append(item)
        else:
            items.append(_scalar(body))
    return items


def load(text: str) -> Any:
    rows = _lines(text)
    if not rows:
        return {}
    return _parse_map(rows, [0], rows[0][0])
