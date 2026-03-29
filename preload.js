const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('mn', {
  nb:      {
    list:         ()   => inv('nb:list'),
    listArchived: ()   => inv('nb:list-archived'),
    add:          (d)  => inv('nb:add', d),
    rename:       (d)  => inv('nb:rename', d),
    del:          (id) => inv('nb:delete', id),
    archive:      (id) => inv('nb:archive', id),
    restore:      (id) => inv('nb:restore', id),
  },
  sec:     {
    list:   (nbId) => inv('sec:list', nbId),
    add:    (d)    => inv('sec:add', d),
    rename: (d)    => inv('sec:rename', d),
    del:    (id)   => inv('sec:delete', id),
  },
  pg:      {
    list:   (secId) => inv('pg:list', secId),
    get:    (id)    => inv('pg:get', id),
    add:    (d)     => inv('pg:add', d),
    save:   (d)     => inv('pg:save', d),
    del:    (id)    => inv('pg:delete', id),
    track:  (d)     => inv('pg:track', d),
  },
  hl:      {
    list:   (pgId) => inv('hl:list', pgId),
    add:    (d)    => inv('hl:add', d),
    del:    (id)   => inv('hl:delete', id),
  },
  con:     {
    list:       ()  => inv('con:list'),
    review:     (d) => inv('con:review', d),
    reset:      (id)=> inv('con:struggle-reset', id),
    history:    (id)=> inv('con:history', id),
    updateMeta: (d) => inv('con:update-meta', d),
  },
  profile: {
    get: () => inv('profile:get'),
  },
  exp:     {
    json:     () => inv('export:json'),
    markdown: () => inv('export:markdown'),
    pdfData:  () => inv('export:pdf-data'),
  },
  note:    {
    health: (d) => inv('note:health', d),
  },
  settings: {
    get:        ()  => inv('settings:get'),
    save:       (d) => inv('settings:save', d),
    clearToken: ()  => inv('settings:clear-token'),
  },
  ai: {
    generateMcq:          (d) => inv('ai:generate-mcq', d),
    simplify:             (d) => inv('ai:simplify', d),
    generateQuestionnaire:(d) => inv('ai:generate-questionnaire', d),
  },
  imp: {
    pickFile:  ()         => inv('import:pick-file'),
    readFile:  (filePath) => inv('import:read-file', filePath),
  },
});
