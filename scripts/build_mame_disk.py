#!/usr/bin/env python3
"""Build a small MBR-partitioned FAT16 data disk for DOS MAME."""
from __future__ import annotations

import argparse
import gzip
import math
import re
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path

ALLOWED_SUFFIXES = {".exe", ".com", ".cfg", ".dat", ".txt"}
INVALID_83 = re.compile(r"[^A-Z0-9_$~!#%&'()@^`{}-]")


@dataclass
class FileEntry:
    name: str
    data: bytes
    stem: str = ""
    extension: str = ""
    first_cluster: int = 0


def put16(buf: bytearray, offset: int, value: int) -> None:
    struct.pack_into("<H", buf, offset, value & 0xFFFF)


def put32(buf: bytearray, offset: int, value: int) -> None:
    struct.pack_into("<I", buf, offset, value & 0xFFFFFFFF)


def put_ascii(buf: bytearray, offset: int, text: str, length: int) -> None:
    raw = text.encode("ascii", "replace")[:length].ljust(length, b" ")
    buf[offset : offset + length] = raw


def dos83(name: str, used: set[str]) -> tuple[str, str]:
    filename = Path(name.replace("\\", "/")).name.upper()
    base, dot, extension = filename.rpartition(".")
    if not dot:
        base, extension = filename, ""
    base = INVALID_83.sub("_", base) or "FILE"
    extension = INVALID_83.sub("_", extension)[:3]

    for suffix_index in range(1000):
        suffix = f"~{suffix_index}" if suffix_index else ""
        stem = (base[: 8 - len(suffix)] + suffix)[:8]
        key = stem.ljust(8) + extension.ljust(3)
        if key not in used:
            used.add(key)
            return stem, extension
    raise RuntimeError(f"8.3 filename collision: {name}")


def build_fat16(files: list[FileEntry], size_mib: int = 32) -> bytes:
    bps = 512
    spc = 2
    partition_start = 63
    total_sectors = size_mib * 2048
    partition_sectors = total_sectors - partition_start
    root_entries = 512
    root_sectors = math.ceil(root_entries * 32 / bps)
    reserved = 1
    fats = 2

    fat_sectors = 1
    for _ in range(10):
        cluster_count = (partition_sectors - reserved - fats * fat_sectors - root_sectors) // spc
        fat_sectors = math.ceil((cluster_count + 2) * 2 / bps)

    if not (4085 <= cluster_count < 65525):
        raise RuntimeError(f"Not a FAT16 cluster count: {cluster_count}")

    disk = bytearray(total_sectors * bps)

    p = 446
    disk[p + 0] = 0x00
    disk[p + 1 : p + 4] = bytes((0x01, 0x01, 0x00))
    disk[p + 4] = 0x06
    disk[p + 5 : p + 8] = bytes((0xFE, 0xFF, 0xFF))
    put32(disk, p + 8, partition_start)
    put32(disk, p + 12, partition_sectors)
    disk[510:512] = b"\x55\xAA"

    boot = partition_start * bps
    disk[boot : boot + 3] = b"\xEB\x3C\x90"
    put_ascii(disk, boot + 3, "MSDOS5.0", 8)
    put16(disk, boot + 11, bps)
    disk[boot + 13] = spc
    put16(disk, boot + 14, reserved)
    disk[boot + 16] = fats
    put16(disk, boot + 17, root_entries)
    put16(disk, boot + 19, 0)
    disk[boot + 21] = 0xF8
    put16(disk, boot + 22, fat_sectors)
    put16(disk, boot + 24, 63)
    put16(disk, boot + 26, 16)
    put32(disk, boot + 28, partition_start)
    put32(disk, boot + 32, partition_sectors)
    disk[boot + 36] = 0x80
    disk[boot + 38] = 0x29
    put32(disk, boot + 39, 0x4D414D45)
    put_ascii(disk, boot + 43, "CHAT MAME", 11)
    put_ascii(disk, boot + 54, "FAT16", 8)
    disk[boot + 510 : boot + 512] = b"\x55\xAA"

    fat_start = partition_start + reserved
    root_start = fat_start + fats * fat_sectors
    data_start = root_start + root_sectors
    cluster_bytes = spc * bps
    fat = [0] * (fat_sectors * bps // 2)
    fat[0], fat[1] = 0xFFF8, 0xFFFF
    next_cluster = 2

    used: set[str] = set()
    for entry in files:
        entry.stem, entry.extension = dos83(entry.name, used)
        count = max(1, math.ceil(len(entry.data) / cluster_bytes))
        entry.first_cluster = next_cluster
        for index in range(count):
            fat[next_cluster] = 0xFFFF if index == count - 1 else next_cluster + 1
            next_cluster += 1
        if next_cluster > cluster_count + 2:
            raise RuntimeError("FAT16 image is too small")

    def cluster_offset(cluster: int) -> int:
        return (data_start + (cluster - 2) * spc) * bps

    root_offset = root_start * bps
    for index, entry in enumerate(files):
        if index >= root_entries:
            raise RuntimeError("Too many root directory entries")
        off = root_offset + index * 32
        put_ascii(disk, off, entry.stem, 8)
        put_ascii(disk, off + 8, entry.extension, 3)
        disk[off + 11] = 0x20
        put16(disk, off + 26, entry.first_cluster)
        put32(disk, off + 28, len(entry.data))
        start = cluster_offset(entry.first_cluster)
        disk[start : start + len(entry.data)] = entry.data

    fat_bytes = b"".join(struct.pack("<H", value) for value in fat)
    for fat_index in range(fats):
        start = (fat_start + fat_index * fat_sectors) * bps
        disk[start : start + fat_sectors * bps] = fat_bytes[: fat_sectors * bps]

    return bytes(disk)


def parse_extra_file(value: str) -> tuple[str, Path]:
    name, separator, source = value.partition("=")
    if not separator or not name or not source:
        raise argparse.ArgumentTypeError("--extra-file must be DOS_NAME=SOURCE_PATH")
    source_path = Path(source)
    if not source_path.is_file():
        raise argparse.ArgumentTypeError(f"extra file does not exist: {source_path}")
    return name, source_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", required=True, dest="zip_path")
    parser.add_argument("--output", required=True)
    parser.add_argument("--gzip-output", required=True)
    parser.add_argument("--size-mib", type=int, default=32)
    parser.add_argument(
        "--extra-file",
        action="append",
        type=parse_extra_file,
        default=[],
        metavar="DOS_NAME=SOURCE_PATH",
    )
    args = parser.parse_args()

    selected: dict[str, bytes] = {}
    with zipfile.ZipFile(args.zip_path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = Path(info.filename.replace("\\", "/")).name
            if Path(name).suffix.lower() in ALLOWED_SUFFIXES:
                selected.setdefault(name.upper(), archive.read(info))

    if "MAME.EXE" not in selected:
        raise RuntimeError("MAME.EXE was not found in the verified archive")

    for dos_name, source_path in args.extra_file:
        selected[dos_name.upper()] = source_path.read_bytes()

    if "CWSDPMI.EXE" not in selected:
        raise RuntimeError("CWSDPMI.EXE is required to run the DJGPP MAME binary")

    selected["PLAY.BAT"] = (
        b"@ECHO OFF\r\n"
        b"MAME.EXE ROBBY -ROMPATH D:\\ -SOUNDCARD 0\r\n"
    )
    selected["MAMEINFO.BAT"] = b"@ECHO OFF\r\nMAME.EXE -HELP\r\n"

    entries = [FileEntry(name=name, data=data) for name, data in sorted(selected.items())]
    image = build_fat16(entries, args.size_mib)

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(image)

    gzip_output = Path(args.gzip_output)
    gzip_output.parent.mkdir(parents=True, exist_ok=True)
    with gzip_output.open("wb") as raw_handle:
        with gzip.GzipFile(fileobj=raw_handle, mode="wb", compresslevel=9, mtime=0) as handle:
            handle.write(image)

    print(f"Built {output}: {len(image)} bytes, {len(entries)} files")
    print(f"Compressed {gzip_output}: {gzip_output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
