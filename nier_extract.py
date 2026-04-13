#!/usr/bin/env python3
"""
NieR: Automata - Tower Secret Analyzer
Extracts and analyzes hidden Tower zones: r5a3, r5a4, r5a5, r5ab, r5ac
"""

import struct, os, sys, json

GAME_PATH  = r"D:\steam\steamapps\common\NieRAutomata\data"
OUT_DIR    = os.path.join(os.path.expanduser("~"), "Desktop", "nier_tower_analysis")

TARGETS = {
    "data002.cpk": ["r5a3.dat", "r5a4.dat", "r5a5.dat", "r5ab.dat", "r530.dat", "r509.dat"],
    "data100.cpk": ["r5ac.dat", "r5a8.dat", "r5a9.dat", "r5aa.dat"],
    "data005.cpk": ["r5a3.eff", "r5a4.eff", "r5a5.eff"],
}

# ===== @UTF Table Parser =====

def cstr(data, pos):
    end = data.find(b'\x00', pos)
    return data[pos: end if end != -1 else pos+512].decode('utf-8', errors='replace')

def read_val(data, pos, t, sb, db):
    try:
        if   t == 0x0: return struct.unpack_from('B',  data, pos)[0], pos+1
        elif t == 0x1: return struct.unpack_from('b',  data, pos)[0], pos+1
        elif t == 0x2: return struct.unpack_from('>H', data, pos)[0], pos+2
        elif t == 0x3: return struct.unpack_from('>h', data, pos)[0], pos+2
        elif t == 0x4: return struct.unpack_from('>I', data, pos)[0], pos+4
        elif t == 0x5: return struct.unpack_from('>i', data, pos)[0], pos+4
        elif t == 0x6: return struct.unpack_from('>Q', data, pos)[0], pos+8
        elif t == 0x7: return struct.unpack_from('>q', data, pos)[0], pos+8
        elif t == 0x8: return struct.unpack_from('>f', data, pos)[0], pos+4
        elif t == 0xA:
            o = struct.unpack_from('>I', data, pos)[0]
            return cstr(data, sb+o), pos+4
        elif t == 0xB:
            o = struct.unpack_from('>I', data, pos)[0]
            s = struct.unpack_from('>I', data, pos+4)[0]
            return (db+o, s), pos+8
    except: pass
    return 0, pos+4

def parse_utf(raw, base=0):
    if len(raw) < base+32 or raw[base:base+4] != b'@UTF':
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
        f  = raw[p]; p += 1
        sg = f & 0x0F
        dt = (f >> 4) & 0x0F
        no = struct.unpack_from('>I', raw, p)[0]; p += 4
        cv = None
        if sg == 1: cv, p = read_val(raw, p, dt, so, do)
        cols.append((cstr(raw, so+no), sg, dt, cv))

    rows = []
    for r in range(nr):
        rp = ro + r * st
        row = {}
        for name, sg, dt, cv in cols:
            if   sg == 0: row[name] = 0
            elif sg == 1: row[name] = cv
            elif sg == 3:
                row[name], rp = read_val(raw, rp, dt, so, do)
            else:
                row[name] = None
        rows.append(row)
    return rows

# ===== CPK Reader =====

def get_toc(cpk_path):
    with open(cpk_path, 'rb') as f:
        hdr = f.read(0x20)
    if hdr[:4] != b'CPK ':
        return None, None

    us = struct.unpack_from('<Q', hdr, 8)[0]
    with open(cpk_path, 'rb') as f:
        f.seek(0x10)
        main_utf = f.read(us + 8)

    rows = parse_utf(main_utf)
    if not rows: return None, None
    info = rows[0]

    toc_off = info.get('TocOffset', 0)
    cnt_off = info.get('ContentOffset', 0)
    if not toc_off: return None, None

    with open(cpk_path, 'rb') as f:
        f.seek(toc_off)
        th = f.read(0x10)
        if th[:4] != b'TOC ': return None, None
        ts = struct.unpack_from('<Q', th, 8)[0]
        toc_utf = f.read(ts + 8)

    toc_rows = parse_utf(toc_utf)
    return toc_rows, cnt_off

def extract_from_cpk(cpk_path, toc_rows, cnt_off, fname):
    for r in toc_rows:
        if r.get('FileName') == fname:
            off = r.get('FileOffset', 0)
            sz  = r.get('FileSize', 0)
            if isinstance(off, tuple): off = off[0]
            elif cnt_off and off < cnt_off: off += cnt_off
            with open(cpk_path, 'rb') as f:
                f.seek(off); return f.read(sz)
    return None

# ===== DAT Container Parser =====

def parse_dat(data):
    if len(data) < 24 or data[:4] != b'DAT\x00':
        return None
    n  = struct.unpack_from('<I', data, 4)[0]
    if n == 0 or n > 10000: return None
    oo = struct.unpack_from('<I', data, 8)[0]
    eo = struct.unpack_from('<I', data, 12)[0]
    no = struct.unpack_from('<I', data, 16)[0]
    so = struct.unpack_from('<I', data, 20)[0]

    # Detect name stride
    if n > 0 and so > no:
        name_stride = (so - no) // n
    else:
        name_stride = 0x20

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
            sub  = data[off: off+siz] if off+siz <= len(data) else b''
            files.append({'name': name, 'ext': ext, 'off': off, 'size': siz, 'data': sub})
        except: pass
    return files

# ===== Binary Analyzer =====

def analyze(data, label):
    result = {
        'label':   label,
        'size':    len(data),
        'magic':   data[:4].hex() if len(data) >= 4 else '',
        'magic_str': data[:4].decode('latin-1') if len(data) >= 4 else '',
    }
    strs, cur = [], []
    for b in data:
        if 0x20 <= b <= 0x7E: cur.append(chr(b))
        else:
            s = ''.join(cur)
            if len(s) >= 5: strs.append(s)
            cur = []
    result['file_refs'] = [s for s in strs if any(e in s for e in ['.wmb','.col','.dat','.bin','.mot','.eff'])]
    result['strings']   = [s for s in strs if len(s) >= 6 and s not in result['file_refs']][:25]

    coords = set()
    for i in range(0, len(data)-11, 4):
        try:
            x = struct.unpack_from('<f', data, i)[0]
            y = struct.unpack_from('<f', data, i+4)[0]
            z = struct.unpack_from('<f', data, i+8)[0]
            if all(-30000 < v < 30000 and abs(v) > 0.5 for v in (x, y, z)):
                coords.add((round(x,1), round(y,1), round(z,1)))
        except: pass
    result['possible_coords'] = list(coords)[:20]
    return result

# ===== Main =====

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    full_report = []

    print("=" * 60)
    print("  NieR: Automata - Tower Secret Analyzer")
    print("=" * 60)

    for cpk_name, targets in TARGETS.items():
        cpk_path = os.path.join(GAME_PATH, cpk_name)
        if not os.path.exists(cpk_path):
            print(f"\n[SKIP] {cpk_name} not found")
            continue

        print(f"\n[CPK] Parsing {cpk_name}...")
        toc, cnt_off = get_toc(cpk_path)
        if not toc:
            print(f"  ERROR: Could not parse TOC - format mismatch?")
            continue
        print(f"  {len(toc)} entries in TOC | ContentOffset=0x{cnt_off:X}")

        for fname in targets:
            print(f"\n  >> {fname}")
            raw = extract_from_cpk(cpk_path, toc, cnt_off, fname)
            if raw is None:
                print(f"     NOT FOUND in TOC")
                continue
            print(f"     Extracted: {len(raw)} bytes  |  magic={raw[:4].hex()}")

            raw_out = os.path.join(OUT_DIR, f"{cpk_name}_{fname}")
            with open(raw_out, 'wb') as f: f.write(raw)

            sub_files = parse_dat(raw)
            zone_entry = {'source': cpk_name, 'file': fname, 'size': len(raw), 'sub_files': []}

            if sub_files:
                print(f"     DAT container: {len(sub_files)} sub-files")
                sub_dir = os.path.join(OUT_DIR, fname.replace('.dat','').replace('.eff',''))
                os.makedirs(sub_dir, exist_ok=True)

                for sf in sub_files:
                    sname = (sf['name'] or f"noname_{sf['off']:08x}")
                    sext  = sf['ext'] or 'bin'
                    sf_path = os.path.join(sub_dir, f"{sname}.{sext}")
                    with open(sf_path, 'wb') as f: f.write(sf['data'])

                    a = analyze(sf['data'], sname)
                    zone_entry['sub_files'].append(a)

                    if a['file_refs'] or a['possible_coords'] or a['strings']:
                        print(f"     [{sext.upper():4}] {sname}")
                        if a['file_refs']:
                            print(f"           refs   : {a['file_refs'][:5]}")
                        if a['strings']:
                            print(f"           strings: {a['strings'][:5]}")
                        if a['possible_coords']:
                            print(f"           coords : {a['possible_coords'][:5]}")
            else:
                a = analyze(raw, fname)
                zone_entry['direct_analysis'] = a
                print(f"     Not a DAT. Direct analysis:")
                if a['file_refs']: print(f"       refs   : {a['file_refs'][:5]}")
                if a['strings']:   print(f"       strings: {a['strings'][:5]}")
                if a['possible_coords']: print(f"       coords : {a['possible_coords'][:5]}")

            full_report.append(zone_entry)

    rpt = os.path.join(OUT_DIR, "tower_analysis.json")
    with open(rpt, 'w', encoding='utf-8') as f:
        json.dump(full_report, f, indent=2, default=str)

    txt_rpt = os.path.join(OUT_DIR, "tower_analysis.txt")
    with open(txt_rpt, 'w', encoding='utf-8') as f:
        f.write("NieR: Automata - Tower Secret Analysis\n")
        f.write("=" * 60 + "\n\n")
        for zone in full_report:
            f.write(f"=== {zone['file']} (from {zone['source']}) ===\n")
            f.write(f"Size: {zone['size']} bytes\n")
            for sf in zone.get('sub_files', []):
                f.write(f"\n  [{sf['label']}]\n")
                if sf['file_refs']:
                    f.write(f"    File refs : {sf['file_refs']}\n")
                if sf['strings']:
                    f.write(f"    Strings   : {sf['strings']}\n")
                if sf['possible_coords']:
                    f.write(f"    Coords    : {sf['possible_coords']}\n")
            da = zone.get('direct_analysis')
            if da:
                f.write(f"  Direct: refs={da['file_refs']} strings={da['strings']} coords={da['possible_coords']}\n")
            f.write("\n")

    print(f"\n{'=' * 60}")
    print(f"Done. Files saved to: {OUT_DIR}")
    print(f"Text report: {txt_rpt}")
    input("\nAppuie sur Entree pour quitter...")

if __name__ == '__main__':
    main()