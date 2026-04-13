#!/usr/bin/env python3
"""
NieR: Automata - CRILAYLA Decompressor + Zone Analyzer
Decompresses r5a3/r5a4/r5a5 scene data and M5095 dialogue files.
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

# ===== CRILAYLA Decompressor =====

def crilayla_decompress(data, dec_size_override=None):
    """
    Decompress CRILAYLA-compressed data.
    Handles:
      - Header-first: file starts with 'CRILAYLA' followed by sizes + compressed data
      - Header-last: CRILAYLA found at some offset, compressed data precedes it
      - Raw bitstream: no embedded header, dec_size provided via dec_size_override
    Returns decompressed bytes or None on failure.
    """
    if not data:
        return None

    # Detect format
    sig = b'CRILAYLA'

    if data[:8] == sig:
        # Standard: header at start
        dec_size = struct.unpack_from('<I', data, 8)[0]
        cmp_size = struct.unpack_from('<I', data, 12)[0]
        cmp_data = data[16:16 + cmp_size]
    else:
        # Look for CRILAYLA signature anywhere in the file
        sig_pos = data.find(sig)
        if sig_pos > 0:
            # Header after compressed data
            dec_size = struct.unpack_from('<I', data, sig_pos + 8)[0]
            cmp_size = struct.unpack_from('<I', data, sig_pos + 12)[0]
            cmp_start = sig_pos - cmp_size
            if cmp_start < 0: cmp_start = 0
            cmp_data = data[cmp_start:sig_pos]
        elif dec_size_override is not None:
            # Raw bitstream, no embedded header
            dec_size = dec_size_override
            cmp_size = len(data)
            cmp_data = data
        else:
            return None  # Can't decompress without knowing output size

    if dec_size == 0:
        return b''

    # Decompress
    return _decompress_bitstream(bytes(cmp_data), dec_size)

def _decompress_bitstream(cmp_data, dec_size):
    """
    Core CRILAYLA LZ77 decompression.
    Reads bits from END of cmp_data going backwards (MSB first).
    Fills output RIGHT to LEFT.
    Final bytes(output) is correctly ordered.
    """
    output = bytearray(dec_size)

    src_idx = len(cmp_data) - 1
    bit_pool = 0
    bits_left = 0

    def read_bits(n):
        nonlocal src_idx, bit_pool, bits_left
        out = 0
        remaining = n
        while remaining > 0:
            if bits_left == 0:
                if src_idx < 0:
                    return out  # underflow
                bit_pool = cmp_data[src_idx]
                src_idx -= 1
                bits_left = 8
            take = min(bits_left, remaining)
            out = (out << take) | ((bit_pool >> (bits_left - take)) & ((1 << take) - 1))
            bits_left -= take
            remaining -= take
        return out

    dst = dec_size - 1  # fill from right to left

    while dst >= 0:
        ctrl = read_bits(1)
        if ctrl == 1:
            # Literal byte
            output[dst] = read_bits(8)
            dst -= 1
        else:
            # Back-reference: read offset then length
            ref_offset = read_bits(13) + 3
            length_code = read_bits(4)
            if length_code == 15:
                # Variable-length extension
                length = 0
                while True:
                    extra = read_bits(8)
                    length += extra
                    if extra != 255:
                        break
                length += 18  # 15 + 3
            else:
                length = length_code + 3

            # Copy: src is at dst + ref_offset (higher index, already filled)
            for _ in range(length):
                if dst >= 0:
                    src = dst + ref_offset
                    output[dst] = output[src] if src < dec_size else 0
                    dst -= 1

    return bytes(output)

# ===== BXM Parser (NieR's Binary XML) =====

def parse_bxm(data):
    """
    Parse NieR: Automata BXM (Binary XML) format.
    Returns a list of (element_name, attributes_dict) or None.
    Handles the two known BXM variants:
      - Magic 0x42584D00 ('BXM\x00') with big-endian header
      - Magic recognized by known field patterns
    """
    if len(data) < 16:
        return None

    # Check for BXM magic
    magic = data[:4]
    if magic not in (b'BXM\x00', b'\x00\x00\x00\x01'):
        # Try to detect by looking for XML node count structure
        pass

    # BXM structure (big-endian):
    # 0x00: magic/version (4 bytes)
    # 0x04: node count (uint16 BE)
    # 0x06: data2 count (uint16 BE) -- attribute blocks
    # 0x08: string table size (uint32 BE)
    # 0x0C: node table offset? or flags
    # String table starts after node/attr tables

    try:
        if magic == b'BXM\x00':
            node_count = struct.unpack_from('>H', data, 4)[0]
            attr_count = struct.unpack_from('>H', data, 6)[0]
            str_size   = struct.unpack_from('>I', data, 8)[0]
        else:
            return None  # Unknown format, fall back to string extraction

        # Node table: 4 bytes per node (string_offset, attr_start, attr_count, flags?)
        node_table_off = 0x10
        attr_table_off = node_table_off + node_count * 4
        data_table_off = attr_table_off + attr_count * 8
        str_table_off  = data_table_off  # BXM uses separate string table
        # Actually string table is right after the data block

        # For now just extract all strings from the string table section
        str_section = data[node_table_off:]
        strs = []
        i = 0
        while i < len(str_section):
            j = str_section.find(b'\x00', i)
            if j == -1: j = len(str_section)
            if j > i:
                s = str_section[i:j]
                if all(0x20 <= b <= 0x7E for b in s):
                    strs.append(s.decode('ascii'))
            i = j + 1
        return strs
    except:
        return None

def extract_all_strings(data, min_len=4):
    """Extract all printable ASCII strings from binary data."""
    strs = []
    cur = []
    for b in data:
        if 0x20 <= b <= 0x7E:
            cur.append(chr(b))
        else:
            if len(cur) >= min_len:
                strs.append(''.join(cur))
            cur = []
    if len(cur) >= min_len:
        strs.append(''.join(cur))
    return list(dict.fromkeys(strs))

def describe_format(data):
    """Identify file format from magic bytes."""
    if len(data) < 4: return "too small"
    magic = data[:4]
    if magic == b'BXM\x00': return "BXM (Binary XML)"
    if magic == b'DAT\x00':  return "DAT container"
    if magic == b'WMB\x00':  return "WMB (World Mesh Binary)"
    if magic == b'COL\x00':  return "COL (Collision)"
    if magic == b'CRILAYLA'[:4]: return "CRILAYLA (still compressed?)"
    if magic[:2] == b'\xff\xfe' or magic[:2] == b'\xfe\xff': return "UTF-16 text"
    if magic[:3] == b'\xef\xbb\xbf': return "UTF-8 BOM text"
    # Check for XML text
    if data[:5] == b'<?xml': return "XML text"
    # Check for readable text
    if all(0x09 <= b <= 0x7E for b in data[:32]): return "ASCII text"
    return f"unknown ({magic.hex()})"

def hexdump(data, base=0, max_bytes=256):
    lines = []
    for i in range(0, min(max_bytes, len(data)), 16):
        chunk = data[i:i+16]
        h = ' '.join(f'{b:02X}' for b in chunk)
        a = ''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in chunk)
        lines.append(f"  {base+i:06X}: {h:<48}  {a}")
    if len(data) > max_bytes:
        lines.append(f"  ... ({len(data) - max_bytes} more bytes)")
    return '\n'.join(lines)

# ===== Extract file from CPK =====

def extract_with_meta(cpk_path, toc_rows, fname):
    """Extract file and return (raw_data, file_size, extract_size)."""
    for r in toc_rows:
        if r.get('FileName') == fname:
            off   = r.get('FileOffset', 0)
            fsz   = r.get('FileSize', 0)
            xsz   = r.get('ExtractSize', 0) or fsz
            if isinstance(off, tuple): off = off[0]
            if off and fsz:
                with open(cpk_path, 'rb') as f:
                    f.seek(off)
                    return f.read(fsz), fsz, xsz
    return None, 0, 0

# ==========================================
os.makedirs(OUT_DIR, exist_ok=True)
report_lines = []

def rpt(s=''):
    print(s)
    report_lines.append(str(s))

rpt("=" * 70)
rpt("  NieR: Automata - CRILAYLA Decompressor + Zone Analyzer")
rpt("=" * 70)

# ==========================================
# PART A: Decompress zone files from data012.cpk
# ==========================================
CPK12 = os.path.join(GAME_PATH, 'data012.cpk')
rpt(f"\n[A] data012.cpk - Zone files for r5a3/r5a4/r5a5/r5ab")
rpt("=" * 70)

toc12 = get_toc(CPK12)
if not toc12:
    rpt("FAILED to read TOC")
else:
    dec_dir = os.path.join(OUT_DIR, 'decompressed')
    os.makedirs(dec_dir, exist_ok=True)

    ZONE_FILES = [
        'r5a3.dat', 'r5a4.dat', 'r5a5.dat',
        'r5ab.dat', 'r509.dat',
        'r5a3.dtt', 'r5a4.dtt', 'r5a5.dtt', 'r5ab.dtt',
    ]

    for fname in ZONE_FILES:
        raw, fsz, xsz = extract_with_meta(CPK12, toc12, fname)
        if raw is None:
            rpt(f"\n  [{fname}] NOT FOUND")
            continue

        compressed = (xsz > fsz)
        rpt(f"\n  [{fname}]")
        rpt(f"    Compressed size : {fsz:,} bytes")
        rpt(f"    Extract size    : {xsz:,} bytes")
        rpt(f"    Is compressed   : {compressed}")

        # Decompress
        dec_size_hint = xsz if compressed and xsz > fsz else None
        decompressed = crilayla_decompress(raw, dec_size_hint)

        if decompressed is None:
            rpt(f"    Decompress      : FAILED (trying raw analysis)")
            decompressed = raw

        rpt(f"    Decompressed    : {len(decompressed):,} bytes")
        rpt(f"    Format          : {describe_format(decompressed)}")

        # Save decompressed file
        out_path = os.path.join(dec_dir, f"{fname}.decompressed")
        with open(out_path, 'wb') as f: f.write(decompressed)

        # Hexdump first 128 bytes for small files
        if len(decompressed) <= 512:
            rpt(f"    --- HEXDUMP ---")
            rpt(hexdump(decompressed, max_bytes=512))

        # Extract strings
        strs = extract_all_strings(decompressed, min_len=4)
        file_refs = [s for s in strs if any(e in s for e in ['.wmb','.col','.bin','.mot','.bxm','.eff','.dat','.scp','.evt','.xml','.wta','.wtp','.wtb','.wsp','.sar','.pak'])]
        xml_names = [s for s in strs if s in ['IsEnable','ShapeGroup','CheckPosType','ParentObjId','SetAction','ObjId','UniqueId','NomalClear','EventFlag','Position','Rotation','Scale','ItemID','SpawnID','MapID','ScriptID','ScriptNo','ObjName','ObjType','ObjClass','name','value','type','param','flag','id','size','offset','count']]
        other_strs = [s for s in strs if s not in file_refs and s not in xml_names and len(s) >= 5 and len(s) <= 60][:20]

        if file_refs:   rpt(f"    File refs : {file_refs[:10]}")
        if xml_names:   rpt(f"    XML names : {xml_names[:15]}")
        if other_strs:  rpt(f"    Strings   : {other_strs[:10]}")
        if not strs:    rpt(f"    (no readable strings)")

        # For BXM: try to show structure
        if decompressed[:4] == b'BXM\x00':
            rpt(f"    --- BXM CONTENT ---")
            bxm_strs = parse_bxm(decompressed)
            if bxm_strs:
                rpt(f"    BXM strings: {bxm_strs[:20]}")

# ==========================================
# PART B: Decompress M5095 dialogue files
# ==========================================
CPK100 = os.path.join(GAME_PATH, 'data100.cpk')
rpt(f"\n\n{'=' * 70}")
rpt("[B] data100.cpk - M5095 Dialogue / Subtitle Files")
rpt("=" * 70)

toc100 = get_toc(CPK100)
if toc100:
    dlg_dir = os.path.join(OUT_DIR, 'dialogue_decompressed')
    os.makedirs(dlg_dir, exist_ok=True)

    # Get all M5095 files (prioritize _eng but also get base _N.txt)
    m5095_targets = [r for r in toc100 if 'M5095' in str(r.get('FileName',''))]
    m5095_targets.sort(key=lambda r: r.get('FileName',''))

    for row in m5095_targets:
        fname = row.get('FileName','')
        # Show only English and base Japanese for readability
        if not (fname.endswith('_N.txt') or fname.endswith('_eng.txt')):
            continue

        off  = row.get('FileOffset', 0)
        fsz  = row.get('FileSize', 0)
        xsz  = row.get('ExtractSize', 0) or fsz
        if isinstance(off, tuple): off = off[0]
        if not off or not fsz: continue

        with open(CPK100, 'rb') as f:
            f.seek(off)
            raw = f.read(fsz)

        rpt(f"\n  [{fname}]  compressed={fsz}  extracted={xsz}")

        # Decompress
        decompressed = crilayla_decompress(raw, xsz if xsz > fsz else None)
        if decompressed is None:
            rpt(f"    DECOMPRESSION FAILED")
            continue

        rpt(f"    Decompressed: {len(decompressed)} bytes")
        rpt(f"    Format: {describe_format(decompressed)}")

        # Save
        out_path = os.path.join(dlg_dir, fname + '.dec')
        with open(out_path, 'wb') as f: f.write(decompressed)

        # Try to read as text
        text = None
        for enc in ('utf-8', 'utf-16-le', 'utf-16-be', 'utf-16', 'shift-jis', 'latin-1'):
            try:
                candidate = decompressed.decode(enc)
                # Must have at least some printable text
                printable = sum(1 for c in candidate if c.isprintable() or c in '\n\r\t')
                if printable > len(candidate) * 0.7:
                    text = candidate
                    rpt(f"    Encoding: {enc}")
                    break
            except:
                pass

        if text:
            rpt(f"    --- TEXT CONTENT ---")
            lines = [l for l in text.splitlines() if l.strip()]
            for line in lines[:30]:
                if line.strip():
                    rpt(f"    {line[:200]}")
        else:
            rpt(f"    Could not decode as text. First 128 bytes:")
            rpt(hexdump(decompressed, max_bytes=128))
            # Extract ASCII strings anyway
            strs = extract_all_strings(decompressed, min_len=5)
            if strs:
                rpt(f"    Strings: {strs[:15]}")

# ==========================================
# PART C: Summary
# ==========================================
rpt(f"\n\n{'=' * 70}")
rpt("[C] SUMMARY OF FINDINGS")
rpt("=" * 70)
rpt("Files processed and saved to: " + os.path.join(OUT_DIR, 'decompressed'))
rpt("Dialogue files saved to: " + os.path.join(OUT_DIR, 'dialogue_decompressed'))

# Save report
rpt_path = os.path.join(OUT_DIR, "decompressed_analysis.txt")
with open(rpt_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(report_lines))
rpt(f"Report: {rpt_path}")

input("\nAppuie sur Entree pour quitter...")