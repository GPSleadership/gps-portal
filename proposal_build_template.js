const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, BorderStyle, WidthType, ShadingType,
  VerticalAlign, PageNumber, LevelFormat, ImageRun, TabStopType
} = require('/tmp/node_modules/docx');
const fs = require('fs');
const dims = JSON.parse(fs.readFileSync('/tmp/logo_dims.json'));

const RED="DB1F48",NAVY="004268",TEAL="01949A",SAND_L="F5F1E8",GY="5C5A54",DK="1A1A18",WH="FFFFFF",BD="D8D6D0";
const PW=12240,PH=15840,MG=1440,CW=9360;
const CB={style:BorderStyle.SINGLE,size:1,color:BD};
const CBORDERS={top:CB,bottom:CB,left:CB,right:CB};
const NO_BORDER={style:BorderStyle.NONE,size:0,color:WH};
const NO_BORDERS={top:NO_BORDER,bottom:NO_BORDER,left:NO_BORDER,right:NO_BORDER};

const TC="/sessions/vibrant-charming-hypatia/mnt/Tool Creation";
const LP="/tmp/logos_processed";

const GPS_LOGO=fs.readFileSync(`${TC}/Copy of Horizontal (4) (3).png`);
const MC_LOGO =fs.readFileSync(`${LP}/mc_planning.png`);
const SWAM    =fs.readFileSync(`${LP}/swam.png`);

// 8 logos → 4 columns × 2 rows, no empty cells
const CLIENTS=[
  {name:"NOAA",          key:"noaa",  data:fs.readFileSync(`${LP}/noaa.png`)},
  {name:"SBA",           key:"sba",   data:fs.readFileSync(`${LP}/sba.png`)},
  {name:"DC DOES",       key:"does",  data:fs.readFileSync(`${LP}/does.png`)},
  {name:"WAEPA",         key:"waepa", data:fs.readFileSync(`${LP}/waepa.png`)},
  {name:"BOEM",          key:"boem",  data:fs.readFileSync(`${LP}/boem.png`)},
  {name:"Environment for the Americas", key:"efta", data:fs.readFileSync(`${LP}/efta.png`)},
  {name:"FAPAC",         key:"fapac", data:fs.readFileSync(`${LP}/fapac.png`)},
  {name:"Montgomery Planning", key:"mc_planning", data:MC_LOGO},
];

const sp=n=>new Paragraph({children:[],spacing:{after:n||200}});
const nl=()=>new Paragraph({spacing:{after:0},children:[]});
function run(t,o={}){return new TextRun({text:t,font:"Arial",size:22,color:DK,...o});}
function body(t,o={}){return new Paragraph({children:[run(t,o)],spacing:{after:160}});}

// keepNext:true keeps section header glued to the paragraph that follows it —
// Word will push both to the next page if they don't fit. pageBreak forces new page.
function sec(label,{pb=false}={}){
  return new Paragraph({
    pageBreakBefore:pb,
    keepNext:true,
    children:[run(label.toUpperCase(),{bold:true,size:22,color:RED})],
    spacing:{before:120,after:160},
    border:{bottom:{style:BorderStyle.SINGLE,size:6,color:RED,space:4}}});
}
function wk(t){return new Paragraph({keepNext:true,children:[run(t,{bold:true,size:22,color:NAVY})],spacing:{before:200,after:100}});}
function bul(t,lv=0){return new Paragraph({numbering:{reference:"bullets",level:lv},children:[run(t)],spacing:{after:100}});}
function bulBold(b,r){return new Paragraph({numbering:{reference:"bullets",level:0},children:[run(b,{bold:true}),run(r)],spacing:{after:100}});}
function thCell(t,w){return new TableCell({borders:CBORDERS,width:{size:w,type:WidthType.DXA},shading:{fill:NAVY,type:ShadingType.CLEAR},margins:{top:100,bottom:100,left:140,right:140},verticalAlign:VerticalAlign.CENTER,children:[new Paragraph({children:[run(t,{bold:true,color:WH,size:20})],spacing:{after:0}})]});}
function tdCell(t,w,bg=WH,bold=false){return new TableCell({borders:CBORDERS,width:{size:w,type:WidthType.DXA},shading:{fill:bg,type:ShadingType.CLEAR},margins:{top:100,bottom:100,left:140,right:140},verticalAlign:VerticalAlign.CENTER,children:[new Paragraph({children:[run(t,{bold,size:20})],spacing:{after:0}})]});}

const numbering={config:[{reference:"bullets",levels:[
  {level:0,format:LevelFormat.BULLET,text:"•",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:720,hanging:360}}}},
  {level:1,format:LevelFormat.BULLET,text:"◦",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:1080,hanging:360}}}},
]}]};

// ── COVER ─────────────────────────────────────────────────────────────────────
const coverChildren=[
  // Logos side by side — GPS left, client right
  new Table({
    width:{size:CW,type:WidthType.DXA},
    columnWidths:[Math.floor(CW/2), Math.floor(CW/2)],
    rows:[new TableRow({children:[
      new TableCell({borders:NO_BORDERS,width:{size:Math.floor(CW/2),type:WidthType.DXA},
        shading:{fill:WH,type:ShadingType.CLEAR},
        margins:{top:0,bottom:0,left:0,right:0},verticalAlign:VerticalAlign.CENTER,
        children:[new Paragraph({alignment:AlignmentType.LEFT,spacing:{after:0},
          children:[new ImageRun({type:"png",data:GPS_LOGO,transformation:{width:252,height:252},
            altText:{title:"GPS Leadership Solutions",description:"GPS Logo",name:"GPSLogo"}})]})]
      }),
      new TableCell({borders:NO_BORDERS,width:{size:Math.floor(CW/2),type:WidthType.DXA},
        shading:{fill:WH,type:ShadingType.CLEAR},
        margins:{top:0,bottom:0,left:0,right:0},verticalAlign:VerticalAlign.CENTER,
        children:[new Paragraph({alignment:AlignmentType.RIGHT,spacing:{after:0},
          children:[new ImageRun({type:"png",data:MC_LOGO,transformation:{width:170,height:127},
            altText:{title:"Montgomery Planning",description:"Client Logo",name:"MCLogo"}})]})]
      }),
    ]})]
  }),

  sp(160),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:240},
    border:{bottom:{style:BorderStyle.SINGLE,size:8,color:RED,space:6}},children:[]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:240},children:[]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:240},children:[]}),

  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:120},
    children:[run("14-Day Executive Succession & Leadership Diagnostic",{bold:true,size:48,color:NAVY})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},children:[]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},
    children:[run("Proposal",{size:28,color:GY,italics:true})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:240},
    children:[run("A targeted 360 process to inform succession planning and strengthen senior leadership at Montgomery County Planning",{size:22,color:GY,italics:true})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},children:[]}),

  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},
    children:[run("Prepared for",{size:22,color:GY,italics:true})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:80},
    children:[run("Montgomery County Planning Department",{bold:true,size:34,color:DK})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:280},
    children:[run("Attn: Robbin Brittingham, Human Resources Manager",{size:22,color:GY})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:60},children:[]}),

  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:60},
    children:[run("Prepared by",{size:20,color:GY})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:60},
    children:[new TextRun({text:"Alex D. Tremble, Founder & CEO",font:"Arial",bold:true})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:60},
    children:[new TextRun({text:"GPS Leadership Solutions, LLC",font:"Arial"})]}),
  new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:160},
    children:[run("Submitted: June 9, 2026  •  Confidential",{size:20,color:RED})]}),
];

// ── TOC ───────────────────────────────────────────────────────────────────────
const tocData=[
  ["Context & Objective",3],
  ["Who This Is For",4],
  ["Process & Timeline",4],
  ["What Each Leader Receives",5],
  ["What HR and the Department Receive",5],
  ["Investment",6],
  ["Next Steps",6],
  ["About GPS Leadership Solutions",7],
  ["Past Clients",7],
];
const tocChildren=[
  sp(200),
  new Paragraph({children:[run("TABLE OF CONTENTS",{bold:true,size:28,color:NAVY})],spacing:{after:80},border:{bottom:{style:BorderStyle.SINGLE,size:8,color:RED,space:8}}}),
  sp(200),
  ...tocData.map(([s,pg],i)=>new Paragraph({
    indent:{left:0,right:0},
    tabStops:[{type:TabStopType.RIGHT,position:CW,leader:"dot"}],
    children:[run(`${i+1}.  `,{bold:true,color:NAVY,size:22}),run(s,{size:22,color:DK}),new TextRun({text:"\t",font:"Arial"}),run(`${pg}`,{size:22,color:GY})],
    spacing:{after:180},
    border:{bottom:{style:BorderStyle.SINGLE,size:2,color:"EBEBEB",space:4}}})),
];

// ── PAST CLIENTS — 4 cols × 2 rows, no borders, proper aspect ratio ───────────
const COLS=4;
const colW=Math.floor(CW/COLS); // 2340 DXA each
const clientRows=[];
for(let i=0;i<CLIENTS.length;i+=COLS){
  const group=CLIENTS.slice(i,i+COLS);
  while(group.length<COLS) group.push(null);
  clientRows.push(new TableRow({children:group.map(c=>{
    if(!c) return new TableCell({borders:NO_BORDERS,width:{size:colW,type:WidthType.DXA},shading:{fill:WH,type:ShadingType.CLEAR},children:[new Paragraph({children:[],spacing:{after:0}})]});
    const d=dims[c.key]||{w:120,h:60};
    return new TableCell({
      borders:NO_BORDERS,
      width:{size:colW,type:WidthType.DXA},
      shading:{fill:WH,type:ShadingType.CLEAR},
      margins:{top:280,bottom:280,left:160,right:160},
      verticalAlign:VerticalAlign.CENTER,
      children:[new Paragraph({alignment:AlignmentType.CENTER,spacing:{after:0},
        children:[new ImageRun({type:"png",data:c.data,transformation:{width:d.w,height:d.h},
          altText:{title:c.name,description:c.name,name:c.name.replace(/\W/g,"")}})]})],
    });
  })}));
}

// ── CONTENT ───────────────────────────────────────────────────────────────────
const contentChildren=[
  sec("Context & Objective"),
  body("This engagement is first and foremost a succession-planning tool: it gives Montgomery County Planning a data-driven view of current senior leadership strengths, risks, and readiness for future roles, while also providing each leader with concrete development support."),
  body("GPS Leadership Solutions has partnered with Montgomery County Planning Department for more than five years. This proposal builds on that relationship with a deeper investment in senior leadership effectiveness and succession planning."),
  nl(),
  body("Montgomery County Planning's senior leaders carry meaningful responsibility: coordinating across divisions, executing on the department's strategic plan, and building trust with internal teams and external stakeholders. Many of these leaders have been promoted from within, often with little formal preparation for the people-leadership side of the role. They are learning to supervise, coach, and hold others accountable while still carrying heavy technical and project loads."),
  nl(),
  body("The challenge is not a lack of talent, it is a lack of visibility and support. Senior leaders rarely have a clear, honest picture of how they are actually experienced by the people above them, alongside them, and beneath them. Without that picture, the behaviors most limiting trust and execution stay invisible and unchanged, and it is difficult to make informed succession decisions."),
  nl(),
  body("The 14-Day Executive Leadership Diagnostic closes that gap. It is a focused, multi-rater (360) process built specifically for senior public-sector leaders. It surfaces behavior-level insight on:"),
  bul("where trust, proactivity, and productivity are strongest,"),
  bul("where they are breaking down, and"),
  bul("what each leader can change over the next 90 days to better support the department's mission and strategic priorities."),
  nl(),
  body("The results provide a concrete foundation for both individual development and succession planning: a shared, data-driven view of current leadership strengths, risks, and readiness for greater responsibility."),
  nl(),
  body("All 90-day development plans will be explicitly aligned with Montgomery County Planning's current strategic plan and priority initiatives. Strategic documents provided in advance will be incorporated so that individual leader development directly supports the department's organizational goals."),
  sp(),
  new Paragraph({children:[run("This proposal is confidential and intended solely for use by the Montgomery County Planning Department.",{italics:true,size:20,color:GY})],spacing:{after:160}}),
  sp(),

  sec("Who This Is For"),
  body("This diagnostic is designed for senior leaders who carry significant people, budget, or strategic responsibility. For this engagement, participants will typically include:"),
  bul("The Department Director and/or Deputy Director"),
  bul("Division chiefs and assistant division chiefs"),
  bul("Senior managers with significant cross-divisional or organizational responsibility"),
  nl(),
  body("Rater groups for each participating leader will be drawn from:"),
  bul("Supervisors (Department Director or Deputy Director, as applicable)"),
  bul("Peer leaders across divisions"),
  bul("Direct reports and key project team members"),
  bul("Critical external collaborators (as appropriate and approved)"),

  sec("Process & Timeline"),
  wk("Week 1 — Design & Onboarding"),
  bul("30–45 minute design call with Robbin Brittingham to confirm objectives, strategic priorities, and any customization"),
  bul("30–45 minute individual onboarding call with each participating leader to:"),
  bul("Clarify their personal goals and current challenges",1),
  bul("Identify and finalize their stakeholder rater lists",1),
  bul("Walk through the process, expectations, and timeline",1),
  nl(),
  wk("Week 2 — Survey Administration"),
  bul("Customized online survey launched to all raters (7-day response window)"),
  bul("Reminder communications sent to maximize response rates"),
  nl(),
  wk("Weeks 2–3 — Optional Stakeholder Interviews"),
  bul("Optional 2–3 confidential stakeholder interviews, conducted by GPS"),
  bul("Used to deepen context and surface themes that may not appear in survey data alone"),
  nl(),
  wk("Weeks 3–4 — Analysis, Reporting & Debriefs"),
  bul("Quantitative and qualitative analysis completed for each leader"),
  bul("Individual Executive Leadership Diagnostic reports drafted"),
  bul("60–90 minute one-on-one virtual debrief with each leader to translate findings into a focused 90-day behavior plan"),
  sp(),

  sec("What Each Leader Receives"),
  body("Each participating leader receives a confidential package designed to produce visible, trackable behavior change:"),
  bulBold("Executive Leadership Diagnostic — ","A focused report on practical leadership behaviors across Trust, Proactivity, and Productivity dimensions, with clear behavioral themes and development priorities."),
  nl(),
  bulBold("90-Day Debrief Session — ","A 60–90 minute one-on-one virtual session with Alex Tremble to interpret results and co-create a clear, realistic action plan tied directly to the leader's role and the department's priorities."),
  nl(),
  bulBold("90-Day Metrics & Stakeholder Tracking — ","During the debrief, each leader selects one primary 90-day leadership goal and a simple metric tied to that goal (for example, a specific meeting behavior, feedback practice, or cadence with their team). The leader then: establishes a numeric baseline, completes short self-ratings over the 90-day period, and gathers quick perception ratings from 2-3 key stakeholders at the start and end of the sprint. This makes behavior change visible over time and allows leaders to see where progress is happening, where it is stalling, and whether they need to adjust their approach."),
  nl(),
  bulBold("GPS Leadership Portal Access — ","Secure access including practical tools and scripts for delegation, accountability, difficult conversations, and other leadership situations; in-the-moment AI support for real leadership challenges; and simple dashboards to log commitments and metrics so leaders can track their 90-day goals without adding extra meetings."),
  nl(),
  bulBold("Follow-Up Communication Tools — ","A structured guide to debrief key raters, plus email and meeting templates to communicate: 'Here is what I heard, here is what I am working on, and here is how you can help.'"),
  nl(),
  body("All 90-day plans will reflect Montgomery County Planning's strategic plan and department priorities."),

  sec("What HR and the Department Receive"),
  body("Montgomery County Planning Department will receive:"),
  bul("An aggregate summary report identifying strengths, risk areas, and recurring themes across the leadership group"),
  bul("An Executive Talent Snapshot that summarizes how each leader is currently experienced and highlights strengths, risks, and readiness indicators to inform succession planning and leadership assignments"),
  bul("Suggested priority areas for future supervisor and leader development, grounded in actual behavioral data from this cohort"),
  sp(160),
  new Paragraph({keepNext:true,children:[run("Optional: Implementation Support Package (6 hours — $1,500)",{bold:true,size:22,color:NAVY})],
    spacing:{before:160,after:100},
    border:{left:{style:BorderStyle.THICK,size:14,color:RED,space:8},top:{style:BorderStyle.SINGLE,size:2,color:BD,space:4},bottom:{style:BorderStyle.SINGLE,size:2,color:BD,space:4}},
    indent:{left:180}}),
  body("Available to ensure findings translate into visible departmental action:"),
  bul("Working sessions with HR to convert diagnostic findings into concrete initiatives"),
  bul("Support drafting internal communications to frame the engagement as performance and trust-building"),
  bul("Guidance and templates for 30/60/90-day check-ins so behavior changes are reinforced and tracked"),

  sec("Investment"),
  body("All fees are fixed-price and include survey design, administration, analysis, individual reporting, and leader debriefs."),
  sp(120),
  new Table({width:{size:CW,type:WidthType.DXA},columnWidths:[2400,1560,1200,4200],rows:[
    new TableRow({tableHeader:true,children:[thCell("Option",2400),thCell("Fee",1560),thCell("Leaders",1200),thCell("Scope",4200)]}),
    new TableRow({children:[tdCell("3-Leader Pilot",2400,WH,true),tdCell("$15,000 flat",1560),tdCell("3",1200),tdCell("Full 14-day diagnostic, individual reports, debriefs, and aggregate summary",4200)]}),
    new TableRow({children:[tdCell("5-Leader Cohort",2400,SAND_L,true),tdCell("$25,000 flat",1560,SAND_L),tdCell("5",1200,SAND_L),tdCell("Same scope for a larger group of senior leaders",4200,SAND_L)]}),
    new TableRow({children:[tdCell("Implementation Support (Optional)",2400,"F7F6F2"),tdCell("$1,500",1560,"F7F6F2"),tdCell("Up to 6 hrs",1200,"F7F6F2"),tdCell("Implementation working sessions with HR and support tools",4200,"F7F6F2")]}),
  ]}),
  nl(),


  sec("Next Steps"),
  body("We are ready to begin within two weeks of contract execution. To move forward:"),
  bul("Confirm your preferred option (3-Leader Pilot or 5-Leader Cohort) and whether you would like to include the Optional Implementation Support Package"),
  bul("GPS Leadership Solutions will deliver a formal service agreement within 2 business days of your confirmation"),
  bul("Upon signed agreement, Alex will schedule the design call with Robbin Brittingham and begin the individual leader onboarding process"),
  nl(),
  body("To confirm or discuss, contact Alex directly:"),
  sp(80),
  new Paragraph({spacing:{after:80},children:[run("Alex D. Tremble, Founder & CEO",{bold:true,size:26,color:RED})]}),
  new Paragraph({spacing:{after:60},children:[run("Cell: 515-822-9372",{size:22})]}),
  new Paragraph({spacing:{after:60},children:[run("Email: Alex@GPSLeadership.org",{size:22})]}),
  new Paragraph({spacing:{after:0},children:[run("GPSLeadership.org",{size:22,color:RED,bold:true})]}),

  // "About GPS" forced to new page since it was orphaning at bottom
  sec("About GPS Leadership Solutions"),
  nl(),
  body("Founded in 2013, GPS Leadership Solutions, LLC is a specialized executive leadership firm focused on helping senior leaders build high-trust, high-performance teams that execute under real pressure. We design and deliver executive coaching, executive retreats, multi-day team alignment workshops, and leadership operating-system installations for organizations of all sizes, including federal agencies."),
  nl(),
  body("Our work is anchored in two proprietary frameworks:"),
  bulBold("TP3™ (Trust → Proactivity → Productivity) — ","A behavior-driven model that links how leaders show up to execution speed, ownership, and results."),
  nl(),
  bulBold("4C Connection Model™ — ","Mindset Change, Internal Clarity, External Clarity, Behavioral Choice. The backbone of how we help leaders move from insight to consistent behavior."),
  nl(),
  body("GPS has delivered tailored leadership work across the federal government, including the Department of Veterans Affairs (VA), Department of Defense (DoD — WHS and DCSA), Department of Homeland Security (DHS), Department of Commerce (NOAA), Department of the Interior (AVSO and NPS), Department of Agriculture (USFS), FEMA, SBA, HUD, and The White House — Office of Management and Budget (OMB). GPS has also advised leaders at Microsoft, Pfizer, Wiley, and Navy Federal Credit Union."),
  nl(),
  body("GPS has been a trusted partner of Montgomery County Planning Department for more than five years. Our work is measured by one standard: did leader behavior change in ways that improve trust, proactivity, and productivity for the organization?"),
  nl(),
  new Paragraph({children:[run("GPS Leadership Solutions, LLC  •  SBA-Certified Small Business  •  Minority-Owned Firm  •  SWaM Certified — Virginia DSBSD",{size:18,color:GY,italics:true})],spacing:{after:160}}),
  new Paragraph({spacing:{after:200},children:[new ImageRun({type:"png",data:SWAM,transformation:{width:220,height:85},altText:{title:"SWaM Certified",description:"Virginia SWaM Certified",name:"SWaMBadge"}})]}),

  // Past Clients — forced to new page so all logos land together
  sec("Past Clients"),
  body("GPS has served government agencies, federal departments, and mission-driven organizations across the United States. A selection of the organizations we have partnered with:"),
  sp(120),
  new Table({
    width:{size:CW,type:WidthType.DXA},
    columnWidths:[colW,colW,colW,colW],
    rows:clientRows,
  }),
  sp(120),
  new Paragraph({children:[run("Client names and logos used with permission.",{size:18,color:GY,italics:true})],spacing:{after:160}}),
  nl(),
];

// ── HEADER — text only, teal underline ────────────────────────────────────────
const contentHeader=new Header({children:[new Paragraph({
  children:[
    run("GPS Leadership Solutions, LLC",{bold:true,size:18,color:TEAL}),
    run("   |   14-Day Executive Succession & Leadership Diagnostic   |   Confidential",{size:18,color:GY}),
  ],
  border:{bottom:{style:BorderStyle.SINGLE,size:4,color:TEAL,space:6}},
  spacing:{after:0},
})]});

const contentFooter=new Footer({children:[new Paragraph({
  alignment:AlignmentType.CENTER,
  border:{top:{style:BorderStyle.SINGLE,size:4,color:BD,space:4}},
  spacing:{before:80},
  children:[run("Page ",{size:18,color:GY}),new TextRun({children:[PageNumber.CURRENT],font:"Arial",size:18,color:GY}),run("  •  GPS Leadership Solutions, LLC  •  GPSLeadership.org",{size:18,color:GY})],
})]});

const coverProps  ={page:{size:{width:PW,height:PH},margin:{top:MG,right:MG,bottom:MG,left:MG}}};
const contentProps={page:{size:{width:PW,height:PH},margin:{top:1900,right:MG,bottom:MG,left:MG,header:640}}};

const doc=new Document({
  numbering,
  styles:{default:{document:{run:{font:"Arial",size:22,color:DK}}}},
  sections:[
    {properties:coverProps,children:coverChildren},
    {properties:coverProps,children:tocChildren},
    {properties:contentProps,headers:{default:contentHeader},footers:{default:contentFooter},children:contentChildren},
  ],
});

const out=`${TC}/Montgomery_County_Planning_14Day_Diagnostic_Proposal.docx`;
Packer.toBuffer(doc).then(buf=>{
  fs.writeFileSync(out,buf);
  console.log(`Done: ${out} (${(buf.length/1024).toFixed(0)} KB)`);
}).catch(e=>{console.error(e);process.exit(1);});
