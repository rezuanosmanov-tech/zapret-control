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
  fakesList:      () => invoke('fakes:list'),
  fakesApply:     (slot, file) => invoke('fakes:apply', slot, file),
  autoUpdateGet:  () => invoke('autoupdate:get'),
  autoUpdateSet:  (on) => invoke('autoupdate:set', on),


  diagRun:        () => invoke('diag:run'),
  diagFix:        (f) => invoke('diag:fix', f),
  clearDiscord:   () => invoke('diag:clearDiscord'),

  checkApp:       () => invoke('update:checkApp'),
  updateIpset:    () => invoke('update:ipset'),
  updateHosts:    () => invoke('update:hosts'),

  monitorInfo:    () => invoke('monitor:info'),
  logSave:        () => invoke('log:save'),
  setPref:        (key, value) => invoke('config:setPref', key, value),
  onMonitor:      (cb) => ipcRenderer.on('monitor:event', (_e, ev) => cb(ev)),

  autostartGet:   () => invoke('autostart:get'),
  autostartSet:   (on, hidden) => invoke('autostart:set', on, hidden),

  testRun:        (mode, list, baseline) => invoke('test:run', mode, list, baseline),
  testAbort:      () => invoke('test:abort'),
  testResultsFile:() => invoke('test:resultsFile'),
  openTestResults:() => invoke('test:openResults'),
  onTestEvent:    (cb) => ipcRenderer.on('test:event', (_e, ev) => cb(ev)),

  listPage:       (w, opts) => invoke('list:page', w, opts),
  listAdd:        (w, v) => invoke('list:add', w, v),
  listAddPreset:  (w, arr) => invoke('list:addPreset', w, arr),
  listRemove:     (w, v) => invoke('list:remove', w, v),
  listClear:      (w) => invoke('list:clear', w),
  listPresets:    () => invoke('list:presets'),

  openExternal:   (url) => invoke('open:external', url),
  openFolder:     () => invoke('open:folder'),

  uninstallApp:   () => invoke('control:uninstallApp'),

  onLog:          (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});
