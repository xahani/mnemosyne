const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow;
let dbPath;

// ─── DB ───────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  // notebooks
  nextNotebookId: 1, notebooks: [],
  // sections
  nextSectionId: 1,  sections: [],
  // pages
  nextPageId: 1,     pages: [],
  // highlights
  nextHighlightId: 1, highlights: [],
  // decay
  nextConceptId: 1,  concepts: [],
  nextReviewId: 1,   reviews: [],
  // profile (auto-built from usage)
  profile: {
    baseMultiplier: 1.0,
    subjectMultipliers: {},
    avgReviewDelay: 1.0,
    totalReviews: 0,
    lastSubjectReviewed: null,
    sessionDates: [],        // array of date strings for frequency calculation
    createdAt: 0
  }
};

function loadDB() {
  try {
    const raw  = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const merged = Object.assign({}, DEFAULTS, raw);
    // ensure arrays always exist
    ['notebooks','sections','pages','highlights','concepts','reviews'].forEach(k => {
      if (!Array.isArray(merged[k])) merged[k] = [];
    });
    if (!merged.profile) merged.profile = { ...DEFAULTS.profile };
    return merged;
  } catch (_) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function saveDB(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

function ts() { return Math.floor(Date.now() / 1000); }

function todayStr() { return new Date().toISOString().slice(0, 10); }

// Track session date for frequency calculation
function recordSession(db) {
  const today = todayStr();
  if (!db.profile.sessionDates.includes(today)) {
    db.profile.sessionDates.push(today);
    // keep only last 90 days
    if (db.profile.sessionDates.length > 90) {
      db.profile.sessionDates = db.profile.sessionDates.slice(-90);
    }
    recalcFrequency(db);
  }
}

function recalcFrequency(db) {
  const dates = db.profile.sessionDates;
  if (dates.length < 2) return;
  // avg days between sessions over last 30 sessions
  const recent = dates.slice(-30);
  let totalGap = 0;
  for (let i = 1; i < recent.length; i++) {
    const a = new Date(recent[i-1]), b = new Date(recent[i]);
    totalGap += (b - a) / 86400000;
  }
  const avgGap = totalGap / (recent.length - 1);
  // avgGap 1 = daily (multiplier 1.2), avgGap 7 = weekly (multiplier 0.75)
  const mult = Math.max(0.6, Math.min(1.4, 1.4 - (avgGap - 1) * 0.1));
  db.profile.baseMultiplier = parseFloat(mult.toFixed(2));
}

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  // Pick correct icon format per platform
  const iconFile = process.platform === 'win32'
    ? path.join(__dirname, 'build', 'icon.ico')
    : process.platform === 'darwin'
      ? path.join(__dirname, 'build', 'icon.icns')
      : path.join(__dirname, 'build', 'icons', '512x512.png');

  mainWindow = new BrowserWindow({
    width: 1400, height: 860,
    minWidth: 1024, minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f0f17',
    icon: iconFile,
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  dbPath       = path.join(app.getPath('userData'), 'mnemosyne.json');
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  // Set app icon for taskbar (Windows)
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.mnemosyne.app');
  }
  // record this session
  const db = loadDB();
  if (!db.profile.createdAt) db.profile.createdAt = ts();
  recordSession(db);
  saveDB(db);
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ═══════════════════════════════════════════════════════════════════════════════
// IPC — NOTEBOOKS
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('nb:list',          () => loadDB().notebooks.filter(n => !n.archived));
ipcMain.handle('nb:list-archived', () => loadDB().notebooks.filter(n =>  n.archived));

ipcMain.handle('nb:archive', (_, id) => {
  const db = loadDB();
  const nb = db.notebooks.find(n => n.id === id);
  if (nb) { nb.archived = true; saveDB(db); }
  return nb;
});

ipcMain.handle('nb:restore', (_, id) => {
  const db = loadDB();
  const nb = db.notebooks.find(n => n.id === id);
  if (nb) { nb.archived = false; saveDB(db); }
  return nb;
});

ipcMain.handle('nb:add', (_, { name, color }) => {
  const db = loadDB();
  const nb = { id: db.nextNotebookId++, name: name.trim(), color: color || '#6366f1', createdAt: ts() };
  db.notebooks.push(nb);
  saveDB(db); return nb;
});

ipcMain.handle('nb:rename', (_, { id, name }) => {
  const db = loadDB();
  const nb = db.notebooks.find(n => n.id === id);
  if (nb) { nb.name = name.trim(); saveDB(db); }
  return nb;
});

ipcMain.handle('nb:delete', (_, id) => {
  const db = loadDB();
  const sids = db.sections.filter(s => s.notebookId === id).map(s => s.id);
  const pids = db.pages.filter(p => sids.includes(p.sectionId)).map(p => p.id);
  db.highlights = db.highlights.filter(h => !pids.includes(h.pageId));
  db.concepts   = db.concepts.filter(c => !pids.includes(c.pageId));
  db.pages      = db.pages.filter(p => !sids.includes(p.sectionId));
  db.sections   = db.sections.filter(s => s.notebookId !== id);
  db.notebooks  = db.notebooks.filter(n => n.id !== id);
  saveDB(db); return { success: true };
});

// ═══════════════════════════════════════════════════════════════════════════════
// IPC — SECTIONS
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('sec:list', (_, nbId) => loadDB().sections.filter(s => s.notebookId === nbId));

ipcMain.handle('sec:add', (_, { notebookId, name, color }) => {
  const db = loadDB();
  const s = { id: db.nextSectionId++, notebookId, name: name.trim(), color: color || '#6366f1', createdAt: ts() };
  db.sections.push(s); saveDB(db); return s;
});

ipcMain.handle('sec:rename', (_, { id, name }) => {
  const db = loadDB();
  const s = db.sections.find(s => s.id === id);
  if (s) { s.name = name.trim(); saveDB(db); }
  return s;
});

ipcMain.handle('sec:delete', (_, id) => {
  const db = loadDB();
  const pids = db.pages.filter(p => p.sectionId === id).map(p => p.id);
  db.highlights = db.highlights.filter(h => !pids.includes(h.pageId));
  db.concepts   = db.concepts.filter(c => !pids.includes(c.pageId));
  db.pages      = db.pages.filter(p => p.sectionId !== id);
  db.sections   = db.sections.filter(s => s.id !== id);
  saveDB(db); return { success: true };
});

// ═══════════════════════════════════════════════════════════════════════════════
// IPC — PAGES
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('pg:list', (_, secId) =>
  loadDB().pages
    .filter(p => p.sectionId === secId)
    .map(p => ({ id:p.id, sectionId:p.sectionId, title:p.title, createdAt:p.createdAt, updatedAt:p.updatedAt, tracked:p.tracked }))
);

ipcMain.handle('pg:get', (_, id) => loadDB().pages.find(p => p.id === id) || null);

ipcMain.handle('pg:add', (_, { sectionId, title }) => {
  const db = loadDB();
  const pg = { id: db.nextPageId++, sectionId, title: (title||'Untitled').trim(),
    content: '', createdAt: ts(), updatedAt: ts(), tracked: false };
  db.pages.push(pg); saveDB(db); return pg;
});

ipcMain.handle('pg:save', (_, { id, title, content }) => {
  const db = loadDB();
  const pg = db.pages.find(p => p.id === id);
  if (pg) { pg.title = (title||'Untitled').trim(); pg.content = content; pg.updatedAt = ts(); saveDB(db); }
  return pg;
});

ipcMain.handle('pg:delete', (_, id) => {
  const db = loadDB();
  db.highlights = db.highlights.filter(h => h.pageId !== id);
  db.concepts   = db.concepts.filter(c => c.pageId !== id);
  db.pages      = db.pages.filter(p => p.id !== id);
  saveDB(db); return { success: true };
});

// Track/untrack a page
ipcMain.handle('pg:track', (_, { pageId, subject }) => {
  const db  = loadDB();
  const pg  = db.pages.find(p => p.id === pageId);
  if (!pg) return null;

  const existing = db.concepts.find(c => c.pageId === pageId && !c.highlightId);
  if (existing) {
    // toggle off
    existing.archived = true;
    pg.tracked = false;
    saveDB(db);
    return { action: 'untracked', concept: existing };
  }

  pg.tracked = true;
  const con = {
    id:           db.nextConceptId++,
    pageId,
    highlightId:  null,
    name:         pg.title,
    subject:      subject || 'General',
    stability:    2.0,
    bestStability: 2.0,
    last_reviewed: ts(),
    created_at:   ts(),
    reviewCount:  0,
    questionType: 'self', // self-rate until AI added
    archived:     false,
    struggleCount: 0,
    lastStruggleAt: null,
  };
  db.concepts.push(con);
  saveDB(db);
  return { action: 'tracked', concept: con };
});

// ═══════════════════════════════════════════════════════════════════════════════
// IPC — HIGHLIGHTS
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('hl:list', (_, pageId) => loadDB().highlights.filter(h => h.pageId === pageId));

ipcMain.handle('hl:add', (_, { pageId, text, subject }) => {
  const db = loadDB();
  const pg = db.pages.find(p => p.id === pageId);
  if (!pg) return null;

  const hl = {
    id: db.nextHighlightId++, pageId,
    text: text.trim(), subject: subject || 'General',
    createdAt: ts(), archived: false
  };
  db.highlights.push(hl);

  // Auto-create a concept for this highlight
  const con = {
    id:            db.nextConceptId++,
    pageId,
    highlightId:   hl.id,
    name:          text.trim().slice(0, 80),
    subject:       subject || 'General',
    stability:     3.0,        // highlights start with higher stability (important)
    bestStability: 3.0,
    last_reviewed: ts(),
    created_at:   ts(),
    reviewCount:  0,
    questionType: 'self',
    archived:     false,
    struggleCount: 0,
    lastStruggleAt: null,
    important:    true,
  };
  db.concepts.push(con);
  saveDB(db);
  return { highlight: hl, concept: con };
});

ipcMain.handle('hl:delete', (_, id) => {
  const db = loadDB();
  db.highlights = db.highlights.filter(h => h.id !== id);
  db.concepts   = db.concepts.filter(c => c.highlightId !== id);
  saveDB(db); return { success: true };
});

// ═══════════════════════════════════════════════════════════════════════════════
// IPC — CONCEPTS / DECAY
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('con:list', () => loadDB().concepts.filter(c => !c.archived));

ipcMain.handle('con:review', (_, { id, rating }) => {
  // rating: 1-5 self-assessment
  // 1=blank, 2=vague, 3=partial, 4=clear, 5=perfect
  const db  = loadDB();
  const con = db.concepts.find(c => c.id === id);
  if (!con) return null;

  const now        = ts();
  const daysSince  = (now - con.last_reviewed) / 86400;
  const scheduled  = con.stability;
  const performance = daysSince / scheduled;

  // Confidence at moment of review
  const confAtReview = Math.max(0, Math.round(100 * Math.exp(-daysSince / con.stability)));

  // Performance factor based on rating + timing
  let perfFactor;
  if (rating >= 4) {
    perfFactor = performance > 1.2 ? 2.5 : performance > 0.8 ? 2.0 : 1.3;
  } else if (rating === 3) {
    perfFactor = 1.1;
  } else if (rating === 2) {
    perfFactor = 0.7;
    con.struggleCount = (con.struggleCount || 0) + 1;
  } else {
    // rating 1 — blank
    perfFactor = 0.4;
    con.struggleCount = (con.struggleCount || 0) + 1;
  }

  // Question type factor (self-rate for now)
  const qFactor = 1.0; // will become 1.8 for MCQ, 2.2 fill, 2.5 recall when AI added

  // Interleaving bonus
  const profile = db.profile;
  const interleaveBonus = profile.lastSubjectReviewed && profile.lastSubjectReviewed !== con.subject ? 1.15 : 1.0;

  // Compute new stability
  let newStability = con.stability * perfFactor * qFactor * interleaveBonus;

  // Clamp: no more than ×3 increase or ×0.4 decrease in one review
  newStability = Math.min(newStability, con.stability * 3.0);
  newStability = Math.max(newStability, con.stability * 0.4);

  // Protected floor: never below 30% of best
  const floor = (con.bestStability || con.stability) * 0.3;
  newStability = Math.max(newStability, floor);

  // Hard caps
  newStability = Math.max(0.5, Math.min(90, newStability));

  con.stability      = parseFloat(newStability.toFixed(2));
  con.bestStability  = Math.max(con.bestStability || 0, con.stability);
  con.last_reviewed  = now;
  con.reviewCount    = (con.reviewCount || 0) + 1;

  // Update subject multiplier
  if (!profile.subjectMultipliers[con.subject]) profile.subjectMultipliers[con.subject] = 1.0;
  const drift = rating >= 4 ? 0.05 : rating <= 2 ? -0.05 : 0;
  profile.subjectMultipliers[con.subject] = parseFloat(
    Math.max(0.5, Math.min(2.0, profile.subjectMultipliers[con.subject] + drift)).toFixed(2)
  );

  profile.lastSubjectReviewed = con.subject;
  profile.totalReviews = (profile.totalReviews || 0) + 1;

  // Log review
  db.reviews.push({
    id:          db.nextReviewId++,
    conceptId:   id,
    reviewedAt:  now,
    rating,
    confAtReview,
    newStability: con.stability,
  });

  // Reset struggle count on good rating
  if (rating >= 4) con.struggleCount = 0;

  saveDB(db);
  return con;
});

ipcMain.handle('con:struggle-reset', (_, id) => {
  const db  = loadDB();
  const con = db.concepts.find(c => c.id === id);
  if (!con) return null;
  con.stability     = 1.5;
  con.bestStability = Math.max(con.bestStability || 0, 1.5);
  con.last_reviewed = ts();
  con.struggleCount = 0;
  con.lastStruggleAt = ts();
  saveDB(db);
  return con;
});

ipcMain.handle('con:update-meta', (_, { id, name, subject }) => {
  const db  = loadDB();
  const con = db.concepts.find(c => c.id === id);
  if (!con) return null;
  con.name    = name.trim();
  con.subject = subject.trim();
  saveDB(db);
  return con;
});

ipcMain.handle('con:history', (_, id) =>
  loadDB().reviews.filter(r => r.conceptId === id).sort((a,b) => b.reviewedAt - a.reviewedAt).slice(0, 30)
);

// ═══════════════════════════════════════════════════════════════════════════════
// IPC — PROFILE & EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('profile:get', () => loadDB().profile);

ipcMain.handle('export:json', () => {
  const db = loadDB();
  return JSON.stringify(db, null, 2);
});

ipcMain.handle('export:markdown', () => {
  const db = loadDB();
  let md = '# Mnemosyne Export\n\n';
  db.notebooks.forEach(nb => {
    md += `# ${nb.name}\n\n`;
    db.sections.filter(s => s.notebookId === nb.id).forEach(sec => {
      md += `## ${sec.name}\n\n`;
      db.pages.filter(p => p.sectionId === sec.id).forEach(pg => {
        md += `### ${pg.title}\n\n`;
        // strip HTML tags for markdown
        const text = (pg.content || '').replace(/<[^>]+>/g, '').trim();
        if (text) md += text + '\n\n';
        // highlights
        const hls = db.highlights.filter(h => h.pageId === pg.id);
        if (hls.length) {
          md += '**Important highlights:**\n';
          hls.forEach(h => { md += `- ⭐ ${h.text}\n`; });
          md += '\n';
        }
      });
    });
  });
  return md;
});

// ── Settings (token stored in separate file, not in notes DB) ─────────────────
const { shell } = require('electron');
let settingsPath;

function loadSettings() {
  try {
    if (!settingsPath) return {};
    return JSON.parse(require('fs').readFileSync(settingsPath, 'utf8'));
  } catch(_) { return {}; }
}
function saveSettings(s) {
  require('fs').writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
}

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  // Never send raw token to renderer — send masked version for display
  return {
    hasToken: !!s.token,
    tokenMasked: s.token ? s.token.slice(0,8) + '...' + s.token.slice(-4) : '',
    model: s.model || 'openai/gpt-5',
  };
});

ipcMain.handle('settings:save', (_, { token, model }) => {
  const s = loadSettings();
  if (token && token.trim()) s.token = token.trim();
  if (model) s.model = model;
  saveSettings(s);
  return { success: true };
});

ipcMain.handle('settings:clear-token', () => {
  const s = loadSettings();
  delete s.token;
  saveSettings(s);
  return { success: true };
});

// AI question generation via GitHub Models
ipcMain.handle('ai:generate-mcq', async (_, { pageTitle, pageContent, highlightText }) => {
  const s = loadSettings();
  if (!s.token) return { error: 'no_token' };

  const model   = s.model || 'openai/gpt-5';
  const subject = highlightText || pageTitle;

  // Strip HTML for cleaner context
  const plainContent = pageContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);

  const prompt = `You are generating a multiple choice review question for a student.

Page title: "${pageTitle}"
${highlightText ? `Focus on this highlighted concept: "${highlightText}"` : ''}

Student's notes:
${plainContent}

Generate ONE multiple choice question based on these notes. The question should test genuine understanding, not just recognition.

Respond with ONLY valid JSON in this exact format:
{
  "question": "The question text here?",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "correct": 0,
  "explanation": "Brief explanation of why the correct answer is right"
}

Rules:
- correct is the index (0-3) of the correct option in the options array
- Make all 4 options plausible — avoid obviously wrong answers
- Base the question entirely on the student's own notes
- Keep the question clear and concise`;

  try {
    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + s.token,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return { error: 'api_error', detail: err };
    }

    const data  = await res.json();
    const text  = data.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { success: true, mcq: parsed };
  } catch(e) {
    return { error: 'parse_error', detail: e.message };
  }
});

// AI struggle mode simplification
ipcMain.handle('ai:simplify', async (_, { conceptName, noteContent }) => {
  const s = loadSettings();
  if (!s.token) return { error: 'no_token' };

  const model = s.model || 'openai/gpt-5';
  const plain = (noteContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

  const prompt = `A student is struggling to remember this concept: "${conceptName}"

Their notes say:
${plain || '(no notes yet)'}

Write ONE sentence that captures the core idea in the simplest possible plain English. 
No jargon. Maximum 25 words. Just the sentence, nothing else.`;

  try {
    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + s.token,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 60,
        temperature: 0.5,
      }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    return { success: true, simplification: text };
  } catch(e) {
    return { error: 'parse_error', detail: e.message };
  }
});

// ── AI Questionnaire generation ───────────────────────────────────────────────
ipcMain.handle('ai:generate-questionnaire', async (_, { scope, scopeId }) => {
  const s = loadSettings();
  if (!s.token) return { error: 'no_token' };

  const db    = loadDB();
  const model = s.model || 'openai/gpt-5';

  // Collect pages based on scope
  let pages = [];
  let scopeName = '';

  if (scope === 'page') {
    const pg = db.pages.find(p => p.id === scopeId);
    if (pg) { pages = [pg]; scopeName = pg.title; }
  } else if (scope === 'section') {
    pages = db.pages.filter(p => p.sectionId === scopeId);
    const sec = db.sections.find(s => s.id === scopeId);
    scopeName = sec ? sec.name : 'Section';
  } else if (scope === 'notebook') {
    const sids = db.sections.filter(s => s.notebookId === scopeId).map(s => s.id);
    pages = db.pages.filter(p => sids.includes(p.sectionId));
    const nb = db.notebooks.find(n => n.id === scopeId);
    scopeName = nb ? nb.name : 'Notebook';
  }

  if (!pages.length) return { error: 'no_pages' };

  // Build combined content from all pages (strip HTML, limit total)
  let combinedContent = '';
  let pageMap = {};   // title → array of concept ids for decay update

  pages.forEach(pg => {
    const plain = (pg.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain.length > 50) {
      combinedContent += `\n\n--- ${pg.title} ---\n${plain}`;
      // Find concepts linked to this page
      const cons = db.concepts.filter(c => c.pageId === pg.id && !c.archived);
      pageMap[pg.title] = cons.map(c => c.id);
    }
  });

  // Truncate to ~6000 chars to stay within token limits
  if (combinedContent.length > 6000) {
    combinedContent = combinedContent.slice(0, 6000) + '...';
  }

  const questionCount = Math.min(10, Math.max(5, pages.length * 2));

  const prompt = `You are generating a multiple choice questionnaire for a student to test themselves.

Topic: "${scopeName}"

Student's notes:
${combinedContent}

Generate exactly ${questionCount} multiple choice questions based on these notes.
Use a variety of question styles:
- Definition questions ("Which best describes X?")
- Application questions ("If Y, what is Z?")
- Comparison questions ("What is the difference between A and B?")
- Elimination questions ("Which of the following is NOT true about X?")

Spread questions across all topics covered in the notes. Do not repeat similar questions.

Respond with ONLY valid JSON — an array of question objects:
[
  {
    "question": "Question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Why this answer is correct",
    "topic": "The page title or topic this question relates to"
  }
]

Rules:
- correct is the zero-based index of the correct option
- All 4 options must be plausible — no obviously wrong answers
- Base every question strictly on the student's own notes
- topic must match one of the page titles exactly`;

  try {
    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + s.token,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2000,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return { error: 'api_error', detail: err };
    }

    const data  = await res.json();
    const text  = data.choices?.[0]?.message?.content || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const questions = JSON.parse(clean);

    return {
      success:   true,
      questions,
      scopeName,
      pageMap,   // used by renderer to find concept ids per topic
      totalPages: pages.length,
    };
  } catch(e) {
    return { error: 'parse_error', detail: e.message };
  }
});

ipcMain.handle('export:pdf-data', () => {
  const db = loadDB();
  const result = [];
  db.notebooks.forEach(nb => {
    const nbData = { name: nb.name, color: nb.color, sections: [] };
    db.sections.filter(s => s.notebookId === nb.id).forEach(sec => {
      const secData = { name: sec.name, color: sec.color, pages: [] };
      db.pages.filter(p => p.sectionId === sec.id).forEach(pg => {
        const hls = db.highlights.filter(h => h.pageId === pg.id);
        secData.pages.push({
          title:      pg.title || 'Untitled',
          content:    pg.content || '',
          createdAt:  pg.createdAt,
          tracked:    !!pg.tracked,
          highlights: hls.map(h => h.text),
        });
      });
      nbData.sections.push(secData);
    });
    result.push(nbData);
  });
  return result;
});

// ── PDF / TEXT IMPORT ─────────────────────────────────────────────────────────

ipcMain.handle('import:pick-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import file into Mnemosyne',
    filters: [
      { name: 'Supported files', extensions: ['pdf', 'txt', 'md'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Text / Markdown', extensions: ['txt', 'md'] },
    ],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('import:read-file', (_, filePath) => {
  try {
    const ext  = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath, ext);
    const buf  = fs.readFileSync(filePath);

    if (ext === '.pdf') {
      // Lightweight text extraction: grab all readable ASCII runs from PDF streams
      const raw = buf.toString('latin1');
      // Extract text inside BT...ET blocks (standard PDF text operators)
      const chunks = [];
      const btEt = /BT\s([\s\S]*?)ET/g;
      let m;
      while ((m = btEt.exec(raw)) !== null) {
        // Grab strings inside parentheses (Tj / TJ operators)
        const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
        let s;
        while ((s = strRe.exec(m[1])) !== null) {
          const decoded = s[1]
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '')
            .replace(/\\t/g, ' ')
            .replace(/\\\\/g, '\\')
            .replace(/\\(\(|\))/g, '$1');
          if (decoded.trim()) chunks.push(decoded);
        }
      }
      // Also catch hex strings <...>
      const hexRe = /<([0-9A-Fa-f]+)>/g;
      while ((m = hexRe.exec(raw)) !== null) {
        const hex = m[1];
        if (hex.length % 2 !== 0 || hex.length < 4) continue;
        let str = '';
        for (let i = 0; i < hex.length; i += 2)
          str += String.fromCharCode(parseInt(hex.slice(i, i+2), 16));
        if (/[a-zA-Z]{3,}/.test(str)) chunks.push(str);
      }
      const text = chunks.join(' ').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return { title: base, text: text || '(No readable text found in this PDF — it may be scanned or image-based.)', ext };
    }

    // Plain text / markdown
    return { title: base, text: buf.toString('utf8'), ext };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('note:health', (_, { content, title }) => {
  // Rules-based note health — no AI needed
  const text = (content || '').replace(/<[^>]+>/g, '').trim();
  const issues = [];

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 5);
  if (sentences.length < 3) issues.push('too_short');

  const hasExample = /example|e\.g\.|for instance|such as|consider|e\.g|:\s*\d/i.test(text)
    || /\d+/.test(text);
  if (!hasExample) issues.push('no_example');

  const hasSubstance = text.length > 100;
  if (!hasSubstance && !issues.includes('too_short')) issues.push('too_brief');

  return {
    healthy: issues.length === 0,
    issues,
    score: Math.max(0, 3 - issues.length), // 0-3
  };
});
