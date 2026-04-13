#!/usr/bin/env python3
"""
NieR: Automata - Full CPK Scanner v4
1. Lists ALL CPK files in the data folder
2. Scans every CPK's TOC for any r5xx files
3. Extracts core/core.dat and st1/r120.dat from data002.cpk
4. Searches inside DAT containers for r5a3/r5a4/r5a5 references
"""
import struct, os, sys

GAME_PATH = r"D:\steam\steamapps\common\NieRAutomata\data"
OUT_DIR   = os.path.join(os.path.expanduser("~"), "Desktop", "nier_tower_analysis")

# ===== @UTF parser (confirmed working) =====
TYPE_SIZES = {0:1, 1:1, 2:2, 3:2, 4:4, 5:4, 6:8, 7:8, 8:4, 9:8, 0xA:4, 0xB:8}

def cstr(data, pos):
    end = data.find(b'\x00', pos)
    return data[pos: end if end != -1 else pos+256].decode('utf-8', errors='replace')

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
        return None
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
    return rows

def get_toc(cpk_path):
    """Parse CPK TOC via scan fallback (works for all NieR CPKs)."""
    with open(cpk_path, 'rb') as f:
        chunk = f.read(65536)
    pos = chunk.find(b'TOC ')
    if pos == -1:
        return None
    with open(cpk_path, 'rb') as f:
        f.seek(pos)
        th = f.read(0x10)
    if th[:4] != b'TOC ':
        return None
    ts = struct.unpack_from('<Q', th, 8)[0]
    with open(cpk_path, 'rb') as f:
        f.seek(pos + 0x10)
        toc_raw = f.read(ts + 8)
    return parse_utf(toc_raw)

def extract_bytes(cpk_path, off, sz):
    with open(cpk_path, 'rb') as f:
        f.seek(off)
        return f.read(sz)

def parse_dat(data):
    """Parse NieR DAT container, return list of sub-files."""
    if len(data) < 24 or data[:4] != b'DAT\x00':
        return None
    n  = struct.unpack_from('<I', data, 4)[0]
    if n == 0 or n > 50000: return None
    oo = struct.unpack_from('<I', data, 8)[0]
    eo = struct.unpack_from('<I', data, 12)[0]
    no = struct.unpack_from('<I', data, 16)[0]
    so = struct.unpack_from('<I', data, 20)[0]
    name_stride = max(((so - no) // n) if (n > 0 and so > no) else 0x20, 4)
    files = []
    for i in range(n):
        try:
            off = struct.unpack_from('<I', data, oo + i*4)[0]
            siz = struct.unpack_from('<I', data, so + i*4)[0]
            ext = data[eo+i*4: eo+i*4+4].rstrip(b'\x00').decode('ascii', errors='?')
            np  = no + i * name_stride
            ne  = data.find(b'\x00', np)
            if ne == -1 or ne - np > name_stride: ne = np + name_stride
            name = data[np:ne].decode('ascii', errors='?').rstrip('\x00')
            sub  = data[off: off+siz] if off > 0 and off+siz <= len(data) else b''
            files.append({'name': name, 'ext': ext, 'off': off, 'size': siz, 'data': sub})
        except: pass
    return files

def search_refs(data, targets):
    """Find target byte strings in data, return list of (offset, context)."""
    results = []
    for t in targets:
        pos = 0
        while True:
            p = data.find(t, pos)
            if p == -1: break
            ctx = data[max(0,p-16):p+32]
            printable = ''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in ctx)
            results.append((p, t.decode(), printable))
            pos = p + 1
    return results

# ==========================================
os.makedirs(OUT_DIR, exist_ok=True)

TARGETS_BYTES = [b'r5a3', b'r5a4', b'r5a5', b'r5a0', b'r5a1', b'r5a2',
                 b'r5a6', b'r5a7', b'r5ab', b'r509', b'r530', b'r5_0']

print("=" * 70)
print("  NieR: Automata - Full CPK Scanner v4")
print("=" * 70)

# ==========================================
# STEP 1: Find all CPK files
# ==========================================
print(f"\n[1] CPK files in {GAME_PATH}:")
cpk_files = sorted(f for f in os.listdir(GAME_PATH) if f.lower().endswith('.cpk'))
for c in cpk_files:
    sz = os.path.getsize(os.path.join(GAME_PATH, c))
    print(f"     {c:<20}  {sz:>12,} bytes")

# ==========================================
# STEP 2: Scan EVERY CPK for r5 files in TOC
# ==========================================
print("\n" + "=" * 70)
print("[2] SCANNING ALL CPKs FOR r5 FILES IN TOC:")
print("=" * 70)

r5_locations = {}  # fname -> [(cpk, full_path, offset, size)]

for cpk_name in cpk_files:
    cpk_path = os.path.join(GAME_PATH, cpk_name)
    rows = get_toc(cpk_path)
    if not rows:
        print(f"  {cpk_name}: FAILED to parse TOC")
        continue
    r5_rows = [r for r in rows if 'r5' in str(r.get('FileName','')).lower()
                                 or 'r5' in str(r.get('DirName','')).lower()]
    if r5_rows:
        print(f"\n  {cpk_name} ({len(rows)} entries total):")
        for r in r5_rows:
            fn  = r.get('FileName', '?')
            dn  = r.get('DirName', '')
            off = r.get('FileOffset', 0)
            sz  = r.get('FileSize', 0)
            full = f"{dn}/{fn}" if dn else fn
            print(f"    '{full}'  offset=0x{off or 0:X}  size={sz:,}")
            if fn not in r5_locations:
                r5_locations[fn] = []
            r5_locations[fn].append((cpk_name, full, off, sz))
    else:
        # Check if any rows mention r5 at all
        total = len(rows)
        sample = [r.get('FileName','') for r in rows[:5]]
        print(f"  {cpk_name}: {total} entries, no r5 matches. Sample: {sample}")

# ==========================================
# STEP 3: Specifically dump data100.cpk r5 files
# ==========================================
print("\n" + "=" * 70)
print("[3] ALL FILES IN data100.cpk:")
print("=" * 70)
cpk100 = os.path.join(GAME_PATH, 'data100.cpk')
if os.path.exists(cpk100):
    rows = get_toc(cpk100)
    if rows:
        print(f"  Total entries: {len(rows)}")
        # Show all entries grouped
        all_fnames = sorted(set(r.get('FileName','') for r in rows))
        print(f"  First 50 filenames (sorted):")
        for fn in all_fnames[:50]:
            print(f"    {fn}")
        if len(all_fnames) > 50:
            print(f"    ... and {len(all_fnames)-50} more")
        # Show r5 files specifically
        r5s = [(r.get('DirName',''), r.get('FileName',''), r.get('FileOffset',0), r.get('FileSize',0))
               for r in rows if 'r5' in str(r.get('FileName','')).lower()]
        if r5s:
            print(f"\n  r5 files in data100.cpk:")
            for dn, fn, off, sz in sorted(r5s):
                print(f"    {dn+'/'+fn if dn else fn}  off=0x{off or 0:X}  size={sz:,}")

# ==========================================
# STEP 4: Extract core.dat and r120.dat, search for r5a3 refs
# ==========================================
print("\n" + "=" * 70)
print("[4] SEARCHING INSIDE data002.cpk CONTAINERS FOR r5 REFERENCES:")
print("=" * 70)
cpk002 = os.path.join(GAME_PATH, 'data002.cpk')
if os.path.exists(cpk002):
    rows = get_toc(cpk002)
    if rows:
        containers_to_check = ['core.dat', 'r120.dat', 'r100.dat', 'coregm.dat']
        for row in rows:
            fn = row.get('FileName', '')
            if fn in containers_to_check:
                off = row.get('FileOffset', 0)
                sz  = row.get('FileSize', 0)
                dn  = row.get('DirName', '')
                if isinstance(off, tuple): off = off[0]
                print(f"\n  Extracting {dn+'/'+fn if dn else fn} ({sz:,} bytes at 0x{off:X})...")
                raw = extract_bytes(cpk002, off, sz)
                if raw[:4] == b'DAT\x00':
                    sub_files = parse_dat(raw)
                    if sub_files:
                        print(f"    DAT container with {len(sub_files)} sub-files")
                        for sf in sub_files:
                            hits = search_refs(sf['data'], TARGETS_BYTES)
                            if hits:
                                print(f"    [MATCH] sub-file '{sf['name']}.{sf['ext']}' ({sf['size']:,} bytes):")
                                for (pos, tag, ctx) in hits[:5]:
                                    print(f"      0x{pos:X}: ...{ctx}...")
                        # Also search the raw DAT header/filename table
                        header_hits = search_refs(raw[:min(len(raw), 100000)], TARGETS_BYTES)
                        if header_hits:
                            print(f"    [MATCH IN DAT HEADER/STRINGS]:")
                            seen = set()
                            for (pos, tag, ctx) in header_hits:
                                if ctx not in seen:
                                    print(f"      0x{pos:X}: ...{ctx}...")
                                    seen.add(ctx)
                    else:
                        print(f"    Not a valid DAT container or empty")
                        raw_hits = search_refs(raw, TARGETS_BYTES)
                        if raw_hits:
                            print(f"    Found {len(raw_hits)} raw reference(s)")
                else:
                    magic = raw[:4].hex() if len(raw) >= 4 else '?'
                    print(f"    Not a DAT (magic={magic}), searching raw...")
                    hits = search_refs(raw, TARGETS_BYTES)
                    if hits:
                        print(f"    Found {len(hits)} reference(s):")
                        seen = set()
                        for (pos, tag, ctx) in hits[:10]:
                            if ctx not in seen:
                                print(f"      0x{pos:X}: ...{ctx}...")
                                seen.add(ctx)
                    else:
                        print(f"    No r5 references found")

# ==========================================
# STEP 5: Full-file scan of data002.cpk for r5a3/r5a4/r5a5
# ==========================================
print("\n" + "=" * 70)
print("[5] FULL FILE SCAN OF data002.cpk (may take ~30 seconds):")
print("=" * 70)
CHUNK = 4 * 1024 * 1024  # 4MB chunks
found_any = False
if os.path.exists(cpk002):
    fsize = os.path.getsize(cpk002)
    with open(cpk002, 'rb') as f:
        offset = 0
        prev_tail = b''
        while offset < fsize:
            chunk = f.read(CHUNK)
            if not chunk: break
            data = prev_tail + chunk
            for target in TARGETS_BYTES:
                pos = 0
                while True:
                    p = data.find(target, pos)
                    if p == -1: break
                    abs_off = offset - len(prev_tail) + p
                    ctx = data[max(0,p-16):p+32]
                    printable = ''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in ctx)
                    print(f"  [{target.decode()}] at abs 0x{abs_off:X}: ...{printable}...")
                    found_any = True
                    pos = p + 1
            prev_tail = chunk[-32:]
            offset += len(chunk)
if not found_any:
    print("  None of the target strings found in data002.cpk")

print("\n" + "=" * 70)
print("Done.")
input("\nAppuie sur Entree pour quitter...")