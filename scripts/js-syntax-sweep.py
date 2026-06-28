#!/usr/bin/env python3
"""
js-syntax-sweep.py — GPS Portal pre-commit JS safety check

Scans inside <script> blocks of HTML files for the apostrophe patterns
that have crashed the portal twice. These patterns are unambiguous —
zero false positives — so the sweep can block commits without noise.

  Pattern 1: +''word     — empty-string concatenation before a word
             The '' creates an empty string; the word after it is a bare
             identifier. This is always a possessive/contraction bug, e.g.:
               BAD:  '+esc(first)+''s supervisor:'
               GOOD: '+esc(first)+"'s supervisor:"

  Pattern 2: esc(VAR)+''word  — same bug specifically after an esc() call
             This is the GPS portal's highest-risk form because firstName
             and name values appear constantly in the HTML templates.

The script does NOT attempt broad heuristic matching (contractions, etc.)
because those generate too many false positives on legitimate JS patterns
like ternaries: (flag ? 'yes' : 'no'). The two patterns above are what
you want to catch — they're the ones that have actually caused production
outages.

Usage:
  # Before staging — check only files you changed:
  python3 scripts/js-syntax-sweep.py decision-room.html

  # Check all staged HTML files (add to pre-commit habit):
  python3 scripts/js-syntax-sweep.py $(git diff --name-only | grep '\.html$')

  # Check everything tracked:
  python3 scripts/js-syntax-sweep.py $(git ls-files '*.html')

Exit 0 = clean. Exit 1 = problem found. Commit only on exit 0.
"""

import sys, re, os

# ── Patterns — UNAMBIGUOUS only (no false positives) ──────────────────────
# Each: (compiled_regex, short_label, fix_hint)
PATTERNS = [
    (
        re.compile(r"\+''\w"),
        "apostrophe trap: +'' before word",
        (
            "+''{word} creates an empty string '' then a bare identifier — "
            "the parser sees the '' closing the surrounding string and {word} as unexpected.\n"
            "     Fix: switch the possessive/contraction to double-quotes.\n"
            "     BAD:  '+esc(first)+''s role'\n"
            "     GOOD: '+esc(first)+\"'s role\""
        ),
    ),
    (
        re.compile(r"esc\([^)]+\)\s*\+\s*''\w"),
        "apostrophe trap: esc(VAR)+'' before word",
        (
            "esc(VAR)+''word is the GPS portal's highest-risk form of this bug.\n"
            "     The '' terminates the surrounding string and the word after it is bare.\n"
            "     Fix: esc(VAR)+\"'s \" (double-quote the possessive segment).\n"
            "     BAD:  '+esc(first)+''s supervisor: '\n"
            "     GOOD: '+esc(first)+\"'s supervisor: \""
        ),
    ),
]


def get_script_line_indices(lines):
    """Return set of 0-indexed line positions that are inside <script> blocks."""
    inside = False
    indices = set()
    for i, line in enumerate(lines):
        if re.search(r'<script(?:\s[^>]*)?>', line, re.IGNORECASE):
            inside = True
        if inside:
            indices.add(i)
        if '</script>' in line.lower():
            inside = False
    return indices


def sweep(filepath):
    issues = []
    try:
        with open(filepath, encoding='utf-8', errors='replace') as f:
            content = f.read()
    except OSError as e:
        return [f'  Cannot read {filepath}: {e}']

    lines = content.splitlines()
    script_indices = get_script_line_indices(lines)

    for i, line in enumerate(lines):
        if i not in script_indices:
            continue
        for pat, label, hint in PATTERNS:
            m = pat.search(line)
            if m:
                snippet = line.strip()
                # Underline the match position within the snippet
                match_start = line.index(line.strip()[0]) if line.strip() else 0
                rel = m.start() - match_start
                underline = ' ' * max(0, rel) + '^' * max(1, m.end() - m.start())
                issues.append(f'\n  {filepath}:{i + 1}  ❌  {label}')
                issues.append(f'  {snippet[:120]}')
                issues.append(f'  {underline}')
                issues.append(f'  ↳ {hint}')
                break  # one issue per line is enough

    return issues


def main():
    files = [f for f in sys.argv[1:] if f.strip()]
    if not files:
        print(__doc__)
        sys.exit(1)

    all_issues = []
    checked = 0
    for path in files:
        if not os.path.isfile(path):
            print(f'  [skip] {path} not found')
            continue
        all_issues.extend(sweep(path))
        checked += 1

    if all_issues:
        print('\n🚫  JS SYNTAX SWEEP FAILED\n')
        print('\n'.join(all_issues))
        print(f'\n  Fix the issues above, then re-run before committing.')
        print(f'  ({checked} file(s) checked)\n')
        sys.exit(1)
    else:
        print(f'✅  JS syntax sweep passed — {checked} file(s) clean.')
        sys.exit(0)


if __name__ == '__main__':
    main()
