#!/usr/bin/env python3
"""
NieR: Automata - CPK Deep Diagnostic v3
Dumps all TOC entries, scans for ITOC/ETOC/HTOC/GTOC, and lists all actual files.
"""
import struct, os

CPK_PATH = r"D:\steam\steamapps\common\NieRAutomata\data\data002.cpk"
SCAN_SIZE = 2 * 1024 * 1024  # scan first 2MB for magic markers

def cstr(data, pos):
    end = data.find(b'\x00', pos)
    return data[pos: end if end != -1 else pos+256].decode('utf-8', errors='replace')

def hexdump(data, base=0, length=64):
    for i in range(0, min(length, len(data)), 16):
        chunk = data[i:i+16]
        h = ' '.join(f'{b:02X}' for b in chunk)
        a = ''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in chunk)
        print(f"  {base+i:08X}: {h:<48}  {a}")

TYPE_SIZES = {0:1, 1:1, 2:2, 3:2, 4:4, 5:4, 6:8, 7:8, 8:4, 9:8, 0xA:4, 0xB:8}

def read_val(data, pos, t, sb, db):
    try:
        if   t == 0x0: return struct.unpack_from('>B', data, pos)[0], pos+1
        elif t == 0x1: return struct.unpack_from('>b', data, pos)[0], pos+1
        elif t == 0x2: return struct.unpack_from('>H', data, pos)[0], pos+2
        elif t == 0x3: return struct.unpack_from('>h', data, pos)[0], pos+2
        elif t == 0x4: return struct.unpack_from('>I', data, pos)[0], pos+4
        elif t == 0x5: return struct.unpack_from('>i', data, pos)[0], pos+4
        elif t == 0x6: return struct.unpack_from('>Q', data, pos)[0], pos+8
        elif t == 0x7: return struct.unpack_from('>q', data, pos)[0], pos+8
        elif t == 0x8: return struct.unpack_from('>f', data, pos)[0], pos+4
        elif t == 0x9: return struct.unpack_from('>d', data, pos)[0], pos+8
        elif t == 0xA:
            o = struct.unpack_from('>I', data, pos)[0]
            return cstr(data, sb + o), pos+4
        elif t == 0xB:
            o = struct.unpack_from('>I', data, pos)[0]
            s = struct.unpack_from('>I', data, pos+4)[0]
            return (sb + o, s), pos+8
    except: pass
    return None, pos + TYPE_SIZES.get(t, 4)

def parse_utf(raw, base=0):
    if len(raw) < base + 32 or raw[base:base+4] != b'@UTF':
        return None, None
    b8 = base + 8
    ro = struct.unpack_from('>I', raw, base+8)[0]  + b8
    so = struct.unpack_from('>I', raw, base+12)[0] + b8
    do = struct.unpack_from('>I', raw, base+16)[0] + b8
    nc = struct.unpack_from('>H', raw, base+24)[0]
    st = struct.unpack_from('>H', raw, base+26)[0]
    nr = struct.unpack_from('>I', raw, base+28)[0]

    p = base + 32
    cols = []
    for _ in range(nc):
        flags = raw[p]; p += 1
        sg = (flags >> 4) & 0xF
        dt =  flags & 0xF
        no = struct.unpack_from('>I', raw, p)[0]; p += 4
        cv = None
        if sg == 1:
            cv, p = read_val(raw, p, dt, so, do)
        cols.append((cstr(raw, so + no), sg, dt, cv))

    rows = []
    for r in range(nr):
        rp = ro + r * st
        row = {}
        for name, sg, dt, cv in cols:
            if   sg == 0: row[name] = 0
            elif sg == 1: row[name] = cv
            elif sg in (3, 5):
                row[name], rp = read_val(raw, rp, dt, so, do)
            else:
                row[name] = None
        rows.append(row)
    return rows, cols

# ==========================================
print(f"Opening {CPK_PATH}")
file_size = os.path.getsize(CPK_PATH)
print(f"File size: {file_size:,} bytes (0x{file_size:X})")

with open(CPK_PATH, 'rb') as f:
    scan_data = f.read(min(SCAN_SIZE, file_size))

print(f"\nScanning first {len(scan_data):,} bytes for CPK table magic markers...")

# ==========================================
# 1. Find and dump MAIN @UTF (CPK header)
# ==========================================
print("\n" + "="*60)
print("MAIN @UTF (CPK header info) at 0x10:")
print("="*60)
us = struct.unpack_from('<Q', scan_data, 8)[0]
print(f"UTF size from CPK header[8]: {us} bytes (0x{us:X})")

if us == 0 or us > len(scan_data):
    # Try reading table_size from @UTF header directly
    ts_direct = struct.unpack_from('>I', scan_data, 0x14)[0]
    print(f"Using @UTF[4] directly: {ts_direct} bytes")
    us = ts_direct

utf_data = scan_data[0x10 : 0x10 + us + 8]
print(f"Reading {len(utf_data)} bytes from 0x10")

rows, cols = parse_utf(utf_data)
if rows:
    print(f"Parsed OK: {len(rows)} rows, {len(cols)} columns")
    print("\nColumn layout:")
    for i, (name, sg, dt, cv) in enumerate(cols):
        sg_name = {0:'zero', 1:'const', 3:'per-row(3)', 5:'per-row(5)'}.get(sg, f'?{sg}')
        dt_name = {0:'u8',1:'i8',2:'u16',3:'i16',4:'u32',5:'i32',6:'u64',7:'i64',8:'f32',9:'f64',0xA:'str',0xB:'data'}.get(dt, f'?{dt}')
        cv_show = f" = {cv!r}" if sg == 1 else ''
        print(f"  [{i:2d}] flags=0x{(sg<<4|dt):02X}  storage={sg_name:<12} type={dt_name:<6} name='{name}'{cv_show}")
    print("\nRow 0 values:")
    for k, v in rows[0].items():
        print(f"  {k} = {v!r}")
else:
    print("FAILED to parse main @UTF")
    print("Raw bytes at 0x10:")
    hexdump(scan_data, base=0x10, length=64)

# ==========================================
# 2. Find all table magic markers
# ==========================================
print("\n" + "="*60)
print("ALL TABLE MAGIC MARKERS IN FIRST 2MB:")
print("="*60)
MAGICS = [b'CPK ', b'TOC ', b'ITOC', b'ETOC', b'GTOC', b'HTOC', b'@UTF']
found_tables = {}
for magic in MAGICS:
    pos = 0
    locs = []
    while True:
        p = scan_data.find(magic, pos)
        if p == -1: break
        locs.append(p)
        pos = p + 4
    if locs:
        found_tables[magic.decode('latin-1')] = locs
        for loc in locs[:5]:
            print(f"  '{magic.decode()}' at 0x{loc:08X}")

# ==========================================
# 3. Parse the TOC at 0x800 and dump ALL entries
# ==========================================
print("\n" + "="*60)
print("TOC TABLE at 0x800:")
print("="*60)
with open(CPK_PATH, 'rb') as f:
    f.seek(0x800)
    toc_hdr = f.read(0x10)

print(f"Magic: {toc_hdr[:4]} | raw: {toc_hdr[:16].hex()}")
if toc_hdr[:4] == b'TOC ':
    ts = struct.unpack_from('<Q', toc_hdr, 8)[0]
    print(f"Table size (LE uint64 at +8): {ts} bytes")
    with open(CPK_PATH, 'rb') as f:
        f.seek(0x800 + 0x10)
        toc_raw = f.read(ts + 8)
    rows, cols = parse_utf(toc_raw)
    if rows:
        print(f"TOC: {len(rows)} entries, {len(cols)} columns")
        print("\nColumn layout:")
        for i, (name, sg, dt, cv) in enumerate(cols):
            sg_name = {0:'zero', 1:'const', 3:'per-row(3)', 5:'per-row(5)'}.get(sg, f'?{sg}')
            dt_name = {0:'u8',1:'i8',2:'u16',3:'i16',4:'u32',5:'i32',6:'u64',7:'i64',8:'f32',9:'f64',0xA:'str',0xB:'data'}.get(dt, f'?{dt}')
            cv_show = f" = {cv!r}" if sg == 1 else ''
            print(f"  [{i:2d}] storage={sg_name:<12} type={dt_name:<6} name='{name}'{cv_show}")

        print(f"\nAll {len(rows)} TOC entries:")
        for i, row in enumerate(rows):
            fname  = row.get('FileName', row.get('Name', '???'))
            dname  = row.get('DirName',  '')
            foff   = row.get('FileOffset', 0)
            fsz    = row.get('FileSize',   0)
            cfsz   = row.get('ExtractSize', row.get('FileSize', 0))
            full   = f"{dname}/{fname}" if dname else fname
            print(f"  [{i:3d}] '{full}'  off=0x{foff or 0:X}  size={fsz}")
    else:
        print("FAILED to parse TOC table")
        print("Raw bytes:")
        hexdump(toc_raw[:128], base=0x810)

# ==========================================
# 4. Check for ITOC
# ==========================================
itoc_pos = scan_data.find(b'ITOC')
if itoc_pos != -1:
    print("\n" + "="*60)
    print(f"ITOC found at 0x{itoc_pos:X} - parsing:")
    print("="*60)
    with open(CPK_PATH, 'rb') as f:
        f.seek(itoc_pos)
        itoc_hdr = f.read(0x10)
    print(f"Header: {itoc_hdr.hex()}")
    if itoc_hdr[:4] == b'ITOC':
        its = struct.unpack_from('<Q', itoc_hdr, 8)[0]
        with open(CPK_PATH, 'rb') as f:
            f.seek(itoc_pos + 0x10)
            itoc_raw = f.read(its + 8)
        rows, cols = parse_utf(itoc_raw)
        if rows:
            print(f"ITOC: {len(rows)} entries")
            print("Column layout:")
            for name, sg, dt, cv in cols:
                sg_name = {0:'zero', 1:'const', 3:'per-row(3)', 5:'per-row(5)'}.get(sg, f'?{sg}')
                dt_name = {0:'u8',1:'i8',2:'u16',3:'i16',4:'u32',5:'i32',6:'u64',7:'i64',8:'f32',9:'f64',0xA:'str',0xB:'data'}.get(dt, f'?{dt}')
                print(f"  storage={sg_name} type={dt_name} name='{name}'")
            print("Entries:")
            for i, row in enumerate(rows[:30]):
                print(f"  [{i:3d}] {row}")
        else:
            print("FAILED to parse ITOC")

# ==========================================
# 5. Scan for r5a3 / r5a4 / r5a5 strings
# ==========================================
print("\n" + "="*60)
print("SEARCHING FOR r5a3/r5a4/r5a5 REFERENCES IN FIRST 2MB:")
print("="*60)
for target in [b'r5a3', b'r5a4', b'r5a5', b'r5ab', b'r509', b'r530']:
    pos = 0
    found_at = []
    while True:
        p = scan_data.find(target, pos)
        if p == -1: break
        found_at.append(p)
        pos = p + 1
    if found_at:
        print(f"\n  '{target.decode()}' found at offsets: {[hex(x) for x in found_at[:10]]}")
        for p in found_at[:3]:
            ctx = scan_data[max(0,p-8):p+24]
            printable = ''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in ctx)
            print(f"    0x{p:X}: ...{printable}...")
    else:
        print(f"  '{target.decode()}': NOT found in first 2MB")

input("\nAppuie sur Entree pour quitter...")