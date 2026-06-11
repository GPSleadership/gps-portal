---
name: 14-day-proposal-builder
description: Build a polished branded Word (.docx) proposal for the GPS Leadership 14-Day Executive Leadership Diagnostic. Invoke when Alex says "build a proposal for [client]", "draft a proposal", "create a proposal doc", or provides client details and wants a deliverable to send. Handles government, private sector, trucking/industrial, and non-profit clients. Selects past client logos by client type, calculates pricing at $5,000/leader, and produces a ready-to-send .docx file.
version: 1.0.0
---

# GPS Leadership — 14-Day Diagnostic Proposal Builder (Word Doc)

## When to invoke
Whenever Alex asks to **build, draft, create, or generate a proposal** for the 14-Day Executive Leadership Diagnostic as a Word document (.docx). Triggers include: "build a proposal for [client]", "draft a proposal", "create a proposal doc", "put together a proposal for [name]".

This skill produces a polished, branded `.docx` file using a Node.js build script and the `docx` npm package.

---

## Step 1 — Collect required inputs

Before doing anything else, use `AskUserQuestion` (or ask in chat) to collect:

| Input | Notes |
|---|---|
| **Client full name** | e.g., "Montgomery County Planning Department" |
| **Client short name** | Used inline throughout body, e.g., "Montgomery County Planning" |
| **Contact name** | Primary HR or sponsor contact, e.g., "Robbin Brittingham" |
| **Contact title** | e.g., "Human Resources Manager" |
| **Document title** | Alex provides this, e.g., "14-Day Executive Succession & Leadership Diagnostic" or "14-Day Executive Leadership Diagnostic" |
| **Client type** | `Government`, `Private Sector`, `Trucking/Industrial`, or `Non-Profit` |
| **Number of leaders** | Integer — used to calculate pricing at $5,000/leader |
| **Submission date** | e.g., "June 9, 2026" |
| **Context paragraph(s)** | 2–5 sentences about the client's situation, challenges, and why this engagement matters. Alex provides this in the prompt. |
| **Client logo filename** (optional) | If Alex uploaded a client logo to the Tool Creation folder, the filename (e.g., "acme_logo.png"). Skip if not provided. |
| **Relationship history** (optional) | e.g., "GPS has partnered with [client] for three years." Only include if Alex provides it. If not provided, omit the relationship line entirely. |

**Do not start building until you have at minimum:** client full name, client short name, contact name, contact title, document title, client type, number of leaders, submission date, and context paragraph(s).

---

## Step 2 — Environment setup

Tool Creation folder path: `/Users/alex.tremble/Documents/Claude/Projects/Tool Creation`
(Bash path: `/sessions/[session-id]/mnt/Tool Creation/` — use `ls` to confirm the mount point)

### Install docx if needed
```bash
ls /tmp/node_modules/docx/package.json 2>/dev/null || npm install docx --prefix /tmp
```

### Key asset paths (all inside Tool Creation folder)
- GPS logo: `Copy of Horizontal (4) (3).png`
- SWaM badge: `SWAM_LOGO.jpg`
- Build template: `proposal_build_template.js`
- Logo folders:
  - Government: `Past Client logos/Past Government Clients/`
  - Private Sector: `Past Client logos/Past Private Sector Logos/`
  - Trucking/Industrial: `Past Client logos/Past Trucking & Industrial Logos/` *(if folder doesn't exist yet, fall back to Private Sector folder and prioritize any trucking/industrial logos there)*
  - Non-Profit: `Past Client logos/Past Non Profit Clients/`

---

## Step 3 — Select logos

1. Read all image files from the appropriate logo folder(s) based on client type.
2. **Government** → use `Past Government Clients/` only.
3. **Trucking/Industrial** → use `Past Trucking & Industrial Logos/` first; if fewer than 8 logos, fill remaining slots from `Past Private Sector Logos/`.
4. **Private Sector** → use `Past Private Sector Logos/`.
5. **Non-Profit** → use `Past Non Profit Clients/`.
6. Load up to 8 logos (the past clients grid is 4 columns × 2 rows). If a folder has more than 8 logos, use all of them (grid expands automatically).

### Client logo on cover
- If a client logo filename was provided: look for it in the Tool Creation root folder. Load it for the cover.
- If not found or not provided: place the GPS logo centered or right-aligned on the cover alone (remove the two-column logo table and just place GPS logo right-aligned).

---

## Step 4 — Calculate pricing

```
fee_per_leader = 5000
total_fee = fee_per_leader × number_of_leaders

if number_of_leaders <= 4:
    option_name = f"{number_of_leaders}-Leader Pilot"
else:
    option_name = f"{number_of_leaders}-Leader Cohort"

fee_string = f"${total_fee:,} flat"   # e.g., "$15,000 flat"
```

The pricing table always has three rows:
1. `[option_name]` | `[fee_string]` | `[number_of_leaders]` | "Full 14-day diagnostic, individual reports, debriefs, and aggregate summary"
2. (Remove second option row — only one engagement size per proposal)
3. `Implementation Support (Optional)` | `$1,500` | `Up to 6 hrs` | "Implementation working sessions with HR and support tools"

> **Note:** The Montgomery County template had two options (3-Leader Pilot AND 5-Leader Cohort). For new proposals, show only ONE option (the actual engagement size) plus the Implementation Support row.

---

## Step 5 — Build the proposal

### 5a. Copy the template to a working file
```bash
cp "[TC]/proposal_build_template.js" /tmp/build_proposal.js
```

### 5b. Apply all variable substitutions

Make these replacements in `/tmp/build_proposal.js`:

| Find (from template) | Replace with |
|---|---|
| `Montgomery County Planning Department` | `{CLIENT_FULL_NAME}` |
| `Montgomery County Planning` | `{CLIENT_SHORT_NAME}` |
| `Robbin Brittingham` | `{CONTACT_NAME}` |
| `Human Resources Manager` | `{CONTACT_TITLE}` |
| `14-Day Executive Succession & Leadership Diagnostic` | `{DOCUMENT_TITLE}` |
| `Submitted: June 9, 2026` | `Submitted: {SUBMISSION_DATE}` |
| `Attn: Robbin Brittingham, Human Resources Manager` | `Attn: {CONTACT_NAME}, {CONTACT_TITLE}` |
| `A targeted 360 process to inform succession planning and strengthen senior leadership at Montgomery County Planning` | Update subtitle to match new document title and client |

### 5c. Swap the Context & Objective section

The Context & Objective section is the most client-specific part. Replace the body paragraphs with content built from Alex's context input. Keep the section structure:
- Opening paragraph about the engagement purpose (tailor to client)
- Relationship history paragraph (only if Alex provided history; otherwise omit)
- Description of client's leaders and challenges (use Alex's context)
- "The challenge is not a lack of talent..." paragraph (can keep or adapt)
- The 14-Day Diagnostic description paragraph (keep mostly standard)
- Three bullet points on what it surfaces (keep standard)
- Results paragraph (keep standard)
- 90-day alignment paragraph (keep standard)
- Confidential notice (keep standard, update client name)

### 5d. Update the investment table

Replace the two-option table rows with the single-option calculation from Step 4.

### 5e. Swap logos

Replace the CLIENTS array and logo loading code to use the selected logo folder and files.

For the cover:
- If client logo found: keep the two-column table (GPS left, client right) with the client logo
- If no client logo: replace the logo table with a single centered GPS logo paragraph

### 5f. Update output filename
Change the output path to:
```
[TC]/[ClientShortName_no_spaces]_14Day_Diagnostic_Proposal.docx
```

---

## Step 6 — Run and verify

```bash
node /tmp/build_proposal.js
libreoffice --headless --convert-to pdf "[output_path]" --outdir /tmp/
pdftotext -layout /tmp/[filename].pdf - | awk 'BEGIN{p=1}/\f/{p++;next}{print p": "$0}' | grep -E "^[0-9]+: (CONTEXT|WHO|PROCESS|WHAT EACH|WHAT HR|INVESTMENT|NEXT|ABOUT|PAST)"
pdfinfo /tmp/[filename].pdf | grep Pages
```

Check:
- [ ] Total pages is 7–9 (8 is ideal)
- [ ] Cover content fits on page 1
- [ ] All section headers land on expected pages
- [ ] TOC page numbers match actual pages

---

## Step 7 — Update TOC

Once you know the actual page numbers from Step 6, update the `tocData` array in the build script with correct page numbers and rebuild.

Standard TOC section order:
1. Context & Objective
2. Who This Is For
3. Process & Timeline
4. What Each Leader Receives
5. What HR and the Department Receive
6. Investment
7. Next Steps
8. About GPS Leadership Solutions
9. Past Clients

---

## Step 8 — Present the file

Save the final `.docx` to the Tool Creation folder and present it with `mcp__cowork__present_files`.

---

## Document structure reference

The proposal is built as a 3-section Word document:

**Section 1 — Cover** (no header/footer, full margins)
- Two-column logo table (GPS left, client right) OR GPS logo only
- Red horizontal rule
- 2–3 spacer paragraphs
- Document title (bold, navy, 48pt)
- "Proposal" subtitle (28pt)
- Engagement subtitle line
- "Prepared for" block
- "Prepared by" block
- Submitted date (red, small)

**Section 2 — TOC** (no header/footer, same margins)
- "TABLE OF CONTENTS" heading with red underline
- 9 entries with dot-leader tab stops, right-justified page numbers

**Section 3 — Content** (header + footer, top margin 1900 DXA)
- Header: "GPS Leadership Solutions, LLC | [Document Title] | Confidential" with teal underline
- Footer: centered page number + GPS info with grey top rule
- Sections in order: Context & Objective, Who This Is For, Process & Timeline, What Each Leader Receives, What HR and the Department Receive, Investment, Next Steps, About GPS Leadership Solutions, Past Clients

---

## Brand constants (do not change)
```
RED   = DB1F48    (GPS red — section headers, accents)
NAVY  = 004268    (GPS navy — document title, TOC numbers)
TEAL  = 01949A    (GPS teal — header rule)
GY    = 5C5A54    (GPS grey — secondary text)
DK    = 1A1A18    (GPS dark — body text)
WH    = FFFFFF
SAND  = F5F1E8    (table alternate row)
BD    = D8D6D0    (border grey)
Font  = Arial throughout
Body text size: 22 (11pt)
```

---

## Logo aspect-ratio note

All logos must be pre-processed to correct aspect ratios before insertion. The template includes a Python preprocessing step using Pillow to normalize logos. If any logo fails to load, skip it and continue with remaining logos.

```bash
pip install Pillow --break-system-packages --quiet
python3 << 'EOF'
# [aspect ratio calculation code — see proposal_build_template.js header for full code]
EOF
```

---

## Common issues

| Issue | Fix |
|---|---|
| Cover overflows to page 2 | Reduce spacer paragraphs before document title (currently 2 × after:240) |
| Section header gaps too large | `sec()` function uses `before:120` — reduce further if needed |
| TOC page numbers wrong | Always verify via LibreOffice PDF render before finalizing |
| Logo missing or wrong aspect ratio | Rerun Pillow preprocessing; check file extension matches actual format |
| `docx` not installed | Run `npm install docx --prefix /tmp` |
