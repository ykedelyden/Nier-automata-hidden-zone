#!/usr/bin/env python3
"""
NieR: Automata - CPK Content Scanner
Scans CPK archives to find all embedded filenames.
"""

import os
import sys

def extract_strings_from_cpk(filepath, min_length=8):
    game_extensions = ('.wmb', '.col', '.mot', '.eff', '.dat',
                       '.bin', '.xml', '.lua', '.hca', '.sfd', '.acb')
    found = set()
    current_chars = []
    chunk_size = 1024 * 1024  # 1 MB at a time - memory safe

    file_size = os.path.getsize(filepath)
    bytes_read = 0

    with open(filepath, 'rb') as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            bytes_read += len(chunk)
            progress = (bytes_read / file_size) * 100
            print(f"\r  Progress: {progress:.1f}%  ", end='', flush=True)

            for byte in chunk:
                if 0x20 <= byte <= 0x7E:
                    current_chars.append(chr(byte))
                else:
                    if len(current_chars) >= min_length:
                        s = ''.join(current_chars).strip()
                        if any(ext in s for ext in game_extensions):
                            found.add(s)
                    current_chars = []

    print()
    return found

def main():
    # ============================================
    game_data_path = r"D:\steam\steamapps\common\NieRAutomata\data"
    # ============================================

    if not os.path.exists(game_data_path):
        print(f"ERROR: Dossier introuvable: {game_data_path}")
        print("Modifie game_data_path dans le script.")
        input("Appuie sur Entree pour quitter...")
        sys.exit(1)

    cpk_files = sorted([f for f in os.listdir(game_data_path) if f.endswith('.cpk')])
    print(f"Trouves: {len(cpk_files)} fichiers CPK")
    print("On commence par les petits fichiers (plus rapide)")
    print("="*60)

    # Sort by size - small files first to understand naming quickly
    cpk_with_sizes = []
    for cpk in cpk_files:
        path = os.path.join(game_data_path, cpk)
        size = os.path.getsize(path)
        cpk_with_sizes.append((cpk, path, size))
    cpk_with_sizes.sort(key=lambda x: x[2])

    all_files = {}

    for cpk_name, cpk_path, size in cpk_with_sizes:
        size_mb = size / (1024**2)
        print(f"\nScan: {cpk_name} ({size_mb:.0f} MB)...")

        found = extract_strings_from_cpk(cpk_path)

        if found:
            all_files[cpk_name] = sorted(found)
            print(f"  -> {len(found)} references trouvees")
        else:
            print(f"  -> Rien trouve")

    # Save to desktop
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    output_path = os.path.join(desktop, "nier_cpk_contents.txt")

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write("NieR: Automata - Contenu CPK\n")
        f.write("="*60 + "\n\n")
        for cpk_name, files in all_files.items():
            f.write(f"\n=== {cpk_name} ===\n")
            for filename in files:
                f.write(f"  {filename}\n")

    print(f"\n{'='*60}")
    print(f"Resultats sauvegardes sur: {output_path}")
    print(f"Total fichiers references: {sum(len(v) for v in all_files.values())}")
    input("\nAppuie sur Entree pour quitter...")

if __name__ == '__main__':
    main()
