#!/usr/bin/env python3
"""
color-guard.py — brand-token ratchet for the GPS Executive Impact System.

Why this exists: the coach console once had 245 near-identical hardcoded colors. We migrated the
bulk to CSS variables (see BRAND_TOKENS.md). This guard makes the sprawl one-directional: it records
the set of raw hex colors currently in a file as a baseline, and on every later run flags any NEW raw
hex that appeared — i.e. a color someone hardcoded instead of using a token. The count can go DOWN
freely (that's cleanup); it can only go UP on purpose (with --update, after you've documented the new
token in BRAND_TOKENS.md).

Usage:
  python3 scripts/color-guard.py coach.html            # check (exit 1 if new raw colors appeared)
  python3 scripts/color-guard.py coach.html --update   # accept current state as the new baseline
  python3 scripts/color-guard.py client.html coach.html # multiple files

Raw hex on a CSS custom-property definition line (`--token: #hex;`) and on the <meta theme-color>
line are IGNORED — those are legitimate single sources, not sprawl.
"""
import sys, os, re, json

HEX = re.compile(r'#[0-9a-fA-F]{6}\b')
DEFLINE = re.compile(r'--[\w-]+\s*:\s*#')
BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.color-baseline.json')


def raw_hexes(path):
    out = {}
    for line in open(path, encoding='utf-8'):
        if 'theme-color' in line or DEFLINE.search(line):
            continue
        for m in HEX.findall(line):
            h = m.lower()
            out[h] = out.get(h, 0) + 1
    return out


def load_baseline():
    if os.path.exists(BASELINE):
        return json.load(open(BASELINE))
    return {}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    update = '--update' in sys.argv
    if not args:
        print('usage: color-guard.py <file.html> [more...] [--update]'); return 2
    base = load_baseline()
    failed = False
    for path in args:
        name = os.path.basename(path)
        cur = raw_hexes(path)
        cur_set = set(cur)
        prev = set(base.get(name, {}).get('hexes', []))
        new = sorted(cur_set - prev)
        gone = len(prev - cur_set)
        total = sum(cur.values())
        print(f"\n{name}: {len(cur_set)} distinct raw hex, {total} uses"
              + (f"  ({gone} retired since baseline)" if gone else ""))
        if base.get(name) is None:
            print("  no baseline yet — run with --update to record one.")
        elif new:
            failed = True
            print(f"  ADDED {len(new)} raw color(s) not in the baseline — use a token from "
                  f"BRAND_TOKENS.md, or add + document a new one, then --update:")
            for h in new:
                print(f"    {h}  ({cur[h]} use(s))")
        else:
            print("  clean — no new raw colors.")
        if update:
            base[name] = {'distinct': len(cur_set), 'hexes': sorted(cur_set)}
    if update:
        json.dump(base, open(BASELINE, 'w'), indent=0)
        print(f"\nBaseline updated: {BASELINE}")
        return 0
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
