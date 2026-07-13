'use strict';
// Безопасный мост: рендерер получает только этот ограниченный набор функций,
// прямого доступа к Node/ФС у интерфейса нет.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('zapret', {
  isAdmin:        () => invoke('app:isAdmin'),
  relaunchAdmin:  () => invoke('app:relaunchAdmin'),

  getConfig:      () => invoke('config:get'),
  pickFolder:     () => invoke('config:pickFolder'),
  pickZip:        () => invoke('config:pickZip'),
  applyZip:       (p) => invoke('zip:apply', p),

  status:         () => invoke('status:get'),
  strategies:     () => invoke('strategies:list'),
  start:          (bat) => invoke('control:start', bat),
  installService: (bat) => invoke('control:installService', bat),
  stop:           () => invoke('control:stop'),

  gameGet:        () => invoke('game:get'),
  gameSet:        (m) => invoke('game:set', m),
  ipsetGet:       () => invoke('ipset:get'),
  ipsetSet:       (t) => invoke('ipset:set', t),
  autoUpdateGet:  () => invoke('autoupdate:get'),
  autoUpdateSet:  (on) => invoke('autoupdate:set', on),

  listRead:       (w) => invoke('list:read', w),
  listAdd:        (w, v) => invoke('list:add', w, v),
  listRemove:     (w, v) => invoke('list:remove', w, v),
  listWrite:      (w, items) => invoke('list:write', w, items),

  diagRun:        () => invoke('diag:run'),
  diagFix:        (f) => invoke('diag:fix', f),
  clearDiscord:   () => invoke('diag:clearDiscord'),

  checkApp:       () => invoke('update:checkApp'),
  updateIpset:    () => invoke('update:ipset'),
  updateHosts:    () => invoke('update:hosts'),

  openExternal:   (url) => invoke('open:external', url),
  openFolder:     () => invoke('open:folder'),

  onLog:          (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});
