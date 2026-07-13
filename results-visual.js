/* GPS Leadership — shared "Your Results" visual renderer.
 * Single source of truth for the color-coded results page. Used by:
 *   - diagnostic-leader.html  (the leader's own view — voice "you")
 *   - coach.html              (coach private preview — same view the leader sees)
 *   - the manager/Peter view   (top-level, third-person — pass ctx.name)
 *
 * NUMBERS come from the report draft's scores_json (ctx unused for numbers).
 * WORDS (headline, honest read, the two real quotes) come from
 * ctx.diag.results_narrative, authored by the coach. Honest bar scaling:
 * width = (v-1)/4 so 3.0 sits at the midpoint and 4.0 marks the standard.
 * GPS scale: >=4 Strong · 3-3.9 Develop · <=2.9 Serious.
 *
 * Exposes: window.renderGpsResults(scores, ctx)
 *   scores = scores_json object
 *   ctx    = { diag, raters, name }   (all optional)
 */
(function () {
  function _rvCol(v){ if(v==null||isNaN(v)) return '#888780'; if(v>=4) return '#0F6E56'; if(v>=3) return '#C8962F'; return '#A32D2D'; }
  function _rvCls(v){ if(v==null||isNaN(v)) return ''; if(v>=4) return 'sc-g'; if(v>=3) return 'sc-a'; return 'sc-r'; }
  function _rvFmt(v){ return (v==null||isNaN(v)) ? '—' : Number(v).toFixed(2); }
  function _rvBand(v){ if(v==null||isNaN(v)) return ''; if(v>=4) return 'STRONG'; if(v>=3) return 'DEVELOP'; return 'SERIOUS'; }
  function _rvTag(v){ const b=_rvBand(v); if(!b) return ''; const c=(v>=4)?'keep':((v>=3)?'dev':'out'); return `<span class="gps-rv-tag ${c}">${b}</span>`; }
  function _rvW(v){ if(v==null||isNaN(v)) return 0; return Math.max(0,Math.min(100,((Number(v)-1)/4)*100)); }
  function _rvEsc(s){ return (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _rvDate(d,t){ if(!d) return ''; let dt; try{ dt=new Date(d+'T12:00:00'); }catch(e){ return ''; } if(isNaN(dt)) return ''; let s=dt.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'}); if(t) s+=' · '+t; return s; }
  function _rvBar(label, v){
    return `<div class="gps-rv-bar"><div class="top"><span>${label}</span><b class="${_rvCls(v)}">${_rvFmt(v)}</b></div>`
      + `<div class="track"><div class="fill" style="width:${_rvW(v)}%;background:${_rvCol(v)};"></div><div class="mid"></div><div class="target"></div></div></div>`;
  }
  function _rvInjectStyles(){
    if(document.getElementById('gps-rv-styles')) return;
    const css = `
    .gps-rv{--rvnavy:#004369;--rvteal:#01949A;--rvsand:#FDF6EC;--rvink:#1B2A3A;--rvmid:#5F6B7A;--rvline:#E6EBF0;--rvgreen:#0F6E56;--rvamber:#8A560F;--rvbar:#C8962F;--rvred:#A32D2D;--rvredbg:#FCEBEB;color:var(--rvink);}
    .gps-rv .sc-g{color:var(--rvgreen);} .gps-rv .sc-a{color:var(--rvamber);} .gps-rv .sc-r{color:var(--rvred);}
    .gps-rv .gps-rv-tag{display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:5px;margin-left:6px;vertical-align:middle;}
    .gps-rv .gps-rv-tag.keep{background:#EAF5F0;color:#0F6E56;} .gps-rv .gps-rv-tag.dev{background:#FAF1DE;color:#7a4e08;} .gps-rv .gps-rv-tag.out{background:#FCEBEB;color:#8c2020;}
    .gps-rv .rvcard{background:#fff;border:1px solid var(--rvline);border-radius:14px;padding:22px 24px;margin-top:14px;}
    .gps-rv .rvcard h2{margin:0 0 4px;font-size:18px;font-weight:800;color:var(--rvnavy);}
    .gps-rv .rvlabel{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--rvmid);font-weight:700;margin:26px 0 2px;}
    .gps-rv .rvsummary{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:6px;}
    .gps-rv .scard{background:#fff;border:1px solid var(--rvline);border-radius:14px;padding:20px;}
    .gps-rv .scard .t{font-size:13px;font-weight:800;color:var(--rvnavy);text-transform:uppercase;letter-spacing:.04em;}
    .gps-rv .scard .big{font-size:32px;font-weight:800;line-height:1.05;margin:8px 0 6px;}
    .gps-rv .scard .txt{font-size:13px;color:var(--rvink);line-height:1.5;}
    .gps-rv .scard .legend{font-size:11.5px;color:var(--rvmid);margin-top:12px;border-top:1px solid var(--rvline);padding-top:8px;}
    .gps-rv .scard.focus{border-top:4px solid var(--rvbar);} .gps-rv .scard.debrief{border-top:4px solid var(--rvteal);}
    .gps-rv .scard ul{margin:8px 0 0;padding-left:18px;} .gps-rv .scard li{font-size:13px;margin:6px 0;line-height:1.45;}
    .gps-rv .scard .note{font-size:12.5px;color:var(--rvmid);margin-top:10px;font-style:italic;}
    .gps-rv .prepbtn{display:inline-block;margin-top:12px;background:var(--rvteal);color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:8px 16px;border-radius:7px;}
    .gps-rv .gps-rv-bar{margin:12px 0;}
    .gps-rv .gps-rv-bar .top{display:flex;justify-content:space-between;font-size:14px;margin-bottom:5px;} .gps-rv .gps-rv-bar .top b{font-weight:800;}
    .gps-rv .track{position:relative;background:#EEF1F4;border-radius:30px;height:14px;overflow:hidden;}
    .gps-rv .fill{height:100%;border-radius:30px;}
    .gps-rv .mid{position:absolute;top:-3px;bottom:-3px;left:50%;width:2px;background:#6b7682;}
    .gps-rv .target{position:absolute;top:-3px;bottom:-3px;left:75%;width:2px;background:var(--rvgreen);}
    .gps-rv .scalekey{font-size:12px;color:var(--rvmid);text-align:right;margin-top:6px;}
    .gps-rv .read{background:var(--rvsand);border-radius:10px;padding:14px 16px;font-size:14px;color:#3a2e16;line-height:1.55;margin-top:16px;} .gps-rv .read b{font-weight:800;}
    .gps-rv .flags{background:var(--rvredbg);border:1px solid #f0b9b9;border-left:5px solid var(--rvred);border-radius:12px;padding:20px 24px;margin-top:14px;}
    .gps-rv .flags h2{color:var(--rvred);margin:0 0 10px;font-size:17px;font-weight:800;}
    .gps-rv .flag{display:flex;gap:10px;font-size:14px;margin:10px 0;align-items:flex-start;}
    .gps-rv .flag .ic{flex:none;width:10px;height:10px;border-radius:2px;margin-top:5px;background:var(--rvred);}
    .gps-rv .flags .goal{font-size:13px;font-weight:700;color:#8c2020;margin-top:10px;border-top:1px solid #f0b9b9;padding-top:10px;}
    .gps-rv .gtab{width:100%;border-collapse:collapse;font-size:13px;}
    .gps-rv .gtab th{text-align:right;color:var(--rvmid);font-weight:600;padding:7px 6px;border-bottom:2px solid var(--rvline);} .gps-rv .gtab th:first-child{text-align:left;}
    .gps-rv .gtab td{padding:8px 6px;border-bottom:1px solid var(--rvline);text-align:right;font-weight:700;}
    .gps-rv .gtab td:first-child{text-align:left;font-weight:600;color:var(--rvink);}
    .gps-rv .rowflag{background:#FCEBEB;}
    .gps-rv .confnote{font-size:12px;color:var(--rvmid);margin-top:10px;}
    .gps-rv .sowhat{background:var(--rvsand);border-radius:10px;padding:13px 16px;margin:16px 0;font-size:14px;color:#3a2e16;line-height:1.5;}
    .gps-rv .bandgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:4px;}
    .gps-rv .mini{border:1px solid var(--rvline);border-radius:12px;padding:16px 18px;}
    .gps-rv .mini.s{border-top:4px solid var(--rvgreen);} .gps-rv .mini.g{border-top:4px solid var(--rvbar);}
    .gps-rv .mini h3{margin:0 0 10px;font-size:14px;font-weight:800;} .gps-rv .mini.s h3{color:var(--rvgreen);} .gps-rv .mini.g h3{color:var(--rvamber);}
    .gps-rv .item{display:flex;gap:9px;font-size:13.5px;margin:9px 0;} .gps-rv .item .dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;}
    .gps-rv .quote{background:var(--rvsand);border-radius:10px;padding:14px 18px;margin-top:6px;}
    .gps-rv .quote p{margin:0;font-style:italic;font-size:15px;color:#3a2e16;line-height:1.5;} .gps-rv .quote .by{font-size:12px;color:var(--rvmid);margin-top:6px;}
    .gps-rv .qlabel{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--rvmid);font-weight:700;margin:14px 0 0;}
    .gps-rv details.detail{background:#fff;border:1px solid var(--rvline);border-radius:14px;margin-top:14px;overflow:hidden;}
    .gps-rv details.detail>summary{list-style:none;cursor:pointer;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;gap:12px;}
    .gps-rv details.detail>summary::-webkit-details-marker{display:none;}
    .gps-rv details.detail summary .st{font-size:16px;font-weight:800;color:var(--rvnavy);} .gps-rv details.detail summary .ss{font-size:13px;color:var(--rvmid);}
    .gps-rv details.detail summary .chev{color:var(--rvmid);font-size:13px;font-weight:700;white-space:nowrap;}
    .gps-rv details.detail[open] summary .chev::after{content:" ▲";} .gps-rv details.detail:not([open]) summary .chev::after{content:" ▼";}
    .gps-rv .detail-body{padding:0 24px 22px;}
    .gps-rv .qrow{border-top:1px solid var(--rvline);padding:14px 0;} .gps-rv .qrow .q{font-size:14px;font-weight:700;color:var(--rvink);}
    .gps-rv .qscore{font-size:20px;font-weight:800;margin-top:4px;}
    .gps-rv .plan-note{font-size:13px;color:var(--rvink);background:#F7F9FA;border-radius:8px;padding:12px 14px;margin-top:10px;line-height:1.55;} .gps-rv .plan-note b{color:var(--rvnavy);}
    .gps-rv .vs{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--rvline);font-size:14px;} .gps-rv .vs:last-child{border-bottom:none;}
    .gps-rv .vsnote{font-size:13px;color:var(--rvmid);margin:12px 0 0;}
    .gps-rv .prep{background:var(--rvnavy);color:#fff;border-radius:14px;padding:24px 26px;margin-top:14px;}
    .gps-rv .prep h2{color:#fff;font-size:19px;margin:0 0 4px;} .gps-rv .prep .ps{font-size:13px;color:#cfe0ea;margin-bottom:12px;}
    .gps-rv .prep ul{margin:0;padding-left:20px;} .gps-rv .prep li{font-size:14px;margin:9px 0;color:#eaf2f7;}
    .gps-rv .prep .bring{margin-top:14px;font-size:14px;font-weight:800;color:#fff;}
    .gps-rv .rvfoot{text-align:center;color:var(--rvmid);font-size:12px;margin-top:26px;}
    @media(max-width:680px){
      .gps-rv .rvsummary,.gps-rv .bandgrid{grid-template-columns:1fr;}
      .gps-rv .gtab thead{display:none;}
      .gps-rv .gtab,.gps-rv .gtab tbody,.gps-rv .gtab tr,.gps-rv .gtab td{display:block;width:100%;}
      .gps-rv .gtab tr{border:1px solid var(--rvline);border-radius:10px;margin-bottom:10px;padding:6px 10px;}
      .gps-rv .gtab td{text-align:right;border:none;padding:6px 0;}
      .gps-rv .gtab td:first-child{text-align:left;border-bottom:1px solid var(--rvline);margin-bottom:4px;}
      .gps-rv .gtab td::before{content:attr(data-label);float:left;color:var(--rvmid);font-weight:600;}
    }`;
    const st=document.createElement('style'); st.id='gps-rv-styles'; st.textContent=css; document.head.appendChild(st);
  }
  // Group comparison table. Supervisor is ALWAYS shown individually (the manager is
  // not anonymous). Other non-self groups show individually at n>=3; sub-3 groups are
  // n-weighted-merged into "Other colleagues" (shown only if the merge reaches n>=3)
  // so no individual can be identified.
  function _rvGroupTable(bg){
    // Default names. A group the coach renamed carries its own `label` on the
    // by_group row, so the portal always matches the report word-for-word.
    // (The server already suppresses anything under 3, so the n>=3 test below is
    // now a belt-and-braces second line of defence, not the primary one.)
    const LBL={direct_report:'Direct reports',peer:'Peers',internal_partner:'Internal partners',board:'Board members'};
    const named=[]; const merge=[];
    ['direct_report','peer','internal_partner','board'].forEach(k=>{
      const g=bg[k]; if(!g||!g.n) return;
      if(g.n>=3) named.push({k,label:(g.label||LBL[k]||k),g});
      else merge.push(g);
    });
    // The engine's uncategorized cohort ("Other") always joins the combined pool.
    if(bg.other_colleagues && bg.other_colleagues.n) merge.push(bg.other_colleagues);
    let suppressed=0; let otherRow=null;
    if(merge.length){
      const sumN=merge.reduce((a,g)=>a+(g.n||0),0);
      const wavg=(f)=>{ let s=0,n=0; merge.forEach(g=>{ if(g[f]!=null){ s+=g[f]*g.n; n+=g.n; } }); return n?s/n:null; };
      if(sumN>=3) otherRow={k:'other',label:'Other colleagues',g:{n:sumN,trust:wavg('trust'),proactivity:wavg('proactivity'),productivity:wavg('productivity'),tp3:wavg('tp3')}};
      else suppressed=sumN;
    }
    // Supervisor is never anonymous — always its own row.
    const sup = (bg.supervisor && bg.supervisor.n) ? {k:'supervisor',label:'Supervisor',g:bg.supervisor} : null;
    // Order: your team → broad colleagues → your boss → self.
    const rows=[...named];
    if(otherRow) rows.push(otherRow);
    if(sup) rows.push(sup);
    const cell=(v,lbl)=>`<td data-label="${lbl}" class="${_rvCls(v)}">${_rvFmt(v)}</td>`;
    let body=rows.map(r=>{
      const flag=(r.k==='supervisor' && ((r.g.tp3!=null&&r.g.tp3<=2.9)||(r.g.trust!=null&&r.g.trust<=2.9)))?' class="rowflag"':'';
      return `<tr${flag}><td data-label="Group">${r.label} (${r.g.n})</td>${cell(r.g.trust,'Trust')}${cell(r.g.proactivity,'Proactivity')}${cell(r.g.productivity,'Productivity')}${cell(r.g.tp3,'TP3')}</tr>`;
    }).join('');
    const self=bg.self;
    if(self&&self.n) body+=`<tr><td data-label="Group">Self</td>${cell(self.trust,'Trust')}${cell(self.proactivity,'Proactivity')}${cell(self.productivity,'Productivity')}${cell(self.tp3,'TP3')}</tr>`;
    const supShown=rows.some(r=>r.k==='supervisor');
    let note=(supShown?"Your supervisor's ratings are shown directly — your manager stands behind their assessment. ":'')
      +'Groups with fewer than 3 raters are combined so individual responses stay confidential.';
    if(suppressed) note+=` ${suppressed} response${suppressed===1?'':'s'} from smaller groups are included in your overall scores but not broken out.`;
    return { hasRows: rows.length>0 || (self&&self.n), body, note };
  }
  function renderGpsResults(sc, ctx){
    if(!sc) return '';
    ctx = ctx || {};
    _rvInjectStyles();
    const D = ctx.diag || {};
    const N = D.results_narrative || {};
    const bg = sc.by_group || {};
    const tp3 = sc.tp3_index;
    // rater total — completed non-self raters (scores_json rater_count is unreliable)
    const raters = Array.isArray(ctx.raters) ? ctx.raters : [];
    let nR = raters.filter(r=>r.completed_at && !r.is_self).length;
    if(!nR) nR = sc.rater_count || null;
    // lowest non-self group (the relationship gap) + lowest two pillars
    // Default names, used only when the coach has NOT renamed the group. A renamed
    // group carries its label on the by_group row (scores_json), so the portal always
    // says the same thing the report said — never "peers" for a group the report
    // called "Chiefs / Leadership Team".
    const GL={direct_report:'direct reports',peer:'peers',internal_partner:'internal partners',supervisor:'supervisor',board:'board members',other_colleagues:'other colleagues'};
    const glabel=k=>{ const g=bg[k]; return (g&&g.label) ? String(g.label).toLowerCase() : (GL[k]||k); };
    const GKEYS_R=['supervisor','peer','internal_partner','direct_report','board','other_colleagues'];
    let lowG=null;
    GKEYS_R.forEach(k=>{ const g=bg[k]; if(g&&g.n&&g.tp3!=null){ if(!lowG||g.tp3<lowG.tp3) lowG={k,tp3:g.tp3,trust:g.trust,label:glabel(k)}; } });
    let topG=null;
    GKEYS_R.slice().reverse().forEach(k=>{ const g=bg[k]; if(g&&g.n&&g.tp3!=null){ if(!topG||g.tp3>topG.tp3) topG={k,tp3:g.tp3,label:glabel(k)}; } });
    const pills=[['Trust',sc.trust],['Proactivity',sc.proactivity],['Productivity',sc.productivity]].filter(p=>p[1]!=null).sort((a,b)=>a[1]-b[1]);
    const lowP=pills.slice(0,2).map(p=>p[0]);
    const topPill=pills.length?pills[pills.length-1]:null;
    const isSup = lowG && lowG.k==='supervisor';
    const tier = (tp3>=4)?'strong':((tp3>=3)?'develop':'serious');
    const gapPills = pills.filter(p=>p[1]<4).map(p=>p[0]);   // pillars below the 4.0 standard
    const hasGap = (lowG && lowG.tp3!=null && lowG.tp3<4) || gapPills.length>0;

    // ── 1. Three summary cards ──────────────────────────────────────────────
    const headline = N.headline ? `<div class="txt" style="font-weight:800;margin-bottom:4px;">${_rvEsc(N.headline)}</div>` : '';
    const allDev = (sc.trust<4 && sc.proactivity<4 && sc.productivity<4);
    const _foundAuto = tier==='strong'
      ? "You're at or above the 4.0 standard. The focus now is sustaining it and taking on more scope."
      : tier==='serious'
      ? 'Several areas are below the develop range — this calls for a focused 90-day plan, starting now.'
      : (allDev ? 'Workable foundation, but not yet at the 4.0 standard on any pillar.'
                : 'A solid base, with at least one pillar already at the 4.0 standard.');
    const foundation = N.foundation ? _rvEsc(N.foundation) : _foundAuto;
    let focus1, focus2;
    if(N.focus1 || N.focus2){
      focus1 = N.focus1 ? '<li>'+_rvEsc(N.focus1)+'</li>' : '';
      focus2 = N.focus2 ? '<li>'+_rvEsc(N.focus2)+'</li>' : '';
    } else if(tier==='strong' && !hasGap){
      focus1 = "<li>Take on more scope — you're at the standard across the board.</li>";
      focus2 = topPill ? '<li>Push <b>'+topPill[0]+'</b> from strong to exceptional.</li>' : '';
    } else {
      const lv = lowG ? (lowG.trust!=null?lowG.trust:lowG.tp3) : null;
      const verb = (lv!=null && lv<3) ? 'Rebuild' : 'Strengthen';
      focus1 = lowG ? '<li>'+verb+' trust with your <b>'+lowG.label+'</b> <b class="'+_rvCls(lv)+'">('+_rvFmt(lv)+' — '+_rvBand(lv)+')</b>.</li>' : '';
      const fp = (gapPills.length?gapPills:lowP).slice(0,2);
      focus2 = fp.length ? '<li>Raise <b>'+fp.join('</b> and <b>')+'</b> toward the <b>4.0 standard</b>.</li>' : '';
    }
    const debriefWhen = _rvDate(D.debrief_date, D.debrief_time);
    const summary = `
      <div class="rvsummary">
        <div class="scard">
          <div class="t">Your TP3 Index</div>
          <div class="big ${_rvCls(tp3)}">${_rvFmt(tp3)} / 5 ${_rvTag(tp3)}</div>
          ${headline}
          <div class="txt">${foundation}</div>
          <div class="legend">On the GPS scale: 4–5 Strong · 3–3.9 Develop · 2.9 &amp; below Serious.</div>
        </div>
        <div class="scard focus">
          <div class="t">Your 90-day focus</div>
          <ul>${focus1}${focus2}</ul>
          <div class="note">We'll build a 90-day plan around these in your debrief.</div>
        </div>
        <div class="scard debrief">
          <div class="t">${debriefWhen?'Your debrief is scheduled':'Your debrief'}</div>
          ${debriefWhen?`<div class="txt" style="margin-top:8px;"><b>${debriefWhen}</b> with Alex.</div>`:`<div class="txt" style="margin-top:8px;">We'll schedule your debrief shortly.</div>`}
          <div class="txt" style="margin-top:6px;">We'll use this page to pick 1–2 concrete behavior goals for the next 90 days.</div>
          <a class="prepbtn" href="#rv-debrief-prep">How to prepare →</a>
        </div>
      </div>`;

    // ── 2. The numbers (honest bars) ────────────────────────────────────────
    let honestAuto;
    if(tier==='strong'){
      honestAuto = `Your raters put you at or above the 4.0 standard across the board.${topG?` Your ${topG.label} rate you highest (${_rvFmt(topG.tp3)}).`:''} The opportunity now is scope and consistency, not repair.`;
    } else if(tier==='serious'){
      honestAuto = `Multiple groups rate you below the develop range.${lowG?` The most urgent gap is your ${lowG.label} (${_rvFmt(lowG.tp3)}).`:''} On the GPS scale this calls for a direct, focused 90-day plan.`;
    } else {
      honestAuto = `You sit in the 3-range on ${allDev?'every pillar':'most pillars'} — a workable foundation, but ${allDev?'none are':'not all are'} at the 4.0 standard yet. On the GPS scale that means a real plan, not a victory lap.${lowG?` Your most urgent gap is your ${lowG.label}.`:''}`;
    }
    const honest = N.honest_read ? _rvEsc(N.honest_read) : honestAuto;
    const numbers = `
      <div class="rvlabel">The numbers</div>
      <div class="rvcard">
        <h2>Your TP3 Index</h2>
        ${_rvBar('Trust', sc.trust)}
        ${_rvBar('Proactivity', sc.proactivity)}
        ${_rvBar('Productivity', sc.productivity)}
        ${sc.impact!=null?_rvBar('Overall Impact', sc.impact):''}
        ${sc.bench!=null?_rvBar('Bench Strength', sc.bench):''}
        <div class="scalekey">grey = 3.0 · green = 4.0 target</div>
        <div class="read"><b>The honest read:</b> ${honest}</div>
      </div>`;

    // ── 3. Red-flag callout (group-level serious gaps) ──────────────────────
    let flagItems='';
    if(lowG && ((lowG.trust!=null&&lowG.trust<=2.9)||(lowG.tp3!=null&&lowG.tp3<=2.9))){
      const v = (lowG.trust!=null)?lowG.trust:lowG.tp3;
      flagItems += `<div class="flag"><span class="ic"></span><span><b>Trust with your ${lowG.label}: ${_rvFmt(v)} / 5 (Serious)</b>${isSup?` — <b>below acceptable from the person you report to.</b>`:'.'}</span></div>`;
    }
    [['Trust',sc.trust],['Proactivity',sc.proactivity],['Productivity',sc.productivity]].forEach(p=>{
      if(p[1]!=null && p[1]<=2.9) flagItems += `<div class="flag"><span class="ic"></span><span><b>${p[0]} overall: ${_rvFmt(p[1])} / 5 (Serious)</b> — below the develop range across all raters.</span></div>`;
    });
    const flagGoal = lowP.length ? `90-day goal: move ${lowP.join(' and ')} toward the 4.0 standard by changing how you delegate and how you handle conflict.` : '';
    const flags = flagItems ? `
      <div class="flags">
        <h2>Red-flag items — fix these first</h2>
        ${flagItems}
        ${flagGoal?`<div class="goal">${flagGoal}</div>`:''}
      </div>` : '';
    const supQuote = N.supervisor_quote ? `
      <div class="qlabel">In their words — your supervisor</div>
      <div class="quote" style="margin-top:6px;"><p>“${_rvEsc(N.supervisor_quote)}”</p><div class="by">— Your supervisor</div></div>` : '';

    // ── 4. How others experience you (group table + strengths/work) ─────────
    const gt = _rvGroupTable(bg);
    let sowhat;
    if(N.sowhat){
      sowhat = '<div class="sowhat"><b>So what this means:</b> '+_rvEsc(N.sowhat)+'</div>';
    } else if(lowG && lowG.tp3!=null && lowG.tp3<4){
      const _sowhatText = isSup
        ? "Only your direct reports are at or above the 4.0 standard. Your colleagues, supervisor, and self-assessment all fall below it — the people above and around you don't yet have the same confidence your team does. That gap is the work."
        : 'Your '+(topG?topG.label:'strongest group')+' rates you highest, but your '+lowG.label+' experiences you differently. The work is closing that distance.';
      sowhat = '<div class="sowhat"><b>So what this means:</b> '+_sowhatText+'</div>';
    } else if(tier==='strong'){
      sowhat = '<div class="sowhat"><b>So what this means:</b> your groups see you consistently at the standard — the conversation is about more scope, not repair.</div>';
    } else {
      sowhat = '';
    }
    const teamQuote = N.team_quote ? `
      <div class="qlabel">In their words — your team</div>
      <div class="quote" style="margin-top:6px;"><p>“${_rvEsc(N.team_quote)}”</p><div class="by">— A direct report</div></div>` : '';
    const strengths = `
      <div class="mini s"><h3>Where you're closest to the standard</h3>
        ${topPill?`<div class="item"><span class="dot" style="background:${_rvCol(topPill[1])}"></span><span><b>${topPill[0]}</b> — your strongest pillar (${_rvFmt(topPill[1])}).</span></div>`:''}
        ${topG?`<div class="item"><span class="dot" style="background:${_rvCol(topG.tp3)}"></span><span>Your <b>${topG.label}</b> rate you ${_rvFmt(topG.tp3)} overall — your highest group.</span></div>`:''}
      </div>${teamQuote}`;
    const workItems=[];
    if(lowG && lowG.tp3!=null && lowG.tp3<4){ const lv=lowG.trust!=null?lowG.trust:lowG.tp3; workItems.push(`<div class="item"><span class="dot" style="background:${_rvCol(lv)}"></span><span><b>Trust with your ${lowG.label}</b> (${_rvFmt(lv)})${lv<=2.9?' — serious; fix first.':'.'}</span></div>`); }
    if(gapPills.length){ const gp=gapPills[0]; workItems.push(`<div class="item"><span class="dot" style="background:${_rvCol(sc[gp.toLowerCase()])}"></span><span><b>${gp}</b> — below the 4.0 standard; bring it up.</span></div>`); }
    const work = `
      <div class="mini g"><h3>Where the work is</h3>
        ${workItems.length?workItems.join(''):'<div class="item"><span class="dot" style="background:var(--rvgreen)"></span><span>No pressing gaps — pick one stretch goal to go from strong to exceptional.</span></div>'}
      </div>`;
    const band = gt.hasRows ? `
      <div class="rvlabel">How others experience you</div>
      <div class="rvcard">
        <h2>How others experience you</h2>
        <table class="gtab"><thead><tr><th>Group</th><th>Trust</th><th>Proact.</th><th>Prod.</th><th>TP3</th></tr></thead><tbody>${gt.body}</tbody></table>
        <div class="confnote">${gt.note}</div>
        ${sowhat}
        <div class="bandgrid"><div>${strengths}</div><div>${work}</div></div>
      </div>` : '';

    // ── 5. More detail (custom questions + succession) ──────────────────────
    const cq=[];
    if(D.custom_g1_question && sc.g1!=null) cq.push([D.custom_g1_question, sc.g1]);
    if(D.custom_g2_question && sc.g2!=null) cq.push([D.custom_g2_question, sc.g2]);
    let customDetail='';
    if(cq.length){
      const ss=cq.map(c=>`${_rvEsc(c[0]).slice(0,60)}: ${_rvFmt(c[1])} — ${_rvBand(c[1])}`).join(' · ');
      const rowsHtml=cq.map(c=>`<div class="qrow"><div class="q">${_rvEsc(c[0])} ${_rvTag(c[1])}</div><div class="qscore ${_rvCls(c[1])}">${_rvFmt(c[1])} <span style="font-size:12px;color:#9aa7ad;">/5</span></div></div>`).join('');
      customDetail=`
      <details class="detail"><summary><span><span class="st">Custom questions</span><br><span class="ss">${ss}<br>These belong in your 90-day plan, not the parking lot.</span></span><span class="chev"></span></summary>
        <div class="detail-body">${rowsHtml}</div></details>`;
    }
    let succDetail='';
    if(sc.bench!=null || D.self_three_year_vision || D.self_successor_candidates){
      const planBits=[];
      if(D.self_three_year_vision) planBits.push(`<b>3-year vision:</b> ${_rvEsc(D.self_three_year_vision)}`);
      if(D.self_successor_candidates) planBits.push(`<b>Successor candidates:</b> ${_rvEsc(D.self_successor_candidates)}`);
      if(D.self_successor_development_actions) planBits.push(`<b>Development underway:</b> ${_rvEsc(D.self_successor_development_actions)}`);
      succDetail=`
      <details class="detail"><summary><span><span class="st">Succession &amp; bench strength</span><br><span class="ss">Bench strength ${_rvFmt(sc.bench)} — ${_rvBand(sc.bench)}</span></span><span class="chev"></span></summary>
        <div class="detail-body">
          <div class="qrow"><div class="q">Bench strength ${_rvTag(sc.bench)}</div><div class="qscore ${_rvCls(sc.bench)}">${_rvFmt(sc.bench)} <span style="font-size:12px;color:#9aa7ad;">/5</span></div></div>
          ${planBits.length?`<div class="plan-note">${planBits.join('<br>')}</div>`:''}
        </div></details>`;
    }
    const detail = (customDetail||succDetail) ? `<div class="rvlabel">More detail</div>${customDetail}${succDetail}` : '';

    // ── 6. Self vs others + debrief prep ────────────────────────────────────
    const selfTp3 = (bg.self && bg.self.tp3!=null) ? bg.self.tp3 : null;
    const selfVs = (selfTp3!=null && tp3!=null) ? `
      <div class="rvlabel">Before your debrief</div>
      <div class="rvcard">
        <h2>Self vs. others</h2>
        <div class="vs"><span style="color:var(--rvmid)">Your self-rating (TP3)</span><b class="${_rvCls(selfTp3)}">${_rvFmt(selfTp3)} / 5</b></div>
        <div class="vs"><span style="color:var(--rvmid)">How others rate you (TP3)</span><b class="${_rvCls(tp3)}">${_rvFmt(tp3)} / 5</b></div>
        <div class="vsnote">${selfTp3<tp3?'Others rate you a bit higher overall':'You rate yourself a bit higher than others do'}${lowG?` — but your ${lowG.label} ${lowG.k==='supervisor'?'is the exception, especially on trust':'sees it differently'}.`:'.'}</div>
      </div>` : '';
    const prep = `
      <div class="prep" id="rv-debrief-prep">
        <h2>How to prepare for your debrief</h2>
        <div class="ps">Ten minutes of prep makes the session twice as useful. We'll leave the debrief with 1–2 concrete behavior commitments you can start this week.</div>
        <ul>
          <li>Note 1–2 recent situations where trust with your ${lowG?lowG.label:'supervisor'} felt strained (a missed update, a last-minute surprise, an unclear decision).</li>
          <li>Bring one example where delegating a decision went well (clear guardrails, you stayed out of the way) and one where it bottlenecked (people waited on you).</li>
          <li>Skim this page and star anything that surprises you or feels off.</li>
          <li>Come ready to commit to 1–2 specific behavior experiments you'll run for the next 90 days.</li>
        </ul>
        <div class="bring">Bring this summary, with your notes and examples, to the debrief.</div>
      </div>`;

    // ── 7. Stop / Start / Continue highlights (rater-sourced, optional) ────────
    // Populated from scores_json.ssc = { stop: [...], start: [...], continue: [...] }
    // Each array holds 1–3 anonymised rater quotes. Absent = section is hidden.
    const ssc = sc.ssc || {};
    const _sscRow = (label, color, items) => {
      if(!items || !items.length) return '';
      const qs = items.map(q => `<div style="border-left:3px solid ${color};padding:6px 0 6px 12px;margin:8px 0;font-size:13.5px;font-style:italic;color:#2a3a4a;line-height:1.5;">${_rvEsc(q)}</div>`).join('');
      return `<div style="margin-bottom:18px;"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.09em;color:${color};margin-bottom:4px;">${label}</div>${qs}</div>`;
    };
    const sscHtml = (ssc.stop||ssc.start||ssc.continue) ? `
      <div class="rvlabel">What your raters said</div>
      <div class="rvcard">
        <h2>Stop &middot; Start &middot; Continue</h2>
        <div style="font-size:12.5px;color:var(--rvmid);margin-bottom:18px;">Selected open-ended feedback from your raters, anonymised. Your full report includes the complete set.</div>
        ${_sscRow('Stop',   '#A32D2D', ssc.stop)}
        ${_sscRow('Start',  '#0F6E56', ssc.start)}
        ${_sscRow('Continue','#004369', ssc.continue)}
      </div>` : '';

    const who = D.client_name ? _rvEsc(D.client_name) : '';
    return `<div class="gps-rv">${summary}${numbers}${flags}${supQuote}${band}${detail}${selfVs}${sscHtml}${prep}<div class="rvfoot">GPS Leadership Solutions · Confidential${who?` · Prepared for ${who}`:''}</div></div>`;
  }
  if (typeof window !== 'undefined') window.renderGpsResults = renderGpsResults;
})();
