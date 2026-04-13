#!/usr/bin/env python3
"""
NieR: Automata - CRILAYLA Decompressor v2 (fixed)
Bug fix: use rfind() not find() for CRILAYLA header detection.
Also handles NieR subtitle binary format for M5095 dialogue files.
"""
import struct, os, zlib

GAME_PATH = r"D:\steam\steamapps\common\NieRAutomata\data"
OUT_DIR   = os.path.join(os.path.expanduser("~"), "Desktop", "nier_tower_analysis")

# ===== CPK / @UTF parser (minimal, confirmed working) =====
TYPE_SIZES = {0:1,1:1,2:2,3:2,4:4,5:4,6:8,7:8,8:4,9:8,0xA:4,0xB:8}

def cstr(data, pos):
    end = data.find(b'\x00', pos)
    return data[pos:end if end!=-1 else pos+256].decode('utf-8', errors='replace')

def read_val(data, pos, t, sb, db):
    try:
        if   t==0: return struct.unpack_from('>B',data,pos)[0],pos+1
        elif t==1: return struct.unpack_from('>b',data,pos)[0],pos+1
        elif t==2: return struct.unpack_from('>H',data,pos)[0],pos+2
        elif t==3: return struct.unpack_from('>h',data,pos)[0],pos+2
        elif t==4: return struct.unpack_from('>I',data,pos)[0],pos+4
        elif t==5: return struct.unpack_from('>i',data,pos)[0],pos+4
        elif t==6: return struct.unpack_from('>Q',data,pos)[0],pos+8
        elif t==7: return struct.unpack_from('>q',data,pos)[0],pos+8
        elif t==8: return struct.unpack_from('>f',data,pos)[0],pos+4
        elif t==9: return struct.unpack_from('>d',data,pos)[0],pos+8
        elif t==0xA:
            o=struct.unpack_from('>I',data,pos)[0]; return cstr(data,sb+o),pos+4
        elif t==0xB:
            o=struct.unpack_from('>I',data,pos)[0]; s=struct.unpack_from('>I',data,pos+4)[0]
            return (sb+o,s),pos+8
    except: pass
    return None, pos+TYPE_SIZES.get(t,4)

def parse_utf(raw, base=0):
    if len(raw)<base+32 or raw[base:base+4]!=b'@UTF': return None
    b8=base+8
    ro=struct.unpack_from('>I',raw,base+8)[0]+b8
    so=struct.unpack_from('>I',raw,base+12)[0]+b8
    do=struct.unpack_from('>I',raw,base+16)[0]+b8
    nc=struct.unpack_from('>H',raw,base+24)[0]
    st=struct.unpack_from('>H',raw,base+26)[0]
    nr=struct.unpack_from('>I',raw,base+28)[0]
    p=base+32; cols=[]
    for _ in range(nc):
        f=raw[p];p+=1; sg=(f>>4)&0xF; dt=f&0xF
        no=struct.unpack_from('>I',raw,p)[0];p+=4; cv=None
        if sg==1: cv,p=read_val(raw,p,dt,so,do)
        cols.append((cstr(raw,so+no),sg,dt,cv))
    rows=[]
    for r in range(nr):
        rp=ro+r*st; row={}
        for name,sg,dt,cv in cols:
            if sg==0: row[name]=0
            elif sg==1: row[name]=cv
            elif sg in (3,5): row[name],rp=read_val(raw,rp,dt,so,do)
            else: row[name]=None
        rows.append(row)
    return rows

def get_toc(cpk_path):
    with open(cpk_path,'rb') as f: chunk=f.read(65536)
    pos=chunk.find(b'TOC ');
    if pos==-1: return None
    with open(cpk_path,'rb') as f:
        f.seek(pos); th=f.read(0x10)
    if th[:4]!=b'TOC ': return None
    ts=struct.unpack_from('<Q',th,8)[0]
    with open(cpk_path,'rb') as f:
        f.seek(pos+0x10); toc_raw=f.read(ts+8)
    return parse_utf(toc_raw)

def extract_with_meta(cpk_path, toc_rows, fname):
    for r in toc_rows:
        if r.get('FileName')==fname:
            off=r.get('FileOffset',0); fsz=r.get('FileSize',0)
            xsz=r.get('ExtractSize',0) or fsz
            if isinstance(off,tuple): off=off[0]
            if off and fsz:
                with open(cpk_path,'rb') as f:
                    f.seek(off); return f.read(fsz),fsz,xsz
    return None,0,0

# ===== CRILAYLA Decompressor (FIXED: rfind) =====

def _decompress_bitstream(cmp_data, dec_size):
    """Core CRILAYLA decompression: reads backwards, fills right-to-left."""
    output  = bytearray(dec_size)
    src_idx = len(cmp_data)-1
    bit_pool= 0
    bits_left=0
    underflow = False

    def read_bits(n):
        nonlocal src_idx, bit_pool, bits_left, underflow
        out=0; rem=n
        while rem>0:
            if bits_left==0:
                if src_idx<0:
                    underflow = True
                    return 0
                bit_pool=cmp_data[src_idx]; src_idx-=1; bits_left=8
            take=min(bits_left,rem)
            out=(out<<take)|((bit_pool>>(bits_left-take))&((1<<take)-1))
            bits_left-=take; rem-=take
        return out

    dst=dec_size-1
    while dst>=0:
        if read_bits(1)==1:
            if underflow:
                return None
            output[dst]=read_bits(8); dst-=1
        else:
            ref_offset=read_bits(13)+3
            lc=read_bits(4)
            if underflow:
                return None
            if lc==15:
                length=0
                while True:
                    extra=read_bits(8); length+=extra
                    if underflow:
                        return None
                    if extra!=255: break
                length+=18
            else:
                length=lc+3
            for _ in range(length):
                if dst>=0:
                    src=dst+ref_offset
                    if src >= dec_size:
                        return None
                    output[dst]=output[src]
                    dst-=1
    return bytes(output)

def crilayla_decompress(data, dec_size_hint=None):
    """
    CRILAYLA decompressor with rfind fix.
    Tries (in order):
      1. Header at END of file   (rfind CRILAYLA)
      2. Header at START of file (data[:8]==CRILAYLA)
      3. Raw bitstream           (dec_size_hint from CPK TOC)
    Returns (decompressed_bytes, method_name) or (None, 'FAILED').
    """
    sig=b'CRILAYLA'

    # 1. Header at END (most common NieR CPK format) — use rfind!
    pos=data.rfind(sig)
    if 0<pos<len(data)-8:
        try:
            dec=struct.unpack_from('<I',data,pos+8)[0]
            cmp=struct.unpack_from('<I',data,pos+12)[0]
            if dec>0 and cmp>0 and cmp<=pos:
                cmp_data=data[pos-cmp:pos]
                result=_decompress_bitstream(bytes(cmp_data),dec)
                if result is not None and len(result) == dec:
                    return result, f'header-at-end (sig@{pos}, dec={dec}, cmp={cmp})'
        except: pass

    # 2. Header at START
    if data[:8]==sig:
        try:
            dec=struct.unpack_from('<I',data,8)[0]
            cmp=struct.unpack_from('<I',data,12)[0]
            if dec>0 and cmp>0 and 16+cmp<=len(data):
                cmp_data=data[16:16+cmp]
                result=_decompress_bitstream(bytes(cmp_data),dec)
                if result is not None and len(result) == dec:
                    return result, f'header-at-start (dec={dec}, cmp={cmp})'
        except: pass

    # 3. Raw bitstream + ExtractSize from TOC
    if dec_size_hint and dec_size_hint>0 and dec_size_hint!=len(data):
        try:
            result=_decompress_bitstream(bytes(data),dec_size_hint)
            if result is not None and len(result) == dec_size_hint:
                return result, f'raw-bitstream (dec_size={dec_size_hint})'
        except: pass

    # 4. zlib (for some NieR text files that use zlib)
    for skip in (0,4,8):
        try:
            result=zlib.decompress(data[skip:])
            if result is not None:
                return result, f'zlib (skip={skip})'
        except: pass

    return None, 'FAILED'

# ===== NieR Subtitle Parser =====

def parse_nier_subtitle(data):
    """
    NieR: Automata subtitle binary format.
    Header: entry_count (uint32 LE), then entry_count * 8-byte records,
    then string data (UTF-16 LE or Shift-JIS depending on file).
    """
    lines = []
    if len(data) < 4: return lines

    # The format varies. Try to extract all readable strings.
    # Method 1: Scan for UTF-16 LE strings (each char = 2 bytes, low byte is ASCII, high byte = 0)
    i = 0
    while i < len(data)-1:
        if data[i+1] == 0 and 0x20 <= data[i] <= 0x7E:
            # Possible UTF-16 LE ASCII string start
            start = i
            chars = []
            while i+1 < len(data) and data[i+1] == 0 and 0x20 <= data[i] <= 0x7E:
                chars.append(chr(data[i]))
                i += 2
            s = ''.join(chars)
            if len(s) >= 5:
                lines.append(s)
            continue
        i += 1

    # Method 2: Scan for plain ASCII strings
    cur = []
    for b in data:
        if 0x20 <= b <= 0x7E:
            cur.append(chr(b))
        else:
            s = ''.join(cur)
            if len(s) >= 5 and s not in lines:
                lines.append(s)
            cur = []
    s = ''.join(cur)
    if len(s) >= 5 and s not in lines:
        lines.append(s)

    return list(dict.fromkeys(lines))  # deduplicate preserving order

def hexdump(data, max_bytes=256):
    lines=[]
    for i in range(0,min(max_bytes,len(data)),16):
        chunk=data[i:i+16]
        h=' '.join(f'{b:02X}' for b in chunk)
        a=''.join(chr(b) if 0x20<=b<=0x7E else '.' for b in chunk)
        lines.append(f"  {i:06X}: {h:<48}  {a}")
    if len(data)>max_bytes: lines.append(f"  ... (+{len(data)-max_bytes} bytes)")
    return '\n'.join(lines)

# ==========================================
os.makedirs(OUT_DIR, exist_ok=True)
report=[]

def rpt(s=''):
    print(s); report.append(str(s))

rpt("="*70)
rpt("  NieR: Automata - CRILAYLA Decompressor v2")
rpt("="*70)

# ==========================================
# PART A: Zone files from data012.cpk
# ==========================================
CPK12=os.path.join(GAME_PATH,'data012.cpk')
rpt(f"\n[A] data012.cpk - Zone files")
rpt("="*70)

toc12=get_toc(CPK12)
dec_dir=os.path.join(OUT_DIR,'dec2')
os.makedirs(dec_dir,exist_ok=True)

ZONE_FILES=['r5a3.dat','r5a4.dat','r5a5.dat','r5ab.dat','r509.dat']

if toc12:
    for fname in ZONE_FILES:
        raw,fsz,xsz=extract_with_meta(CPK12,toc12,fname)
        if raw is None:
            rpt(f"\n  [{fname}] NOT FOUND"); continue

        rpt(f"\n  [{fname}]  compressed={fsz:,}  extract={xsz:,}")

        dec,method=crilayla_decompress(raw, xsz if xsz>fsz else None)

        if dec is None:
            rpt(f"  Decompression: FAILED")
            if fsz<=512:
                rpt(f"  Raw hexdump:"); rpt(hexdump(raw,fsz))
            continue

        rpt(f"  Method  : {method}")
        rpt(f"  Dec size: {len(dec):,} bytes")
        rpt(f"  Magic   : {dec[:4].hex()} ('{dec[:4].decode('latin-1')}')")

        # Save
        with open(os.path.join(dec_dir,f"{fname}.dec"),'wb') as f: f.write(dec)

        # If very small, hexdump
        if len(dec)<=512:
            rpt(f"  --- FULL HEXDUMP ---")
            rpt(hexdump(dec,len(dec)))

        # Extract ALL strings from decompressed data
        strs=parse_nier_subtitle(dec)
        file_refs=[s for s in strs if any(e in s for e in ['.wmb','.col','.bin','.mot','.bxm','.eff','.dat','.scp','.evt','.xml','.wtb','.wsp','.sar','.pak','.gad'])]
        field_names=[s for s in strs if s in ['IsEnable','ShapeGroup','CheckPosType','ParentObjId','SetAction','ObjId','UniqueId','ObjName','ObjType','ObjClass','Position','Rotation','Scale','ItemID','SpawnID','MapID','ScriptID','ScriptNo','EventFlag','NomalClear','ClearBit','AreaFlag','FlagNo','name','type','param','id','value','offset','count','size','flag']]
        other=[s for s in strs if s not in file_refs and s not in field_names and len(s)>=5][:25]

        if file_refs:   rpt(f"  File refs : {file_refs}")
        if field_names: rpt(f"  BXM fields: {field_names}")
        if other:       rpt(f"  Strings   : {other}")
        if not strs:    rpt(f"  (no readable strings)")

# ==========================================
# PART B: M5095 dialogue from data100.cpk
# ==========================================
CPK100=os.path.join(GAME_PATH,'data100.cpk')
rpt(f"\n\n{'='*70}")
rpt("[B] data100.cpk - M5095 Dialogue Files")
rpt("="*70)

toc100=get_toc(CPK100)
dlg_dir=os.path.join(OUT_DIR,'dialogue2')
os.makedirs(dlg_dir,exist_ok=True)

if toc100:
    targets=[r for r in toc100 if 'M5095' in str(r.get('FileName',''))
             and ('_eng.txt' in str(r.get('FileName','')) or r.get('FileName','').endswith('_N.txt'))]
    targets.sort(key=lambda r: r.get('FileName',''))

    for row in targets:
        fname=row.get('FileName','')
        off=row.get('FileOffset',0); fsz=row.get('FileSize',0)
        xsz=row.get('ExtractSize',0) or fsz
        if isinstance(off,tuple): off=off[0]
        if not off or not fsz: continue

        with open(CPK100,'rb') as f:
            f.seek(off); raw=f.read(fsz)

        rpt(f"\n  [{fname}]  cmp={fsz}  dec={xsz}")

        dec,method=crilayla_decompress(raw, xsz if xsz>fsz else None)

        if dec is None:
            rpt(f"  Decompression: FAILED")
            rpt(hexdump(raw,min(64,fsz))); continue

        rpt(f"  Method: {method}  →  {len(dec)} bytes")
        with open(os.path.join(dlg_dir,fname+'.dec'),'wb') as f: f.write(dec)

        # Try to decode as text first
        text_found=False
        for enc in ('utf-8','utf-16-le','utf-16','shift-jis'):
            try:
                t=dec.decode(enc)
                printable=sum(1 for c in t if c.isprintable() or c in '\n\r\t')
                if printable>len(t)*0.8 and len(t)>10:
                    rpt(f"  Encoding: {enc}")
                    for line in t.splitlines()[:20]:
                        if line.strip(): rpt(f"  | {line[:200]}")
                    text_found=True; break
            except: pass

        if not text_found:
            # Extract strings from binary
            strs=parse_nier_subtitle(dec)
            meaningful=[s for s in strs if len(s)>=8 and not s.startswith('0x') and s.isascii()]
            if meaningful:
                rpt(f"  Strings:")
                for s in meaningful[:20]:
                    rpt(f"  | {s}")
            else:
                rpt(f"  First 128 bytes:")
                rpt(hexdump(dec,128))
                all_strs=[s for s in strs if len(s)>=4]
                if all_strs: rpt(f"  Short strings: {all_strs[:15]}")

# ==========================================
rpt(f"\n{'='*70}")
rpt("Done.")

rpt_path=os.path.join(OUT_DIR,'dec2_report.txt')
with open(rpt_path,'w',encoding='utf-8') as f: f.write('\n'.join(report))
rpt(f"Report: {rpt_path}")
input("\nAppuie sur Entree pour quitter...")
