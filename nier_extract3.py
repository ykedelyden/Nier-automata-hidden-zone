#!/usr/bin/env python3
"""
NieR: Automata - Tower Secret Extractor v3
Targets data012.cpk (st5/ zone files) and data100.cpk (M5095 dialogues).
Extracts r5a3/r5a4/r5a5 and all related hidden Tower zone files.
"""
import struct, os, json

GAME_PATH = r"D:\steam\steamapps\common\NieRAutomata\data"
OUT_DIR   = os.path.join(os.path.expanduser("~"), "Desktop", "nier_tower_analysis")

# ===== @UTF parser =====
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
    with open(cpk_path, 'rb') as f:
        chunk = f.read(65536)
    pos = chunk.find(b'TOC ')
    if pos == -1: return None
    with open(cpk_path, 'rb') as f:
        f.seek(pos)
        th = f.read(0x10)
    if th[:4] != b'TOC ': return None
    ts = struct.unpack_from('<Q', th, 8)[0]
    with open(cpk_path, 'rb') as f:
        f.seek(pos + 0x10)
        toc_raw = f.read(ts + 8)
    return parse_utf(toc_raw)

def extract_file(cpk_path, toc_rows, fname):
    """Extract file from CPK by FileName (ignores DirName)."""
    for r in toc_rows:
        if r.get('FileName') == fname:
            off = r.get('FileOffset', 0)
            sz  = r.get('FileSize', 0)
            if isinstance(off, tuple): off = off[0]
            if off and sz:
                with open(cpk_path, 'rb') as f:
                    f.seek(off); return f.read(sz)
    return None

def hexdump(data, base=0):
    lines = []
    for i in range(0, len(data), 16):
        chunk = data[i:i+16]
        h = ' '.join(f'{b:02X}' for b in chunk)
        a = ''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in chunk)
        lines.append(f"  {base+i:06X}: {h:<48}  {a}")
    return '\n'.join(lines)

def parse_dat(data):
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

def parse_dtt(data):
    """DTT is the same DAT format but for textures."""
    return parse_dat(data)

def analyze_strings(data):
    """Extract printable strings >= 5 chars."""
    strs, cur = [], []
    for b in data:
        if 0x20 <= b <= 0x7E:
            cur.append(chr(b))
        else:
            s = ''.join(cur)
            if len(s) >= 5: strs.append(s)
            cur = []
    s = ''.join(cur)
    if len(s) >= 5: strs.append(s)
    return list(dict.fromkeys(strs))

def analyze_coords(data):
    coords = set()
    for i in range(0, len(data)-11, 4):
        try:
            x = struct.unpack_from('<f', data, i)[0]
            y = struct.unpack_from('<f', data, i+4)[0]
            z = struct.unpack_from('<f', data, i+8)[0]
            if all(-50000 < v < 50000 and abs(v) > 0.001 for v in (x,y,z)):
                if not any(abs(v) > 40000 for v in (x,y,z)):
                    coords.add((round(x,2), round(y,2), round(z,2)))
        except: pass
    return sorted(coords)

# ==========================================
os.makedirs(OUT_DIR, exist_ok=True)
report_lines = []

def rpt(s):
    print(s)
    report_lines.append(s)

rpt("=" * 70)
rpt("  NieR: Automata - Tower Secret Extractor v3")
rpt("=" * 70)

# ==========================================
# PART A: Extract from data012.cpk
# ==========================================
CPK12 = os.path.join(GAME_PATH, 'data012.cpk')
rpt(f"\n[A] Parsing data012.cpk...")
toc12 = get_toc(CPK12)
if not toc12:
    rpt("  FAILED")
else:
    rpt(f"  TOC: {len(toc12)} entries")

    # Files we care about from data012.cpk
    TARGETS_12 = [
        ('r5a3.dat', True),   # (filename, is_important)
        ('r5a3.dtt', False),
        ('r5a4.dat', True),
        ('r5a4.dtt', False),
        ('r5a5.dat', True),
        ('r5a5.dtt', False),
        ('r5ab.dat', True),
        ('r5ab.dtt', False),
        ('r509.dat',  True),
        ('r5a0.dat', False),  # reference: known working zone
    ]

    sub_dir = os.path.join(OUT_DIR, 'data012')
    os.makedirs(sub_dir, exist_ok=True)

    for fname, important in TARGETS_12:
        raw = extract_file(CPK12, toc12, fname)
        if raw is None:
            rpt(f"\n  [{fname}] NOT FOUND")
            continue

        out_path = os.path.join(sub_dir, fname)
        with open(out_path, 'wb') as f: f.write(raw)

        magic = raw[:4].hex() if len(raw) >= 4 else '??'
        magic_s = raw[:4].decode('latin-1') if len(raw) >= 4 else '??'
        rpt(f"\n  [{fname}]  {len(raw):,} bytes  magic={magic} ('{magic_s}')")

        # Always hexdump small files
        if len(raw) <= 256:
            rpt(f"  --- FULL HEXDUMP ---")
            rpt(hexdump(raw))

        # Parse as DAT container
        sub_files = parse_dat(raw)
        if sub_files is not None:
            rpt(f"  DAT container: {len(sub_files)} sub-files")
            for sf in sub_files:
                sname = sf['name'] or f"noname_{sf['off']:08x}"
                sext  = sf['ext']  or 'bin'
                rpt(f"    [{sext.upper():5}] '{sname}'  {sf['size']:,} bytes")

                sf_path = os.path.join(sub_dir, f"{fname}_{sname}.{sext}")
                with open(sf_path, 'wb') as f: f.write(sf['data'])

                if sf['size'] <= 128 and sf['size'] > 0:
                    rpt(f"    hexdump:")
                    rpt(hexdump(sf['data'], base=sf['off']))

                strs = analyze_strings(sf['data'])
                file_refs = [s for s in strs if any(e in s for e in ['.wmb','.col','.bin','.mot','.eff','.dat','.bxm','.xml','.scp','.evt','.nef','.wta','.wtp'])]
                other_strs = [s for s in strs if s not in file_refs and len(s) >= 6][:20]
                coords = analyze_coords(sf['data'])

                if file_refs:
                    rpt(f"    file refs : {file_refs[:10]}")
                if other_strs:
                    rpt(f"    strings   : {other_strs[:8]}")
                if coords:
                    rpt(f"    coords    : {coords[:10]}")
        else:
            # Not a DAT — analyze directly
            strs = analyze_strings(raw)
            file_refs = [s for s in strs if any(e in s for e in ['.wmb','.col','.bin','.mot','.eff','.dat','.bxm','.xml','.scp','.evt','.nef','.wta','.wtp'])]
            other_strs = [s for s in strs if s not in file_refs and len(s) >= 6][:25]
            coords = analyze_coords(raw)

            if important or file_refs or other_strs:
                if file_refs:   rpt(f"  file refs : {file_refs[:10]}")
                if other_strs:  rpt(f"  strings   : {other_strs[:8]}")
                if coords:      rpt(f"  coords    : {coords[:8]}")
                if not file_refs and not other_strs and not coords:
                    rpt(f"  (no readable strings or coords found)")

# ==========================================
# PART B: Read M5095 dialogue files from data100.cpk
# ==========================================
CPK100 = os.path.join(GAME_PATH, 'data100.cpk')
rpt(f"\n\n{'=' * 70}")
rpt("[B] M5095 DIALOGUE FILES from data100.cpk:")
rpt("=" * 70)

toc100 = get_toc(CPK100)
if toc100:
    m5095_files = [r for r in toc100
                   if 'M5095' in str(r.get('FileName','')) and '_eng' in str(r.get('FileName',''))]
    m5095_files.sort(key=lambda r: r.get('FileName',''))

    dlg_dir = os.path.join(OUT_DIR, 'dialogue_M5095')
    os.makedirs(dlg_dir, exist_ok=True)

    for row in m5095_files:
        fname = row.get('FileName','')
        off   = row.get('FileOffset', 0)
        sz    = row.get('FileSize', 0)
        if isinstance(off, tuple): off = off[0]
        if not off or not sz: continue

        with open(CPK100, 'rb') as f:
            f.seek(off)
            raw = f.read(sz)

        out_path = os.path.join(dlg_dir, fname)
        with open(out_path, 'wb') as f: f.write(raw)

        try:
            # Try various encodings
            for enc in ('utf-8', 'utf-16', 'shift-jis', 'latin-1'):
                try:
                    text = raw.decode(enc).strip()
                    break
                except: text = None
            if text:
                rpt(f"\n  [{fname}] ({sz} bytes):")
                for line in text.splitlines()[:20]:
                    if line.strip():
                        rpt(f"    {line}")
        except: pass

    # Also get all M5095 filenames (all languages)
    all_m5095 = sorted(set(r.get('FileName','') for r in toc100 if 'M5095' in str(r.get('FileName',''))))
    rpt(f"\n  All M5095 files: {all_m5095}")

# ==========================================
# PART C: Extract r5ac.dat from data100.cpk (the large hidden zone file)
# ==========================================
rpt(f"\n\n{'=' * 70}")
rpt("[C] r5ac.dat from data100.cpk (136KB - special zone):")
rpt("=" * 70)

if toc100:
    raw_r5ac = extract_file(CPK100, toc100, 'r5ac.dat')
    if raw_r5ac:
        out_path = os.path.join(OUT_DIR, 'data100_r5ac.dat')
        with open(out_path, 'wb') as f: f.write(raw_r5ac)
        rpt(f"  {len(raw_r5ac):,} bytes  magic={raw_r5ac[:4].hex()}")
        sub = parse_dat(raw_r5ac)
        if sub:
            rpt(f"  DAT: {len(sub)} sub-files")
            for sf in sub:
                strs = analyze_strings(sf['data'])
                file_refs = [s for s in strs if any(e in s for e in ['.wmb','.col','.bin','.mot','.scp','.evt','.bxm'])]
                rpt(f"    [{sf['ext'].upper():5}] '{sf['name']}'  {sf['size']:,} bytes")
                if file_refs: rpt(f"      refs: {file_refs[:8]}")
        else:
            strs = analyze_strings(raw_r5ac)
            file_refs = [s for s in strs if any(e in s for e in ['.wmb','.col','.bin','.mot','.scp','.evt'])]
            other_strs = [s for s in strs if s not in file_refs and len(s)>=6][:20]
            rpt(f"  Not a DAT")
            if file_refs: rpt(f"  refs: {file_refs[:10]}")
            if other_strs: rpt(f"  strings: {other_strs[:10]}")

# ==========================================
# Save full report
# ==========================================
rpt_path = os.path.join(OUT_DIR, "tower_secret_report.txt")
with open(rpt_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(report_lines))

rpt(f"\n{'=' * 70}")
rpt(f"Done. Files in: {OUT_DIR}")
rpt(f"Full report: {rpt_path}")
input("\nAppuie sur Entree pour quitter...")