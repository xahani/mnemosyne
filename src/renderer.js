'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#ef4444',
  '#f97316','#eab308','#22c55e','#14b8a6',
  '#3b82f6','#0ea5e9','#6b7280','#a855f7',
];

// ─── State ────────────────────────────────────────────────────────────────────
let API;
let notebooks=[], sections=[], pages=[], concepts=[], highlights=[];
let activeNbId=null, activeSecId=null, activePgId=null;
let selectedConId=null, saveTimer=null, healthIgnored=new Set();
let nbColor=COLORS[0], secColor=COLORS[2];
let decayView='focus', decayFilter='all';
let reviewQueue=[], reviewIdx=0, currentReviewCon=null;
let sortBy='confidence', sortDir='asc';
let aiEnabled=false, currentMcq=null;
let quizQuestions=[], quizIdx=0, quizAnswers=[], quizScope='page', quizPageMap={};
let pageHighlights=[];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const qa  = sel => document.querySelectorAll(sel);
const esc = s   => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function timeAgo(ts) {
  const s = Math.floor(Date.now()/1000) - ts;
  if (s<60)    return 'just now';
  if (s<3600)  return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago';
  const d=Math.floor(s/86400); return d===1?'yesterday':d+'d ago';
}
function fmtDate(ts) {
  return new Date(ts*1000).toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
}
function fmtShort(ts) {
  return new Date(ts*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function toast(msg, ms=2400) {
  const el=$('toast');
  el.textContent=msg; el.style.display='block'; el.style.opacity='1';
  clearTimeout(el._t);
  el._t=setTimeout(()=>{el.style.opacity='0'; setTimeout(()=>el.style.display='none',300);}, ms);
}

// ─── Decay math ───────────────────────────────────────────────────────────────
function conf(c) {
  const days=(Date.now()/1000 - c.last_reviewed)/86400;
  const sm = getSubjectMult(c.subject);
  const pm = (API && concepts.length) ? getCurrentProfile()?.baseMultiplier||1.0 : 1.0;
  return Math.max(0, Math.min(100, Math.round(100*Math.exp(-days/(c.stability*sm*pm)))));
}
function getSubjectMult(subject) {
  return profileCache?.subjectMultipliers?.[subject] || 1.0;
}
function statusOf(v) { return v>=70?'stable':v>=40?'fading':'critical'; }
function nextRev(c) {
  const till = c.last_reviewed + c.stability*0.9163*86400 - Date.now()/1000;
  if (till<=0) return 'Review now';
  const h=Math.floor(till/3600);
  if (h<1) return 'In <1h';
  if (h<24) return 'In '+h+'h';
  return 'In '+Math.floor(till/86400)+'d';
}
function explainConf(c) {
  const cf=conf(c), st=statusOf(cf);
  const days=Math.round((Date.now()/1000 - c.last_reviewed)/86400);
  if (st==='stable') return `Strong — answered correctly ${c.reviewCount||0} time${c.reviewCount===1?'':'s'}, stable for ${Math.round(nextRevDays(c))} more days`;
  if (st==='fading') return `Fading — ${days} day${days===1?'':'s'} since last review`;
  return `Dropping — ${days} day${days===1?'':'s'} without review, down to ${cf}%`;
}
function nextRevDays(c) {
  const till = c.last_reviewed + c.stability*0.9163*86400 - Date.now()/1000;
  return Math.max(0, till/86400);
}

// Due badge — count concepts past their review threshold
function updateDueBadge() {
  if (!concepts.length) {
    $('decay-due-badge').style.display = 'none';
    return;
  }
  const now = Date.now() / 1000;
  const dueCount = concepts.filter(c => {
    // Due if: confidence below 40% (critical) OR past scheduled interval
    const cf = conf(c);
    const daysSince = (now - c.last_reviewed) / 86400;
    const pastSchedule = daysSince >= c.stability * 0.9163;
    return cf < 40 || pastSchedule;
  }).length;

  const badge = $('decay-due-badge');
  if (dueCount > 0) {
    badge.textContent = dueCount > 99 ? '99+' : String(dueCount);
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

// SVG ring
function svgRing(pct, st, size) {
  const h=size/2, r=h-5, circ=2*Math.PI*r;
  const dash=(pct/100)*circ, gap=circ-dash;
  const col={stable:'#22c55e',fading:'#f59e0b',critical:'#ef4444'}[st];
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="#232333" stroke-width="3.5"/>
    <circle cx="${h}" cy="${h}" r="${r}" fill="none" stroke="${col}" stroke-width="3.5"
      stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}"
      stroke-dashoffset="${(circ*.25).toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 ${h} ${h})"/>
  </svg>`;
}

// Color picker
function colorPicker(id, get, set) {
  const el=$(id); if(!el) return;
  el.innerHTML=COLORS.map(c=>`<div class="color-swatch${get()===c?' sel':''}" style="background:${c}" data-c="${c}"></div>`).join('');
  el.querySelectorAll('.color-swatch').forEach(sw=>{
    sw.addEventListener('click',()=>{
      set(sw.dataset.c);
      el.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('sel'));
      sw.classList.add('sel');
    });
  });
}

// Modals
function openModal(id)  { $(id).style.display='flex'; }
function closeModal(id) { $(id).style.display='none'; }

// Profile cache
let profileCache=null;
async function getCurrentProfile() {
  if (!profileCache) profileCache = await API.profile.get();
  return profileCache;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTEBOOKS
// ═══════════════════════════════════════════════════════════════════════════════
async function loadNotebooks() {
  notebooks = await API.nb.list();
  await renderNbDropdown();
}

async function renderNbDropdown() {
  const list=$('nb-dropdown-list'); if(!list) return;

  // Load archived notebooks too for the restore section
  let archived = [];
  try { archived = await API.nb.listArchived(); } catch(_) {}

  let html = '';

  if (!notebooks.length && !archived.length) {
    html = '<div style="padding:10px 14px;font-size:12px;color:#5a5878">No notebooks yet</div>';
  }

  // Active notebooks
  html += notebooks.map(nb=>`
    <div class="nb-dd-item${activeNbId===nb.id?' active':''}" data-id="${nb.id}">
      <div class="nb-dd-swatch" style="background:${esc(nb.color)}"></div>
      <span class="nb-dd-name">${esc(nb.name)}</span>
      <div class="nb-dd-actions">
        <button class="nb-dd-btn nb-dd-rename"  data-id="${nb.id}" title="Rename">✏</button>
        <button class="nb-dd-btn nb-dd-archive" data-id="${nb.id}" title="Close notebook (archive)">⊟</button>
        <button class="nb-dd-btn nb-dd-delete"  data-id="${nb.id}" title="Delete permanently">🗑</button>
      </div>
    </div>`).join('');

  // Archived section
  if (archived.length) {
    html += `<div class="nb-dd-archived-label">CLOSED NOTEBOOKS</div>`;
    html += archived.map(nb=>`
      <div class="nb-dd-item nb-dd-archived" data-id="${nb.id}">
        <div class="nb-dd-swatch" style="background:${esc(nb.color)};opacity:.4"></div>
        <span class="nb-dd-name" style="opacity:.5">${esc(nb.name)}</span>
        <div class="nb-dd-actions">
          <button class="nb-dd-btn nb-dd-restore" data-id="${nb.id}" title="Restore notebook">↩</button>
          <button class="nb-dd-btn nb-dd-delete"  data-id="${nb.id}" title="Delete permanently">🗑</button>
        </div>
      </div>`).join('');
  }

  list.innerHTML = html;

  // Select
  list.querySelectorAll('.nb-dd-item:not(.nb-dd-archived)').forEach(el=>{
    el.addEventListener('click', e=>{
      if (e.target.closest('.nb-dd-actions')) return;
      selectNotebook(+el.dataset.id);
    });
  });

  // Rename
  list.querySelectorAll('.nb-dd-rename').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      const id = +btn.dataset.id;
      const nb = notebooks.find(n=>n.id===id); if (!nb) return;
      startNbRename(id, btn.closest('.nb-dd-item').querySelector('.nb-dd-name'), nb.name);
    });
  });

  // Archive (close)
  list.querySelectorAll('.nb-dd-archive').forEach(btn=>{
    btn.addEventListener('click', async e=>{
      e.stopPropagation();
      const id = +btn.dataset.id;
      const nb = notebooks.find(n=>n.id===id); if (!nb) return;
      await API.nb.archive(id);
      notebooks = notebooks.filter(n=>n.id!==id);
      if (activeNbId === id) {
        activeNbId=null; activeSecId=null; activePgId=null;
        sections=[]; pages=[];
        $('nb-selector-name').textContent = 'Select notebook';
        $('section-tabs').innerHTML = '';
        renderPageList();
        showEditorEmpty();
      }
      renderNbDropdown();
      toast(`"${nb.name}" closed — find it in Closed Notebooks to restore`);
    });
  });

  // Restore
  list.querySelectorAll('.nb-dd-restore').forEach(btn=>{
    btn.addEventListener('click', async e=>{
      e.stopPropagation();
      const id = +btn.dataset.id;
      const nb = await API.nb.restore(id);
      if (nb) {
        notebooks.push(nb);
        renderNbDropdown();
        toast(`"${nb.name}" restored`);
      }
    });
  });

  // Delete
  list.querySelectorAll('.nb-dd-delete').forEach(btn=>{
    btn.addEventListener('click', e=>{
      e.stopPropagation();
      deleteNotebook(+btn.dataset.id);
    });
  });
}

function startNbRename(id, nameEl, original) {
  const inp = document.createElement('input');
  inp.className = 'nb-dd-rename-inp';
  inp.value     = original;
  nameEl.replaceWith(inp);
  inp.focus(); inp.select();

  async function commit() {
    const newName = inp.value.trim();
    const span = document.createElement('span');
    span.className   = 'nb-dd-name';
    span.textContent = newName || original;
    inp.replaceWith(span);
    if (!newName || newName === original) return;
    await API.nb.rename({ id, name: newName });
    const i = notebooks.findIndex(n=>n.id===id);
    if (i!==-1) notebooks[i].name = newName;
    // Update selector label if this is the active notebook
    if (activeNbId === id) $('nb-selector-name').textContent = newName;
    renderNbDropdown();
    toast(`Notebook renamed to "${newName}"`);
  }

  inp.addEventListener('keydown', e=>{
    if (e.key==='Enter')  { e.preventDefault(); inp.blur(); }
    if (e.key==='Escape') { inp.value=original; inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commit);
  inp.addEventListener('click', e=>e.stopPropagation());
}

async function deleteNotebook(id) {
  const nb = notebooks.find(n=>n.id===id);
  if (!nb) return;
  const secCount = sections.filter(s=>s.notebookId===id).length;
  const msg = secCount > 0
    ? `Delete "${nb.name}"? This will permanently remove ${secCount} section${secCount===1?'':'s'} and all their pages, highlights, and decay concepts.`
    : `Delete "${nb.name}"? This cannot be undone.`;
  if (!confirm(msg)) return;

  await API.nb.del(id);
  notebooks = notebooks.filter(n=>n.id!==id);

  // If we deleted the active notebook, reset everything
  if (activeNbId === id) {
    activeNbId=null; activeSecId=null; activePgId=null;
    sections=[]; pages=[];
    $('nb-selector-name').textContent = 'Select notebook';
    $('section-tabs').innerHTML = '';
    renderPageList();
    showEditorEmpty();
  }

  await renderNbDropdown();
  // Refresh concepts since some may have been deleted
  concepts = await API.con.list();
  updateDueBadge();
  toast(`"${nb.name}" deleted`);
}

async function selectNotebook(id) {
  activeNbId=id; activeSecId=null; activePgId=null;
  const nb=notebooks.find(n=>n.id===id);
  $('nb-selector-name').textContent = nb?nb.name:'Select notebook';
  $('nb-dropdown').classList.remove('open');
  await renderNbDropdown();
  await loadSections();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════
async function loadSections() {
  if(!activeNbId) return;
  sections = await API.sec.list(activeNbId);
  renderSectionTabs();
  if(sections.length) await selectSection(sections[0].id);
  else { pages=[]; renderPageList(); showEditorEmpty(); }
}

function renderSectionTabs() {
  const c=$('section-tabs'); if(!c) return;
  c.innerHTML=sections.map(s=>`
    <div class="sec-tab${activeSecId===s.id?' active':''}" data-id="${s.id}" title="Right-click to delete">
      <div class="sec-tab-dot" style="background:${esc(s.color)}"></div>
      <span class="sec-tab-name">${esc(s.name)}</span>
    </div>`).join('');
  c.querySelectorAll('.sec-tab').forEach(el=>{
    el.addEventListener('click', ()=>selectSection(+el.dataset.id));
    el.addEventListener('dblclick', e=>{ e.stopPropagation(); startSecRename(+el.dataset.id, el); });
    el.addEventListener('contextmenu', e=>{
      e.preventDefault();
      const sec=sections.find(s=>s.id===+el.dataset.id);
      if(sec && confirm(`Delete section "${sec.name}" and all its pages?`)) deleteSection(sec.id);
    });
  });
}

async function selectSection(id) {
  activeSecId=id; activePgId=null;
  renderSectionTabs();
  await loadPages();
}

// ── Inline rename — section tab ──────────────────────────────────────────────
function startSecRename(id, tabEl) {
  const sec = sections.find(s=>s.id===id);
  if (!sec) return;

  const nameEl = tabEl.querySelector('.sec-tab-name');
  const original = sec.name;

  // Build inline input replacing the name span
  const inp = document.createElement('input');
  inp.className   = 'inline-rename-inp';
  inp.value       = original;
  inp.style.width = Math.max(80, original.length * 8) + 'px';
  nameEl.replaceWith(inp);
  inp.focus();
  inp.select();

  // Prevent tab click while renaming
  tabEl.classList.add('renaming');

  async function commit() {
    const newName = inp.value.trim();
    tabEl.classList.remove('renaming');
    if (!newName || newName === original) {
      // restore original
      const span = document.createElement('span');
      span.className   = 'sec-tab-name';
      span.textContent = original;
      inp.replaceWith(span);
      return;
    }
    await API.sec.rename({ id, name: newName });
    const i = sections.findIndex(s=>s.id===id);
    if (i!==-1) sections[i].name = newName;
    renderSectionTabs();
    toast(`Section renamed to "${newName}"`);
  }

  inp.addEventListener('keydown', e=>{
    if (e.key==='Enter') { e.preventDefault(); inp.blur(); }
    if (e.key==='Escape') { inp.value=original; inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commit);
  inp.addEventListener('click', e=>e.stopPropagation());
}

// ── Inline rename — page ──────────────────────────────────────────────────────
function startPageRename(id, titleEl) {
  const pg = pages.find(p=>p.id===id);
  if (!pg) return;

  const original = pg.title || 'Untitled';

  const inp = document.createElement('input');
  inp.className   = 'inline-rename-inp inline-rename-page';
  inp.value       = original;
  titleEl.replaceWith(inp);
  inp.focus();
  inp.select();

  async function commit() {
    const newName = inp.value.trim() || 'Untitled';
    // Restore span regardless
    const span = document.createElement('div');
    span.className   = 'page-item-title';
    span.textContent = newName;
    inp.replaceWith(span);

    if (newName === original) return;

    // Save to disk
    const full = await API.pg.get(id);
    if (full) {
      await API.pg.save({ id, title: newName, content: full.content });
    }
    const i = pages.findIndex(p=>p.id===id);
    if (i!==-1) pages[i].title = newName;

    // Update the open editor title if this page is active
    if (activePgId === id) {
      $('page-title-inp').value = newName;
    }
    renderPageList();
    toast(`Page renamed to "${newName}"`);
  }

  inp.addEventListener('keydown', e=>{
    if (e.key==='Enter') { e.preventDefault(); inp.blur(); }
    if (e.key==='Escape') { inp.value=original; inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commit);
  inp.addEventListener('click', e=>e.stopPropagation());
}

async function deleteSection(id) {
  await API.sec.del(id);
  sections=sections.filter(s=>s.id!==id);
  if(activeSecId===id) activeSecId=sections[0]?.id||null;
  renderSectionTabs();
  if(activeSecId) await loadPages();
  else { pages=[]; renderPageList(); showEditorEmpty(); }
  toast('Section deleted');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGES
// ═══════════════════════════════════════════════════════════════════════════════
async function loadPages() {
  if(!activeSecId) return;
  pages = await API.pg.list(activeSecId);
  renderPageList();
  if(pages.length) await openPage(pages[0].id);
  else showEditorEmpty();
}

function renderPageList() {
  const list=$('page-list'); if(!list) return;
  if(!pages.length) {
    list.innerHTML='<div style="padding:20px 12px;font-size:12px;color:#5a5878;text-align:center">No pages yet</div>';
    return;
  }
  list.innerHTML=pages.map(pg=>`
    <div class="page-item${activePgId===pg.id?' active':''}" data-id="${pg.id}">
      ${pg.tracked?'<span class="page-item-tracked" title="Tracked in Decay">⟳</span>':'<span style="width:16px"></span>'}
      <div class="page-item-info">
        <div class="page-item-title">${esc(pg.title||'Untitled')}</div>
        <div class="page-item-date">${timeAgo(pg.updatedAt||pg.createdAt)}</div>
      </div>
      <button class="page-item-del" data-id="${pg.id}" title="Delete">✕</button>
    </div>`).join('');
  list.querySelectorAll('.page-item').forEach(el=>{
    el.addEventListener('click', e=>{ if(e.target.closest('.page-item-del')) return; openPage(+el.dataset.id); });
    el.addEventListener('dblclick', e=>{
      if(e.target.closest('.page-item-del')) return;
      e.stopPropagation();
      startPageRename(+el.dataset.id, el.querySelector('.page-item-title'));
    });
  });
  list.querySelectorAll('.page-item-del').forEach(btn=>{
    btn.addEventListener('click',e=>{ e.stopPropagation(); deletePage(+btn.dataset.id); });
  });
}

async function openPage(id) {
  activePgId=id;
  renderPageList();
  const pg=await API.pg.get(id);
  if(!pg) return;

  showEditor();
  $('page-title-inp').value    = pg.title||'';
  $('editor-body').innerHTML   = pg.content||'';
  $('page-date-line')||($('page-meta').id='page-date-line');
  $('page-meta').textContent   = fmtDate(pg.createdAt);
  $('save-status').textContent = '';
  $('note-health-bar').style.display='none';

  // Update track button state
  const trackBtn=$('btn-track-page');
  if(pg.tracked) {
    trackBtn.textContent='✓ Tracked';
    trackBtn.style.color='var(--teal2)';
  } else {
    trackBtn.textContent='＋ Track Page';
    trackBtn.style.color='';
  }

  // Load highlights for this page
  pageHighlights = await API.hl.list(id);

  // Check note health (only if page has content and not ignored)
  if(pg.content && !healthIgnored.has(id)) {
    const health = await API.note.health({ content:pg.content, title:pg.title });
    if(!health.healthy && pg.tracked) {
      showNoteHealth(health, id);
    }
  }
}

function showEditor() {
  $('canvas-empty').style.display  = 'none';
  $('page-editor').style.display   = 'block';
  $('toolbar').style.display       = 'flex';
  $('btn-del-page').style.display  = 'inline-flex';
  $('btn-track-page').style.display= 'inline-flex';
}

function showEditorEmpty() {
  activePgId=null;
  $('canvas-empty').style.display  = 'flex';
  $('page-editor').style.display   = 'none';
  $('toolbar').style.display       = 'none';
  $('btn-del-page').style.display  = 'none';
  $('btn-track-page').style.display= 'none';
  renderPageList();
}

async function deletePage(id) {
  const pg=pages.find(p=>p.id===id);
  if(!confirm(`Delete "${pg?.title||'this page'}"?`)) return;
  await API.pg.del(id);
  pages=pages.filter(p=>p.id!==id);
  if(activePgId===id) {
    activePgId=null;
    if(pages.length) await openPage(pages[0].id);
    else showEditorEmpty();
  } else renderPageList();
  toast('Page deleted');
}

// Note health
function showNoteHealth(health, pageId) {
  const msgs={ too_short:'This might be hard to review well later — note seems quite short', no_example:'No example or number found in your note — may be hard to generate review questions', too_brief:'Note may need more detail for reliable review questions' };
  const issue=health.issues[0];
  $('note-health-msg').textContent = msgs[issue]||'This note may be hard to review well later';
  $('note-health-bar').style.display='block';
}

// Save
function scheduleSave() {
  clearTimeout(saveTimer);
  $('save-status').textContent='Unsaved…';
  saveTimer=setTimeout(async()=>{
    if(!activePgId) return;
    const title   = $('page-title-inp').value.trim()||'Untitled';
    const content = $('editor-body').innerHTML;
    await API.pg.save({ id:activePgId, title, content });
    const i=pages.findIndex(p=>p.id===activePgId);
    if(i!==-1){ pages[i].title=title; pages[i].updatedAt=Math.floor(Date.now()/1000); }
    renderPageList();
    $('save-status').textContent='Saved ✓';
    setTimeout(()=>{ if($('save-status').textContent==='Saved ✓') $('save-status').textContent=''; },2000);
  },1000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// HIGHLIGHTS
// ═══════════════════════════════════════════════════════════════════════════════
function markSelectionImportant() {
  const sel=window.getSelection();
  if(!sel||sel.rangeCount===0||sel.isCollapsed) {
    toast('Select some text first, then click Mark Important');
    return;
  }
  if(!activePgId) { toast('Open a page first'); return; }

  const text=sel.toString().trim();
  if(text.length<3) { toast('Select more text to highlight'); return; }

  const range=sel.getRangeAt(0);
  try {
    const span=document.createElement('span');
    span.className='mn-highlight';
    span.title='Important — tracked in Decay Tracker';
    span.setAttribute('data-hl','1');
    range.surroundContents(span);
    sel.removeAllRanges();
    scheduleSave();

    // Get current section subject for concept
    const sec=sections.find(s=>s.id===activeSecId);
    const subject=sec?sec.name:'General';

    API.hl.add({ pageId:activePgId, text, subject }).then(res=>{
      if(res) {
        pageHighlights.push(res.highlight);
        // Add new concept directly to local array — no full reload needed
        if (res.concept) {
          concepts.push(res.concept);
          // If decay overlay is open, update all views instantly
          if ($('decay-overlay').style.display !== 'none') {
            renderDecayStats();
            renderDecayView();
            updateDueBadge();
          } else {
            // Still update badge even if overlay is closed
            updateDueBadge();
          }
        }
        toast('⭐ Marked as important — added to Decay Tracker');
      }
    });
  } catch(e) {
    toast('Could not highlight — try selecting within a single paragraph');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DECAY MODULE
// ═══════════════════════════════════════════════════════════════════════════════
async function loadDecay() {
  profileCache = await API.profile.get();
  concepts = await API.con.list();
  renderDecayStats();
  renderDecayView();
  updateDueBadge();
}

function filteredConcepts() {
  const q=($('con-search').value||'').toLowerCase();
  return concepts.filter(c=>{
    const cf=conf(c), st=statusOf(cf);
    if(decayFilter==='critical'&&st!=='critical') return false;
    if(decayFilter==='fading'&&st!=='fading')     return false;
    if(decayFilter==='stable'&&st!=='stable')     return false;
    if(q&&!c.name.toLowerCase().includes(q)&&!c.subject.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a,b)=>conf(a)-conf(b));
}

function renderDecayStats() {
  const crit=concepts.filter(c=>statusOf(conf(c))==='critical').length;
  const fade=concepts.filter(c=>statusOf(conf(c))==='fading').length;
  const stab=concepts.filter(c=>statusOf(conf(c))==='stable').length;
  $('ds-crit').textContent=crit;
  $('ds-fade').textContent=fade;
  $('ds-stab').textContent=stab;
  $('ds-tot').textContent=concepts.length;
}

function renderDecayView() {
  const list=filteredConcepts();
  renderFocusView(list);
  renderHeatmapView(list);
  renderListView(list);
}

// Focus view — top 5 most urgent
function renderFocusView(list) {
  const el=$('view-focus'); if(!el) return;
  const urgent=list.slice(0,5);
  if(!urgent.length) {
    el.innerHTML='<div style="padding:40px;text-align:center;color:#5a5878;font-size:13px">'+(concepts.length?'Nothing to show for this filter':'No tracked concepts yet — track pages and highlight important text in your notes')+'</div>';
    return;
  }
  el.innerHTML=urgent.map(c=>{
    const cf=conf(c), st=statusOf(cf);
    return `<div class="focus-card" data-id="${c.id}">
      <div class="focus-left">
        <div class="focus-title">${esc(c.name)}${c.important?'  ⭐':''}</div>
        <div class="focus-sub">${esc(c.subject)}</div>
        <div class="focus-conf-bar"><div class="focus-conf-fill ${st}" style="width:${cf}%"></div></div>
        <div class="focus-pct">${cf}% confidence · ${nextRev(c)}</div>
      </div>
      <button class="focus-review-btn ${st}" data-id="${c.id}">Review →</button>
    </div>`;
  }).join('');
  el.querySelectorAll('.focus-review-btn').forEach(btn=>{
    btn.addEventListener('click',e=>{ e.stopPropagation(); startReview([+btn.dataset.id]); });
  });
  el.querySelectorAll('.focus-card').forEach(el=>{
    el.addEventListener('click',e=>{
      if(e.target.classList.contains('focus-review-btn')) return;
      openConceptDetail(+el.dataset.id);
    });
  });
}

// Heatmap view — grouped by subject
function renderHeatmapView(list) {
  const el=$('view-heatmap'); if(!el) return;
  if(!list.length) { el.innerHTML='<div style="padding:40px;text-align:center;color:#5a5878;font-size:13px">No concepts to display</div>'; return; }
  const bySubject={};
  list.forEach(c=>{ if(!bySubject[c.subject]) bySubject[c.subject]=[]; bySubject[c.subject].push(c); });
  const colors={stable:'#22c55e',fading:'#f59e0b',critical:'#ef4444'};
  el.innerHTML=Object.entries(bySubject).map(([sub,cons])=>`
    <div class="heatmap-subject">
      <div class="heatmap-subject-title">${esc(sub)}</div>
      <div class="heatmap-grid">
        ${cons.map(c=>{
          const cf=conf(c), st=statusOf(cf);
          const opacity=0.4+cf*0.006;
          return `<div class="heatmap-cell" data-id="${c.id}"
            style="background:${colors[st]};opacity:${opacity.toFixed(2)}"
            title="${esc(c.name)} — ${cf}%">${cf}</div>`;
        }).join('')}
      </div>
    </div>`).join('');
  el.querySelectorAll('.heatmap-cell').forEach(cell=>{
    cell.addEventListener('click', ()=>openConceptDetail(+cell.dataset.id));
    cell.addEventListener('mouseenter', e=>showHeatmapTooltip(e, +cell.dataset.id));
    cell.addEventListener('mouseleave', hideHeatmapTooltip);
    cell.addEventListener('mousemove',  e=>moveHeatmapTooltip(e));
  });
}

function showHeatmapTooltip(e, id) {
  const c = concepts.find(x => x.id === id);
  if (!c) return;
  const cf = conf(c), st = statusOf(cf);
  const colors = { stable:'#22c55e', fading:'#f59e0b', critical:'#ef4444' };

  let tip = document.getElementById('ht');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'ht';
    tip.style.cssText = [
      'position:fixed',
      'display:none',
      'pointer-events:none',
      'z-index:9999',
      'background:#1c1c28',
      'border:1px solid #383850',
      'border-radius:9px',
      'padding:11px 14px',
      'min-width:190px',
      'max-width:270px',
      'box-shadow:0 8px 24px rgba(0,0,0,.6)',
      'font-family:Inter,system-ui,sans-serif',
      'font-size:12px',
      'color:#9a97b8',
    ].join(';');
    document.body.appendChild(tip);
  }

  tip.innerHTML =
    '<div style="font-size:13px;font-weight:600;color:#e2dff5;margin-bottom:8px;line-height:1.3">'
      + esc(c.name) + (c.important ? ' ⭐' : '') +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
      '<span style="color:#5a5878">Subject</span>' +
      '<span>' + esc(c.subject) + '</span>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
      '<span style="color:#5a5878">Confidence</span>' +
      '<span style="color:' + colors[st] + ';font-weight:600">' + cf + '%</span>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
      '<span style="color:#5a5878">Status</span>' +
      '<span style="color:' + colors[st] + '">' + st + '</span>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between">' +
      '<span style="color:#5a5878">Next review</span>' +
      '<span>' + nextRev(c) + '</span>' +
    '</div>';

  tip.style.display = 'block';
  moveHeatmapTooltip(e);
}

function hideHeatmapTooltip() {
  const tip = document.getElementById('ht');
  if (tip) tip.style.display = 'none';
}

function moveHeatmapTooltip(e) {
  const tip = document.getElementById('ht');
  if (!tip || tip.style.display === 'none') return;
  const pad = 16;
  const tw  = tip.offsetWidth  || 200;
  const th  = tip.offsetHeight || 120;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + tw > window.innerWidth  - pad) x = e.clientX - tw - pad;
  if (y + th > window.innerHeight - pad) y = e.clientY - th - pad;
  tip.style.left = x + 'px';
  tip.style.top  = y + 'px';
}

// Full list view
function renderListView(list) {
  const el=$('view-list'); if(!el) return;
  if(!list.length) { el.innerHTML='<div style="padding:40px;text-align:center;color:#5a5878;font-size:13px">No concepts to display</div>'; return; }

  // Apply sort
  const sorted = [...list].sort((a,b)=>{
    let va, vb;
    if (sortBy==='confidence') { va=conf(a); vb=conf(b); }
    else if (sortBy==='name')  { va=a.name.toLowerCase(); vb=b.name.toLowerCase(); }
    else if (sortBy==='subject'){ va=a.subject.toLowerCase(); vb=b.subject.toLowerCase(); }
    else if (sortBy==='date')  { va=a.created_at; vb=b.created_at; }
    else { va=conf(a); vb=conf(b); }
    if (va < vb) return sortDir==='asc' ? -1 : 1;
    if (va > vb) return sortDir==='asc' ?  1 : -1;
    return 0;
  });

  // Group by subject when sorting by subject
  if (sortBy==='subject') {
    const groups={};
    sorted.forEach(c=>{ if(!groups[c.subject]) groups[c.subject]=[]; groups[c.subject].push(c); });
    el.innerHTML = Object.entries(groups).map(([subj, cons])=>`
      <div class="list-group-header">${esc(subj)} <span class="list-group-count">${cons.length}</span></div>
      ${cons.map(c=>conceptCardHTML(c)).join('')}
    `).join('');
  } else {
    el.innerHTML = sorted.map(c=>conceptCardHTML(c)).join('');
  }

  el.querySelectorAll('.con-card').forEach(el=>{
    el.addEventListener('click',()=>openConceptDetail(+el.dataset.id));
  });
}

function conceptCardHTML(c) {
  const cf=conf(c), st=statusOf(cf);
  return `<div class="con-card ${st}${selectedConId===c.id?' selected':''}" data-id="${c.id}">
      <div class="con-ring">${svgRing(cf,st,50)}<div class="con-ring-num">${cf}</div></div>
      <div class="con-info">
        <div class="con-name">${esc(c.name)}${c.important?' <span class="con-important">⭐</span>':''}</div>
        <div class="con-meta">
          <span class="con-subj">${esc(c.subject)}</span>
          <span class="con-status ${st}">${st}</span>
          <span class="con-next">${nextRev(c)}</span>
        </div>
      </div>
    </div>`;
}

// Concept detail
async function openConceptDetail(id) {
  selectedConId=id;
  const c=concepts.find(x=>x.id===id); if(!c) return;
  $('decay-right').style.display='flex';
  const cf=conf(c), st=statusOf(cf);
  const hist=await API.con.history(id);
  const explain=explainConf(c);

  const histHtml=!hist.length
    ? '<p style="font-size:12px;color:#5a5878;font-style:italic">No reviews yet</p>'
    : hist.map(r=>{
        const rs=statusOf(r.confAtReview||50);
        const ratingLabels=['','Blank','Vague','Partial','Clear','Perfect'];
        return `<div class="cd-hist-item">
          <span class="cd-hist-date">${fmtShort(r.reviewedAt)}</span>
          <span style="font-size:11px;color:#5a5878">${ratingLabels[r.rating]||''}</span>
          <span class="cd-hist-badge ${rs}">${r.confAtReview||'?'}%</span>
        </div>`;
      }).join('');

  $('concept-detail').innerHTML=`
    <button id="cd-close" style="float:right;background:none;border:none;color:#5a5878;font-size:16px;cursor:pointer">✕</button>
    <div class="cd-name cd-editable" id="cd-name-el" title="Double-click to rename">${esc(c.name)}${c.important?' ⭐':''}</div>
    <div class="cd-subj cd-editable" id="cd-subj-el" title="Double-click to change subject">${esc(c.subject)}</div>
    <div class="cd-gauge">
      <div class="cd-gauge-ring">${svgRing(cf,st,72)}<div class="cd-gauge-num"><span class="cd-gauge-val">${cf}</span><span class="cd-gauge-pct">%</span></div></div>
      <div class="cd-gauge-info">
        <div class="cd-gauge-status ${st}">${st.charAt(0).toUpperCase()+st.slice(1)}</div>
        <div class="cd-gauge-meta">
          Last reviewed: ${timeAgo(c.last_reviewed)}<br/>
          Next review: ${nextRev(c)}<br/>
          Stability: ${c.stability.toFixed(1)}d<br/>
          Reviews: ${c.reviewCount||0}
        </div>
      </div>
    </div>
    <div class="cd-explain">${explain}</div>
    ${c.pageId?`<div class="cd-lbl" style="margin-bottom:8px">SOURCE PAGE</div>
      <button class="cd-btn-goto" id="cd-goto-page" data-pid="${c.pageId}">📄 Open source page</button>
      <div style="margin-bottom:14px"></div>`:'' }
    <div class="cd-lbl" style="margin-bottom:8px">REVIEW HISTORY</div>
    <div class="cd-hist">${histHtml}</div>
    <div class="cd-actions">
      <button class="cd-btn-review" id="cd-start-review">Review now →</button>
    </div>`;

  $('cd-close').addEventListener('click',()=>{ $('decay-right').style.display='none'; selectedConId=null; renderDecayView(); });

  // ── Inline edit: concept name ───────────────────────────────────────────────
  $('cd-name-el').addEventListener('dblclick', ()=>{
    const el = $('cd-name-el');
    const original = c.name;

    const inp = document.createElement('input');
    inp.className = 'inline-rename-inp cd-name-inp';
    inp.value     = original;
    el.replaceWith(inp);
    inp.focus(); inp.select();

    async function commitName() {
      const newName = inp.value.trim();
      const restored = document.createElement('div');
      restored.className = 'cd-name cd-editable';
      restored.id        = 'cd-name-el';
      restored.title     = 'Double-click to rename';
      const display = (newName||original) + (c.important ? ' ⭐' : '');
      restored.textContent = display;
      inp.replaceWith(restored);
      restored.addEventListener('dblclick', ()=>$('cd-name-el').dispatchEvent(new MouseEvent('dblclick')));

      if (!newName || newName === original) return;
      await API.con.updateMeta({ id: c.id, name: newName, subject: c.subject });
      const i = concepts.findIndex(x=>x.id===c.id);
      if (i!==-1) { concepts[i].name=newName; c.name=newName; }
      renderDecayView();
      toast(`Concept renamed to "${newName}"`);
    }

    inp.addEventListener('keydown', e=>{
      if (e.key==='Enter')  { e.preventDefault(); inp.blur(); }
      if (e.key==='Escape') { inp.value=original; inp.blur(); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', commitName);
  });

  // ── Inline edit: concept subject ────────────────────────────────────────────
  $('cd-subj-el').addEventListener('dblclick', ()=>{
    const el = $('cd-subj-el');
    const original = c.subject;

    // Build a datalist with existing subjects for autocomplete
    const subjects = [...new Set(concepts.map(x=>x.subject))].filter(Boolean);
    const listId   = 'cd-subj-suggestions';
    let dl = document.getElementById(listId);
    if (!dl) { dl=document.createElement('datalist'); dl.id=listId; document.body.appendChild(dl); }
    dl.innerHTML = subjects.map(s=>`<option value="${esc(s)}">`).join('');

    const inp = document.createElement('input');
    inp.className = 'inline-rename-inp cd-subj-inp';
    inp.value     = original;
    inp.setAttribute('list', listId);
    el.replaceWith(inp);
    inp.focus(); inp.select();

    async function commitSubj() {
      const newSubj = inp.value.trim() || original;
      const restored = document.createElement('div');
      restored.className = 'cd-subj cd-editable';
      restored.id        = 'cd-subj-el';
      restored.title     = 'Double-click to change subject';
      restored.textContent = newSubj;
      inp.replaceWith(restored);
      restored.addEventListener('dblclick', ()=>$('cd-subj-el').dispatchEvent(new MouseEvent('dblclick')));

      if (newSubj === original) return;
      await API.con.updateMeta({ id: c.id, name: c.name, subject: newSubj });
      const i = concepts.findIndex(x=>x.id===c.id);
      if (i!==-1) { concepts[i].subject=newSubj; c.subject=newSubj; }
      renderDecayView();
      toast(`Subject changed to "${newSubj}"`);
    }

    inp.addEventListener('keydown', e=>{
      if (e.key==='Enter')  { e.preventDefault(); inp.blur(); }
      if (e.key==='Escape') { inp.value=original; inp.blur(); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', commitSubj);
  });
  $('cd-start-review').addEventListener('click',()=>startReview([id]));
  const goBtn=$('cd-goto-page');
  if(goBtn) {
    goBtn.addEventListener('click',async()=>{
      const pid=+goBtn.dataset.pid;
      // find which section/notebook this page belongs to
      const pg=await API.pg.get(pid);
      if(!pg) { toast('Page not found'); return; }
      $('decay-overlay').style.display='none';
      // find section and notebook
      const sec=sections.find(s=>s.id===pg.sectionId);
      if(sec) {
        if(sec.notebookId!==activeNbId) {
          await selectNotebook(sec.notebookId);
        }
        await selectSection(sec.id);
        await openPage(pid);
      } else {
        toast('Section not in current notebook — switch notebooks first');
      }
    });
  }
  renderDecayView();
}

// ═══════════════════════════════════════════════════════════════════════════════
// REVIEW FLOW
// ═══════════════════════════════════════════════════════════════════════════════
function startReview(ids) {
  reviewQueue = ids.map(id=>concepts.find(c=>c.id===id)).filter(Boolean);
  reviewIdx   = 0;
  if(!reviewQueue.length) return;
  $('review-modal').style.display='flex';
  showReviewReady(reviewQueue[0]);
}

function showReviewReady(con) {
  currentReviewCon=con;
  currentMcq=null;
  const cf=conf(con), st=statusOf(cf);
  $('review-concept-name').textContent = con.name;
  $('review-concept-sub').textContent  = con.subject + (con.important?' · ⭐ Important':'');
  $('review-conf-label').textContent   = 'Current confidence';
  $('review-conf-fill').style.width    = cf+'%';
  $('review-conf-fill').style.background = {stable:'var(--stable)',fading:'var(--fading)',critical:'var(--critical)'}[st];
  $('review-conf-pct').textContent     = cf+'% confidence';

  $('review-stage-ready').style.display ='block';
  $('review-stage-rate').style.display  ='none';
  $('review-stage-result').style.display='none';
  qa('.rate-btn').forEach(b=>b.classList.remove('selected'));

  // Pre-fetch MCQ in background while user reads the ready screen
  if (aiEnabled && con.pageId) {
    prefetchMcq(con);
  }
}

async function prefetchMcq(con) {
  try {
    const pg = await API.pg.get(con.pageId);
    if (!pg) return;
    const result = await API.ai.generateMcq({
      pageTitle:     pg.title,
      pageContent:   pg.content || '',
      highlightText: con.highlightId ? con.name : '',
    });
    if (result.success && result.mcq) {
      currentMcq = result.mcq;
    }
  } catch(_) { currentMcq = null; }
}

function showSelfRateStage() {
  $('review-stage-mcq').style.display  = 'none';
  $('review-stage-rate').style.display = 'block';
  $('review-concept-name-2').textContent = currentReviewCon?.name || '';
  qa('.rate-btn').forEach(b=>b.classList.remove('selected'));
}

function showMcqStage(mcq) {
  $('review-stage-mcq').style.display  = 'block';
  $('review-stage-rate').style.display = 'none';
  $('mcq-feedback').style.display      = 'none';
  $('mcq-explanation').style.display   = 'none';

  $('mcq-question-text').textContent = mcq.question;

  const optEl = $('mcq-options');
  optEl.innerHTML = mcq.options.map((opt, i) =>
    `<button class="mcq-opt" data-idx="${i}">${String.fromCharCode(65+i)}. ${esc(opt)}</button>`
  ).join('');

  optEl.querySelectorAll('.mcq-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const chosen  = +btn.dataset.idx;
      const correct = mcq.correct;
      const isRight = chosen === correct;

      // Disable all options
      optEl.querySelectorAll('.mcq-opt').forEach((b, i) => {
        b.disabled = true;
        if (i === correct) b.classList.add('mcq-correct');
        else if (i === chosen && !isRight) b.classList.add('mcq-wrong');
      });

      // Show feedback
      const fb = $('mcq-feedback');
      fb.textContent  = isRight ? '✓ Correct!' : '✗ Not quite';
      fb.className    = 'mcq-feedback-msg ' + (isRight ? 'mcq-fb-correct' : 'mcq-fb-wrong');
      fb.style.display = 'block';

      if (mcq.explanation) {
        $('mcq-explanation').textContent = mcq.explanation;
        $('mcq-explanation').style.display = 'block';
      }

      // Auto-submit rating after short delay
      const rating = isRight ? 4 : 2;
      setTimeout(() => submitRating(rating), 1400);
    });
  });
}

async function submitRating(rating) {
  if(!currentReviewCon) return;
  const updated = await API.con.review({ id:currentReviewCon.id, rating });
  profileCache = null; // refresh profile cache
  // update local concepts
  const i=concepts.findIndex(c=>c.id===currentReviewCon.id);
  if(i!==-1) concepts[i]=updated;

  showReviewResult(rating, updated);
}

function showReviewResult(rating, updated) {
  const icons=['','😰','😕','😐','🙂','😄'];
  const msgs=['','Blank — this one needs more attention','Vague — let\'s revisit it soon','Partial recall — getting there','Clear recall — good job!','Perfect recall — excellent!'];
  const nextDays=updated?Math.round(nextRevDays(updated)):1;

  $('review-result-icon').textContent=icons[rating];
  $('review-result-msg').textContent=msgs[rating];
  $('review-result-next').textContent=rating>=4?`Next review in ~${nextDays} day${nextDays===1?'':'s'}`:'Coming back for review soon';

  // Struggle mode — 2+ wrong in a row
  const sm=$('struggle-mode');
  const struggling=(updated?.struggleCount||0)>=2;
  sm.style.display=struggling?'block':'none';
  if(struggling) {
    const simpleText=currentReviewCon.important?`This is an important concept: "${currentReviewCon.name}". Check your notes and try to find a clear explanation or example.`:`Try looking at your notes for "${currentReviewCon.name}" and see if they explain it clearly.`;
    $('struggle-simplification').textContent=simpleText;
    $('struggle-note-link').textContent='Does your note explain this clearly? Consider rewriting one sentence.';
  }

  $('review-stage-ready').style.display ='none';
  $('review-stage-rate').style.display  ='none';
  $('review-stage-result').style.display='block';

  renderDecayStats();
  renderDecayView();
  updateDueBadge();
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
function downloadFile(content, filename, type) {
  const blob=new Blob([content],{type});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename; a.click();
  URL.revokeObjectURL(url);
}

async function exportPDF() {
  const data = await API.exp.pdfData();
  if (!data || !data.length) { toast('No notebooks to export'); return; }

  const fmtDate = ts => new Date(ts*1000).toLocaleDateString('en-US',
    { year:'numeric', month:'long', day:'numeric' });

  let body = '';
  data.forEach((nb, ni) => {
    body += '<div class="nb">';
    body += '<h1 style="border-bottom:4px solid ' + nb.color + ';padding-bottom:10px;margin-bottom:24px;font-size:26px;color:#111">' + nb.name + '</h1>';
    nb.sections.forEach(sec => {
      body += '<div class="sec">';
      body += '<h2 style="font-size:17px;font-weight:600;margin:24px 0 12px;display:flex;align-items:center;gap:8px;color:#111">'
            + '<span style="width:10px;height:10px;border-radius:3px;background:' + sec.color + ';display:inline-block;flex-shrink:0"></span>'
            + sec.name + '</h2>';
      sec.pages.forEach(pg => {
        body += '<div style="margin-bottom:22px;padding:14px 18px;border:1px solid #e5e7eb;border-radius:8px;page-break-inside:avoid">';
        body += '<div style="font-size:15px;font-weight:600;color:#111;margin-bottom:3px">'
              + pg.title
              + (pg.tracked ? ' <span style="font-size:10px;font-weight:500;color:#0d9488;background:#f0fdfa;border:1px solid #99f6e4;padding:1px 7px;border-radius:10px;margin-left:6px;vertical-align:middle">⟳ Tracked</span>' : '')
              + '</div>';
        body += '<div style="font-size:11px;color:#9ca3af;margin-bottom:10px;font-family:monospace">' + fmtDate(pg.createdAt) + '</div>';
        if (pg.content) {
          // keep formatting, strip only script/style
          const safe = pg.content
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '');
          body += '<div style="font-size:13px;line-height:1.75;color:#374151">' + safe + '</div>';
        }
        if (pg.highlights && pg.highlights.length) {
          body += '<div style="margin-top:12px;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px">';
          body += '<div style="font-size:10px;font-weight:600;color:#92400e;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">⭐ Important highlights</div>';
          pg.highlights.forEach(h => {
            body += '<div style="font-size:12px;color:#78350f;margin:3px 0">• ' + h + '</div>';
          });
          body += '</div>';
        }
        body += '</div>';
      });
      body += '</div>';
    });
    body += '</div>';
    if (ni < data.length - 1) body += '<div style="page-break-after:always"></div>';
  });

  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Mnemosyne Export</title>'
    + '<style>'
    + '* { box-sizing:border-box; margin:0; padding:0; }'
    + 'body { font-family:Segoe UI,Arial,sans-serif; font-size:13px; color:#374151; background:#fff; padding:36px; max-width:760px; margin:0 auto; }'
    + 'h1,h2,h3 { font-weight:600; }'
    + 'ul,ol { padding-left:20px; margin:6px 0; }'
    + 'li { margin:3px 0; }'
    + '.mn-highlight { background:#fef3c7; border-bottom:2px solid #f59e0b; padding:0 2px; border-radius:2px; }'
    + '@media print { body { padding:20px; } }'
    + '</style></head><body>'
    + body
    + '<div style="margin-top:36px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center">'
    + 'Exported from Mnemosyne &middot; ' + new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
    + '</div></body></html>';

  // Write to blob URL and open — Electron allows this
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, '_blank');
  if (win) {
    setTimeout(() => { win.print(); URL.revokeObjectURL(url); }, 800);
    toast('Print dialog opened — choose "Save as PDF" to export');
  } else {
    // Fallback: download as HTML if popup blocked
    downloadFile(html, 'mnemosyne-export.html', 'text/html');
    toast('Saved as HTML — open in browser and print to PDF');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTIONNAIRE
// ═══════════════════════════════════════════════════════════════════════════════

function openQuizModal() {
  if (!activePgId) { toast('Open a page first to take a quiz'); return; }
  if (!aiEnabled)  { toast('Add a GitHub token in Settings to enable quiz generation'); return; }
  $('quiz-stage-scope').style.display    = 'block';
  $('quiz-stage-loading').style.display  = 'none';
  $('quiz-stage-question').style.display = 'none';
  $('quiz-stage-results').style.display  = 'none';
  quizScope = 'page';
  qa('.quiz-scope-btn').forEach(b => b.classList.toggle('active', b.dataset.scope==='page'));
  updateQuizScopeDesc();
  $('quiz-count').value = '5';
  $('quiz-count-val').textContent = '5 questions';
  openModal('modal-quiz');
}

function updateQuizScopeDesc() {
  const el = $('quiz-scope-desc');
  if (quizScope === 'page') {
    const pg = pages.find(p => p.id === activePgId);
    el.textContent = pg ? `Will quiz you on: "${pg.title}"` : 'Current page';
  } else if (quizScope === 'section') {
    const sec = sections.find(s => s.id === activeSecId);
    el.textContent = sec ? `Will quiz you on all ${pages.length} pages in "${sec.name}"` : 'Current section';
  } else {
    const nb = notebooks.find(n => n.id === activeNbId);
    el.textContent = nb ? `Will quiz you on all pages in "${nb.name}"` : 'Current notebook';
  }
}

async function startQuiz() {
  $('quiz-stage-scope').style.display    = 'none';
  $('quiz-stage-loading').style.display  = 'flex';
  let scopeId;
  if (quizScope === 'page')         scopeId = activePgId;
  else if (quizScope === 'section') scopeId = activeSecId;
  else                              scopeId = activeNbId;
  try {
    const result = await API.ai.generateQuestionnaire({ scope: quizScope, scopeId });
    if (result.error) {
      $('quiz-stage-loading').style.display = 'none';
      $('quiz-stage-scope').style.display   = 'block';
      const msgs = { no_token:'No API token — add one in Settings', no_pages:'No notes found in this scope', api_error:'API error — check your token', parse_error:'Could not parse AI response — try again' };
      toast(msgs[result.error] || 'Quiz generation failed'); return;
    }
    quizQuestions = result.questions;
    quizPageMap   = result.pageMap || {};
    quizAnswers   = []; quizIdx = 0;
    $('quiz-stage-loading').style.display  = 'none';
    $('quiz-stage-question').style.display = 'flex';
    showQuizQuestion(0);
  } catch(e) {
    $('quiz-stage-loading').style.display = 'none';
    $('quiz-stage-scope').style.display   = 'block';
    toast('Quiz generation failed: ' + e.message);
  }
}

function showQuizQuestion(idx) {
  const q = quizQuestions[idx], tot = quizQuestions.length;
  $('quiz-progress-label').textContent = `Question ${idx+1} of ${tot}`;
  $('quiz-progress-bar').style.width   = ((idx+1)/tot*100) + '%';
  $('quiz-topic-label').textContent    = q.topic || '';
  $('quiz-question-text').textContent  = q.question;
  const optEl = $('quiz-options');
  optEl.innerHTML = q.options.map((opt,i) =>
    `<button class="mcq-opt quiz-opt" data-idx="${i}">${String.fromCharCode(65+i)}. ${esc(opt)}</button>`
  ).join('');
  $('quiz-explanation').style.display = 'none';
  $('btn-quiz-next').style.display    = 'none';
  optEl.querySelectorAll('.quiz-opt').forEach(btn=>{
    btn.addEventListener('click', ()=>handleQuizAnswer(+btn.dataset.idx, q));
  });
}

function handleQuizAnswer(chosen, q) {
  const isRight = chosen === q.correct;
  $('quiz-options').querySelectorAll('.quiz-opt').forEach((btn,i)=>{
    btn.disabled = true;
    if (i===q.correct) btn.classList.add('mcq-correct');
    else if (i===chosen && !isRight) btn.classList.add('mcq-wrong');
  });
  quizAnswers.push({ question:q, chosen, correct:isRight });
  if (q.explanation) { $('quiz-explanation').textContent=q.explanation; $('quiz-explanation').style.display='block'; }
  const btn = $('btn-quiz-next');
  btn.style.display = 'inline-flex';
  btn.textContent   = quizIdx < quizQuestions.length-1 ? 'Next →' : 'See Results →';
}

async function showQuizResults() {
  $('quiz-stage-question').style.display = 'none';
  $('quiz-stage-results').style.display  = 'flex';
  const total=quizAnswers.length, correct=quizAnswers.filter(a=>a.correct).length;
  const pct=Math.round(correct/total*100);
  const col = pct>=70?'#22c55e':pct>=50?'#f59e0b':'#ef4444';
  $('quiz-score-display').innerHTML =
    `<div class="quiz-score-circle" style="border-color:${col}">
       <span class="quiz-score-num" style="color:${col}">${pct}%</span>
       <span class="quiz-score-label">${correct} / ${total} correct</span>
     </div>`;
  $('quiz-results-list').innerHTML = quizAnswers.map((a,i)=>{
    const icon=a.correct?'✓':'✗', c=a.correct?'#22c55e':'#ef4444';
    return `<div class="quiz-result-item">
      <span style="color:${c};font-weight:600;flex-shrink:0">${icon}</span>
      <span class="quiz-result-q">Q${i+1}: ${esc(a.question.question.slice(0,70))}${a.question.question.length>70?'…':''}</span>
    </div>`;
  }).join('');

  // Option B — partial decay integration
  let decayUpdated=0, decayLogged=0;
  for (const answer of quizAnswers) {
    const conIds = quizPageMap[answer.question.topic] || [];
    for (const id of conIds) {
      const con = concepts.find(c=>c.id===id); if (!con) continue;
      if (conf(con) < 60) {
        try {
          const updated = await API.con.review({ id, rating: answer.correct?4:2 });
          const i = concepts.findIndex(c=>c.id===id); if (i!==-1) concepts[i]=updated;
          decayUpdated++;
        } catch(_) {}
      } else { decayLogged++; }
    }
  }

  $('quiz-decay-summary').innerHTML = (decayUpdated>0||decayLogged>0)
    ? `<div class="quiz-decay-info">
        <div class="quiz-decay-title">Decay Tracker Updated</div>
        ${decayUpdated>0?`<div class="quiz-decay-row updated">✓ ${decayUpdated} concept${decayUpdated===1?'':'s'} updated (were below 60% confidence)</div>`:''}
        ${decayLogged>0?`<div class="quiz-decay-row logged">◎ ${decayLogged} concept${decayLogged===1?'':'s'} logged only (still stable)</div>`:''}
       </div>`
    : '<div style="color:var(--text3);font-size:12px;padding:8px 0">No tracked concepts found in this scope — track pages or highlight text to connect results to your decay model.</div>';

  updateDueBadge();
  if ($('decay-overlay').style.display!=='none') { renderDecayStats(); renderDecayView(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  API = window.mn;

  // ── Initial state ────────────────────────────────────────────────────────────
  $('toolbar').style.display        = 'none';
  $('btn-del-page').style.display   = 'none';
  $('btn-track-page').style.display = 'none';
  $('page-editor').style.display    = 'none';
  $('nb-dropdown').classList.remove('open');
  $('decay-overlay').style.display  = 'none';
  $('decay-right').style.display    = 'none';
  $('review-modal').style.display   = 'none';
  $('note-health-bar').style.display= 'none';
  ['modal-nb','modal-sec','modal-export','modal-import'].forEach(id=>$(id).style.display='none');
  ['view-heatmap','view-list'].forEach(id=>$(id).style.display='none');

  // ── Notebook dropdown ─────────────────────────────────────────────────────────
  $('nb-selector').addEventListener('click', e=>{ e.stopPropagation(); $('nb-dropdown').classList.toggle('open'); });
  document.addEventListener('click', ()=>$('nb-dropdown').classList.remove('open'));

  // ── New notebook ─────────────────────────────────────────────────────────────
  function openNbModal() {
    $('nb-name-inp').value='';
    colorPicker('nb-colors',()=>nbColor,v=>nbColor=v);
    $('nb-dropdown').classList.remove('open');
    openModal('modal-nb');
    setTimeout(()=>$('nb-name-inp').focus(),60);
  }
  $('btn-nb-new-dd').addEventListener('click', e=>{ e.stopPropagation(); openNbModal(); });

  $('btn-nb-ok').addEventListener('click', async()=>{
    const inp=$('nb-name-inp'); const name=inp.value.trim();
    if(!name){ inp.style.borderColor='#ef4444'; inp.placeholder='Enter a name first'; setTimeout(()=>{ inp.style.borderColor=''; inp.placeholder='e.g. MTH302, Physics…'; },2000); return; }
    const btn=$('btn-nb-ok'); btn.disabled=true; btn.textContent='Creating…';
    try {
      const nb=await API.nb.add({ name, color:nbColor });
      notebooks.push(nb);
      closeModal('modal-nb');
      await selectNotebook(nb.id);
      toast(`Notebook "${name}" created`);
    } catch(e){ toast('Error creating notebook: '+e.message); }
    finally { btn.disabled=false; btn.textContent='Create notebook'; }
  });
  $('nb-name-inp').addEventListener('keydown', e=>{ if(e.key==='Enter') $('btn-nb-ok').click(); });
  $('nb-name-inp').addEventListener('input',   ()=>{ $('nb-name-inp').style.borderColor=''; });
  $('modal-nb').querySelector('.mx').addEventListener('click', ()=>closeModal('modal-nb'));
  $('modal-nb').querySelector('.btn-sec').addEventListener('click', ()=>closeModal('modal-nb'));

  // ── New section ───────────────────────────────────────────────────────────────
  $('btn-add-sec').addEventListener('click', ()=>{
    if(!activeNbId){ toast('Select a notebook first'); return; }
    $('sec-name-inp').value='';
    colorPicker('sec-colors',()=>secColor,v=>secColor=v);
    openModal('modal-sec');
    setTimeout(()=>$('sec-name-inp').focus(),60);
  });
  $('btn-sec-ok').addEventListener('click', async()=>{
    const inp=$('sec-name-inp'); const name=inp.value.trim();
    if(!name){ inp.style.borderColor='#ef4444'; inp.placeholder='Enter a name first'; setTimeout(()=>{ inp.style.borderColor=''; inp.placeholder='e.g. Unit 1, Week 3…'; },2000); return; }
    const btn=$('btn-sec-ok'); btn.disabled=true; btn.textContent='Creating…';
    try {
      const s=await API.sec.add({ notebookId:activeNbId, name, color:secColor });
      sections.push(s);
      closeModal('modal-sec');
      await selectSection(s.id);
      toast(`Section "${name}" created`);
    } catch(e){ toast('Error: '+e.message); }
    finally { btn.disabled=false; btn.textContent='Create section'; }
  });
  $('sec-name-inp').addEventListener('keydown', e=>{ if(e.key==='Enter') $('btn-sec-ok').click(); });
  $('sec-name-inp').addEventListener('input',   ()=>{ $('sec-name-inp').style.borderColor=''; });
  $('modal-sec').querySelector('.mx').addEventListener('click', ()=>closeModal('modal-sec'));
  $('modal-sec').querySelector('.btn-sec').addEventListener('click', ()=>closeModal('modal-sec'));

  // ── Pages ─────────────────────────────────────────────────────────────────────
  $('btn-add-page').addEventListener('click', async()=>{
    if(!activeSecId){ toast('Select a section first'); return; }
    const pg=await API.pg.add({ sectionId:activeSecId, title:'Untitled' });
    pages.push(pg);
    renderPageList();
    await openPage(pg.id);
    $('page-title-inp').select();
    toast('New page created');
  });
  $('btn-del-page').addEventListener('click', ()=>{ if(activePgId) deletePage(activePgId); });
  $('page-title-inp').addEventListener('input', scheduleSave);
  $('editor-body').addEventListener('input',    scheduleSave);

  // ── Track page ────────────────────────────────────────────────────────────────
  $('btn-track-page').addEventListener('click', async()=>{
    if(!activePgId){ toast('Open a page first'); return; }
    const sec=sections.find(s=>s.id===activeSecId);
    const subject=sec?sec.name:'General';
    const result=await API.pg.track({ pageId:activePgId, subject });
    if(!result) return;
    const i=pages.findIndex(p=>p.id===activePgId);
    if(result.action==='tracked'){
      if(i!==-1) pages[i].tracked=true;
      $('btn-track-page').textContent='✓ Tracked';
      $('btn-track-page').style.color='var(--teal2)';
      toast('Page added to Decay Tracker');
    } else {
      if(i!==-1) pages[i].tracked=false;
      $('btn-track-page').textContent='＋ Track Page';
      $('btn-track-page').style.color='';
      toast('Page removed from Decay Tracker');
    }
    renderPageList();
  });

  // ── Highlight ─────────────────────────────────────────────────────────────────
  $('btn-highlight-sel').addEventListener('click', markSelectionImportant);

  // ── Note health actions ───────────────────────────────────────────────────────
  $('btn-nh-expand').addEventListener('click', ()=>{
    $('note-health-bar').style.display='none';
    $('editor-body').focus();
    toast('Expand your note, then it will be tracked more reliably');
  });
  $('btn-nh-dismiss').addEventListener('click', ()=>{ $('note-health-bar').style.display='none'; });
  $('btn-nh-ignore').addEventListener('click', ()=>{
    if(activePgId) healthIgnored.add(activePgId);
    $('note-health-bar').style.display='none';
    toast('Warning dismissed for this page');
  });

  // ── Toolbar ───────────────────────────────────────────────────────────────────
  qa('.tb[data-cmd]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const cmd=btn.dataset.cmd;
      if(['h1','h2','h3'].includes(cmd)) document.execCommand('formatBlock',false,cmd);
      else document.execCommand(cmd,false,null);
      $('editor-body').focus();
    });
  });

  $('font-family').addEventListener('change', function() {
    const fam=this.value, sel=window.getSelection();
    if(!sel||sel.rangeCount===0||sel.isCollapsed){ $('editor-body').focus(); return; }
    try {
      const range=sel.getRangeAt(0);
      const span=document.createElement('span');
      span.style.fontFamily=fam;
      span.appendChild(range.extractContents());
      range.insertNode(span);
    } catch(e){ document.execCommand('fontName',false,fam); }
    $('editor-body').focus(); scheduleSave();
  });

  $('font-size').addEventListener('change', function() {
    const size=this.value, sel=window.getSelection();
    if(!sel||sel.rangeCount===0||sel.isCollapsed){ $('editor-body').focus(); return; }
    try {
      const range=sel.getRangeAt(0);
      const span=document.createElement('span');
      span.style.fontSize=size;
      span.appendChild(range.extractContents());
      range.insertNode(span);
    } catch(e){}
    $('editor-body').focus(); scheduleSave();
  });

  // ── Decay module ──────────────────────────────────────────────────────────────
  $('btn-open-decay').addEventListener('click', ()=>{
    $('decay-overlay').style.display='flex';
    loadDecay();
  });
  $('btn-close-decay').addEventListener('click', ()=>{
    $('decay-overlay').style.display='none';
    selectedConId=null;
    $('decay-right').style.display='none';
  });

  // View tabs
  qa('.dvt').forEach(btn=>{
    btn.addEventListener('click',()=>{
      qa('.dvt').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
      decayView=btn.dataset.view;
      $('view-focus').style.display   = decayView==='focus'   ? 'flex' : 'none';
      $('view-heatmap').style.display = decayView==='heatmap' ? 'flex' : 'none';
      $('view-list-wrap').style.display = decayView==='list'  ? 'block': 'none';
    });
  });

  // Sort buttons
  qa('.sort-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const newSort = btn.dataset.sort;
      if (sortBy === newSort) {
        // Same column — flip direction
        sortDir = sortDir==='asc' ? 'desc' : 'asc';
      } else {
        sortBy  = newSort;
        sortDir = 'asc';
      }
      // Update button states
      qa('.sort-btn').forEach(b=>{
        const arrow = b.querySelector('.sort-arrow');
        if (b.dataset.sort === sortBy) {
          b.classList.add('active');
          arrow.textContent = sortDir==='asc' ? '↑' : '↓';
        } else {
          b.classList.remove('active');
          arrow.textContent = '';
        }
      });
      renderListView(filteredConcepts());
    });
  });

  // Filters
  qa('.df').forEach(btn=>{
    btn.addEventListener('click',()=>{
      qa('.df').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
      decayFilter=btn.dataset.f; renderDecayView();
    });
  });
  $('con-search').addEventListener('input', renderDecayView);

  // ── Review flow ───────────────────────────────────────────────────────────────
  $('btn-review-ready').addEventListener('click',()=>{
    $('review-stage-ready').style.display='none';
    if (currentMcq && aiEnabled) {
      showMcqStage(currentMcq);
    } else {
      showSelfRateStage();
    }
  });

  $('btn-review-skip').addEventListener('click',()=>{
    $('review-modal').style.display='none';
    currentReviewCon=null;
  });

  qa('.rate-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      qa('.rate-btn').forEach(b=>b.classList.remove('selected'));
      btn.classList.add('selected');
      setTimeout(()=>submitRating(+btn.dataset.r), 200);
    });
  });

  $('btn-review-next').addEventListener('click',()=>{
    reviewIdx++;
    if(reviewIdx<reviewQueue.length) {
      showReviewReady(reviewQueue[reviewIdx]);
    } else {
      $('review-modal').style.display='none';
      currentReviewCon=null;
      toast('Review session complete');
    }
  });

  $('btn-struggle-example').addEventListener('click', async ()=>{
    if (!currentReviewCon) return;
    const btn = $('btn-struggle-example');
    btn.textContent = 'Thinking…'; btn.disabled = true;
    try {
      if (aiEnabled && currentReviewCon.pageId) {
        const pg = await API.pg.get(currentReviewCon.pageId);
        const result = await API.ai.simplify({
          conceptName: currentReviewCon.name,
          noteContent: pg?.content || '',
        });
        if (result.success && result.simplification) {
          $('struggle-simplification').textContent = result.simplification;
          btn.textContent = 'Simplified ✓'; btn.disabled = false;
          return;
        }
      }
    } catch(_) {}
    $('struggle-simplification').textContent =
      'Try looking at your notes for "' + (currentReviewCon?.name||'this concept') + '" and find a concrete example or application.';
    btn.textContent = 'See a quick example?'; btn.disabled = false;
  });

  $('btn-struggle-reset').addEventListener('click', async()=>{
    if(!currentReviewCon) return;
    await API.con.reset(currentReviewCon.id);
    const i=concepts.findIndex(c=>c.id===currentReviewCon.id);
    if(i!==-1){ concepts[i].stability=1.5; concepts[i].struggleCount=0; }
    $('review-modal').style.display='none';
    currentReviewCon=null;
    renderDecayStats(); renderDecayView();
    toast('Concept reset — it will come back for review soon');
  });

  // ── Import ────────────────────────────────────────────────────────────────────
  let importedFileData = null; // { title, text, ext }

  function openImportModal() {
    if (!activeSecId) { toast('Select a section first before importing'); return; }
    // Reset state
    importedFileData = null;
    $('import-preview-wrap').style.display = 'none';
    $('import-status').style.display = 'none';
    $('btn-import-confirm').style.display = 'none';
    $('btn-import-pick').style.display = '';
    $('import-page-title').value = '';
    $('import-preview').value = '';
    // Show destination
    const sec = sections.find(s => s.id === activeSecId);
    const nb  = notebooks.find(n => n.id === activeNbId);
    $('import-dest-name').textContent = (nb ? nb.name + ' › ' : '') + (sec ? sec.name : '—');
    openModal('modal-import');
  }

  function setImportStatus(msg, type = 'info') {
    const el = $('import-status');
    el.style.display = '';
    $('import-status-text').textContent = msg;
    el.className = 'import-status-box import-status-' + type;
  }

  $('btn-import').addEventListener('click', openImportModal);
  $('modal-import').querySelector('.mx').addEventListener('click', ()=>closeModal('modal-import'));
  $('modal-import').querySelectorAll('.btn-sec').forEach(b => b.addEventListener('click', ()=>closeModal('modal-import')));

  // Clicking a type card just shows tooltip/active state — file picker is the real trigger
  $('modal-import').querySelectorAll('.import-type-card').forEach(card => {
    card.addEventListener('click', () => {
      $('modal-import').querySelectorAll('.import-type-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });

  $('btn-import-pick').addEventListener('click', async () => {
    if (!activeSecId) { toast('Select a section first'); return; }
    const btn = $('btn-import-pick');
    btn.disabled = true; btn.textContent = 'Opening…';
    try {
      const filePath = await API.imp.pickFile();
      if (!filePath) { btn.disabled = false; btn.textContent = '📂 Choose file…'; return; }

      setImportStatus('Reading file…', 'info');
      const result = await API.imp.readFile(filePath);

      if (result.error) {
        setImportStatus('Error: ' + result.error, 'error');
        btn.disabled = false; btn.textContent = '📂 Choose file…';
        return;
      }

      importedFileData = result;
      $('import-page-title').value = result.title;
      $('import-preview').value = result.text.slice(0, 500) + (result.text.length > 500 ? '…' : '');
      $('import-preview-wrap').style.display = '';
      setImportStatus(`✓ File read successfully (${result.text.length.toLocaleString()} characters extracted)`, 'ok');
      $('btn-import-confirm').style.display = '';
      btn.textContent = '📂 Choose different file…';
    } catch(e) {
      setImportStatus('Unexpected error: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-import-confirm').addEventListener('click', async () => {
    if (!importedFileData || !activeSecId) return;
    const title   = $('import-page-title').value.trim() || importedFileData.title || 'Imported page';
    const content = importedFileData.text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>');
    const html = '<p>' + content + '</p>';
    try {
      const pg = await API.pg.add({ sectionId: activeSecId, title });
      await API.pg.save({ id: pg.id, title, content: html });
      await loadPages();
      await openPage(pg.id);
      closeModal('modal-import');
      toast('✓ Page imported: ' + title);
      importedFileData = null;
    } catch(e) {
      toast('Error creating page: ' + e.message);
    }
  });

  // ── Export ────────────────────────────────────────────────────────────────────
  $('btn-export').addEventListener('click', ()=>openModal('modal-export'));
  $('modal-export').querySelector('.mx').addEventListener('click', ()=>closeModal('modal-export'));
  $('modal-export').querySelector('.btn-sec').addEventListener('click', ()=>closeModal('modal-export'));

  $('btn-export-md').addEventListener('click', async()=>{
    const md=await API.exp.markdown();
    downloadFile(md,'mnemosyne-export.md','text/markdown');
    toast('Markdown exported');
  });
  $('btn-export-json').addEventListener('click', async()=>{
    const json=await API.exp.json();
    downloadFile(json,'mnemosyne-data.json','application/json');
    toast('JSON exported');
  });

  $('btn-export-pdf').addEventListener('click', async()=>{
    closeModal('modal-export');
    await exportPDF();
  });

  // ── Quiz / Questionnaire ─────────────────────────────────────────────────────
  $('btn-quiz').addEventListener('click', openQuizModal);

  qa('.quiz-scope-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      quizScope = btn.dataset.scope;
      qa('.quiz-scope-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      updateQuizScopeDesc();
    });
  });

  $('quiz-count').addEventListener('input', function(){
    $('quiz-count-val').textContent = this.value + ' questions';
  });

  $('btn-quiz-start').addEventListener('click', startQuiz);

  $('btn-quiz-next').addEventListener('click', ()=>{
    quizIdx++;
    if (quizIdx < quizQuestions.length) showQuizQuestion(quizIdx);
    else showQuizResults();
  });

  $('btn-quiz-retake').addEventListener('click', ()=>{
    quizAnswers=[]; quizIdx=0;
    $('quiz-stage-results').style.display  = 'none';
    $('quiz-stage-question').style.display = 'flex';
    showQuizQuestion(0);
  });

  $('modal-quiz').querySelector('.mx').addEventListener('click', ()=>closeModal('modal-quiz'));

  // ── Settings modal ───────────────────────────────────────────────────────────
  async function openSettings() {
    const s = await API.settings.get();
    const inp = $('settings-token');
    inp.value = '';
    inp.placeholder = s.hasToken
      ? 'Token saved: ' + s.tokenMasked + ' — paste new token to replace'
      : 'ghp_... or github_pat_...';
    $('settings-model').value = s.model || 'openai/gpt-5';
    updateTokenStatus(s.hasToken);
    openModal('modal-settings');
    // Don't auto-focus token — placeholder is informative
  }

  function updateTokenStatus(hasToken) {
    const el        = $('token-status');
    const clearBtn  = $('btn-token-clear');
    if (hasToken) {
      el.textContent  = '✓ AI question generation is active';
      el.className    = 'token-status token-ok';
      clearBtn.style.display = '';
    } else {
      el.innerHTML    = '→ Paste your GitHub token above and click <strong>Save settings</strong> to enable AI-generated quiz questions.';
      el.className    = 'token-status token-missing token-hint';
      clearBtn.style.display = 'none';
    }
  }

  $('btn-settings').addEventListener('click', openSettings);
  $('modal-settings').querySelector('.mx').addEventListener('click', ()=>closeModal('modal-settings'));
  $('modal-settings').querySelector('.btn-sec').addEventListener('click', ()=>closeModal('modal-settings'));

  $('btn-token-reveal').addEventListener('click', ()=>{
    const inp = $('settings-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  $('btn-token-clear').addEventListener('click', async () => {
    const btn = $('btn-token-clear');
    btn.disabled = true; btn.textContent = 'Removing…';
    try {
      await API.settings.clearToken();
      aiEnabled = false;
      $('settings-token').value = '';
      $('settings-token').placeholder = 'ghp_... or github_pat_...';
      updateTokenStatus(false);
      toast('Token removed — AI question generation deactivated');
    } catch(e) { toast('Error removing token: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = '✕ Remove token & deactivate'; }
  });

  $('btn-settings-save').addEventListener('click', async ()=>{
    const token = $('settings-token').value.trim();
    const model = $('settings-model').value;
    const btn   = $('btn-settings-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await API.settings.save({ token, model });
      const s = await API.settings.get();
      aiEnabled = s.hasToken;
      updateTokenStatus(s.hasToken);
      closeModal('modal-settings');
      toast(s.hasToken ? '✓ AI enabled — questions will generate from your notes' : 'Settings saved');
    } catch(e) { toast('Error saving: ' + e.message); }
    finally { btn.disabled = false; btn.textContent = 'Save settings'; }
  });

  // Check AI status on boot
  API.settings.get().then(s => { aiEnabled = s.hasToken; });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  document.addEventListener('keydown', e=>{
    if(e.key==='Escape'){
      ['modal-nb','modal-sec','modal-export','modal-import'].forEach(id=>$(id).style.display='none');
      if($('review-modal').style.display!=='none') $('review-modal').style.display='none';
      else if($('decay-overlay').style.display!=='none'){ $('decay-overlay').style.display='none'; selectedConId=null; }
      $('nb-dropdown').classList.remove('open');
    }
    if((e.ctrlKey||e.metaKey)&&e.key==='s'){
      e.preventDefault();
      clearTimeout(saveTimer);
      if(activePgId) API.pg.save({ id:activePgId, title:$('page-title-inp').value.trim()||'Untitled', content:$('editor-body').innerHTML }).then(()=>{ $('save-status').textContent='Saved ✓'; });
    }
    if((e.ctrlKey||e.metaKey)&&e.key==='n'){
      e.preventDefault();
      if($('decay-overlay').style.display!=='none') return;
      $('btn-add-page').click();
    }
  });

  // ── Boot ──────────────────────────────────────────────────────────────────────
  loadNotebooks()
    .then(async ()=>{
      if(notebooks.length) await selectNotebook(notebooks[0].id);
      // Load concepts just for badge count — don't need full decay open
      try {
        concepts = await API.con.list();
        updateDueBadge();
      } catch(_) {}
    })
    .catch(err=>console.error('Boot error:',err));

  // Refresh badge every 5 minutes
  setInterval(async () => {
    try {
      concepts = await API.con.list();
      updateDueBadge();
    } catch(_) {}
  }, 5 * 60 * 1000);

});
