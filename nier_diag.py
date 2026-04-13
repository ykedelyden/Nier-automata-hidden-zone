#!/usr/bin/env python3
"""
NieR: Automata - CPK Format Diagnostic
Dumps raw header bytes to understand the exact CPK structure.
"""
import struct, os

CPK_PATH = r"D:\steam\steamapps\common\NieRAutomata\data\data002.cpk"

def hexdump(data, start=0, length=64):
    for i in range(0, length, 16):
        chunk = data[i:i+16]
        hex_part = ' '.join(f'{b:02X}' for b in chunk)
        asc_part = ''.join(chr(b) if 0x20 <= b <= 0x7E else '.' for b in chunk)
        print(f"  {start+i:04X}: {hex_part:<48}  {asc_part}")

with open(CPK_PATH, 'rb') as f:
    header = f.read(1024)

print("=== PREMIERE SECTION (0x000 - 0x100) ===")
hexdump(header, 0, 256)

print("\n=== INTERPRETATIONS DE L'OFFSET 0x08 ===")
print(f"  LE uint64 : 0x{struct.unpack_from('<Q', header, 8)[0]:016X} = {struct.unpack_from('<Q', header, 8)[0]}")
print(f"  BE uint64 : 0x{struct.unpack_from('>Q', header, 8)[0]:016X} = {struct.unpack_from('>Q', header, 8)[0]}")
print(f"  LE uint32 : 0x{struct.unpack_from('<I', header, 8)[0]:08X} = {struct.unpack_from('<I', header, 8)[0]}")
print(f"  BE uint32 : 0x{struct.unpack_from('>I', header, 8)[0]:08X} = {struct.unpack_from('>I', header, 8)[0]}")

print("\n=== RECHERCHE DE '@UTF' dans les 1024 premiers octets ===")
pos = 0
found = []
while True:
    pos = header.find(b'@UTF', pos)
    if pos == -1: break
    print(f"  @UTF trouve a l'offset 0x{pos:X}")
    found.append(pos)
    pos += 4

if found:
    for utf_off in found:
        print(f"\n=== DETAILS @UTF a 0x{utf_off:X} ===")
        hexdump(header, utf_off, 48)
        if utf_off + 32 <= len(header):
            table_sz = struct.unpack_from('>I', header, utf_off+4)[0]
            rows_off  = struct.unpack_from('>I', header, utf_off+8)[0]
            strs_off  = struct.unpack_from('>I', header, utf_off+12)[0]
            data_off  = struct.unpack_from('>I', header, utf_off+16)[0]
            ncols     = struct.unpack_from('>H', header, utf_off+24)[0]
            stride    = struct.unpack_from('>H', header, utf_off+26)[0]
            nrows     = struct.unpack_from('>I', header, utf_off+28)[0]
            print(f"  table_size = {table_sz}")
            print(f"  rows_off   = {rows_off}")
            print(f"  strs_off   = {strs_off}")
            print(f"  data_off   = {data_off}")
            print(f"  num_cols   = {ncols}")
            print(f"  stride     = {stride}")
            print(f"  num_rows   = {nrows}")

print("\n=== RECHERCHE DE 'TOC ' dans les 1024 premiers octets ===")
pos = 0
while True:
    pos = header.find(b'TOC ', pos)
    if pos == -1: break
    print(f"  'TOC ' a l'offset 0x{pos:X}: {header[pos:pos+16].hex()}")
    pos += 4

print("\n=== FLAGS DU PREMIER COLUMN (@UTF+32) ===")
for utf_off in found:
    if utf_off + 40 <= len(header):
        col_start = utf_off + 32
        f_byte = header[col_start]
        print(f"  @0x{utf_off:X}+32 -> flags byte = 0x{f_byte:02X}  (storage={f_byte & 0xF}, type={(f_byte>>4) & 0xF})")

input("\nAppuie sur Entree pour quitter...")