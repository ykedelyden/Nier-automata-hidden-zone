#!/usr/bin/env python3
"""
NieR: Automata - CPK Diagnostic v2
Finds TOC location and dumps row/string data to fix the parser.
"""
import struct, os

CPK_PATH = r"D:\steam\steamapps\common\NieRAutomata\data\data002.cpk"

def hexdump(data, offset_base=0, length=None):
    if length is None: length = len(data)
    for i in range(0, min(length, len(data)), 16):
        chunk = data[i:i+16]
        h = ' '.join(f'{b:02X}' for b in chunk)
        a = ''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in chunk)
        print(f"  {offset_base+i:06X}: {h:<48}  {a}")

print("Reading CPK...")
with open(CPK_PATH, 'rb') as f:
    first64k = f.read(65536)

# --- Find TOC / ITOC / ETOC magic ---
print("\n=== MAGIC MARKERS IN FIRST 64KB ===")
for magic in [b'TOC ', b'ITOC', b'ETOC', b'GTOC']:
    pos = 0
    while True:
        pos = first64k.find(magic, pos)
        if pos == -1: break
        print(f"\n  '{magic.decode()}' at file offset 0x{pos:X}")
        hexdump(first64k[pos:pos+32], offset_base=pos)
        pos += 1

# --- Read the @UTF main header and dump row + string data ---
print("\n=== MAIN @UTF TABLE (at file offset 0x10) ===")
us = struct.unpack_from('<Q', first64k, 8)[0]
print(f"  UTF size from header: {us} bytes")

utf = first64k[0x10 : 0x10 + us + 8]
print(f"  @UTF magic: {utf[:4]}")

if utf[:4] == b'@UTF':
    b8 = 8
    rows_off = struct.unpack_from('>I', utf, 8)[0]  + b8
    strs_off = struct.unpack_from('>I', utf, 12)[0] + b8
    data_off = struct.unpack_from('>I', utf, 16)[0] + b8
    ncols    = struct.unpack_from('>H', utf, 24)[0]
    stride   = struct.unpack_from('>H', utf, 26)[0]
    nrows    = struct.unpack_from('>I', utf, 28)[0]

    print(f"  rows_off={rows_off}, strs_off={strs_off}, data_off={data_off}")
    print(f"  ncols={ncols}, stride={stride}, nrows={nrows}")

    # Dump string table
    print(f"\n  STRING TABLE (first 300 bytes from offset {strs_off}):")
    strtbl = utf[strs_off:strs_off+300]
    hexdump(strtbl, offset_base=strs_off)
    names = strtbl.split(b'\x00')
    print(f"\n  Column names found: {[n.decode('ascii','?') for n in names if n]}")

    # Dump column definitions (first 10 columns)
    print(f"\n  COLUMN DEFINITIONS (first 10, at UTF+32):")
    p = 32
    for i in range(min(10, ncols)):
        flags = utf[p]
        sg_lo = flags & 0x0F
        dt_lo = (flags >> 4) & 0x0F
        sg_hi = (flags >> 4) & 0x0F
        dt_hi = flags & 0x0F
        no = struct.unpack_from('>I', utf, p+1)[0]
        try:
            name_bytes = utf[strs_off+no:]
            name_end = name_bytes.find(b'\x00')
            name = name_bytes[:name_end].decode('ascii','?')
        except:
            name = '?'
        print(f"    col[{i:2d}] offset={p:4d} flags=0x{flags:02X}  name_off={no:4d} name='{name}'")
        print(f"           interp-A: storage={sg_lo} type={dt_lo}(hi)  |  interp-B: storage={sg_hi} type={dt_hi}(lo)")
        p += 5  # flags(1) + name_off(4)

    # Dump raw row data
    print(f"\n  RAW ROW DATA ({stride} bytes from offset {rows_off}):")
    row = utf[rows_off:rows_off+stride]
    hexdump(row, offset_base=rows_off)

    # Scan row for plausible uint64 file offsets (> 0x100, < file size)
    file_size = os.path.getsize(CPK_PATH)
    print(f"\n  SCANNING ROW FOR PLAUSIBLE OFFSETS (file size = {file_size:,} = 0x{file_size:X}):")
    for i in range(0, stride-7, 4):
        v64_le = struct.unpack_from('<Q', row, i)[0] if i+8<=stride else 0
        v32_le = struct.unpack_from('<I', row, i)[0] if i+4<=stride else 0
        if 0x100 < v64_le < file_size:
            print(f"    row[{i:3d}]: uint64-LE = 0x{v64_le:016X} ({v64_le:,})  <- plausible offset")
        elif 0x100 < v32_le < file_size:
            print(f"    row[{i:3d}]: uint32-LE = 0x{v32_le:08X} ({v32_le:,})  <- plausible offset")

input("\nAppuie sur Entree pour quitter...")