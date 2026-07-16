'use strict';
/*
 * Zapret Control — главный процесс Electron.
 * Здесь живёт вся привилегированная логика: запуск winws.exe, установка/удаление
 * службы, диагностика, работа со списками, обновления и распаковка нового zip.
 * Рендерер (интерфейс) вызывает эти функции только через безопасный мост preload.js.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const PRESETS = require('./presets');
const { spawn, exec, execFile } = require('child_process');

// ------------------------------------------------------------------ конфиг ---
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const INSTALLS_DIR = path.join(app.getPath('userData'), 'installs');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { activePath: null }; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
function activePath() { return readConfig().activePath; }

// Пути внутри активной установки Zapret
const P = {
  bin: () => path.join(activePath(), 'bin'),
  lists: () => path.join(activePath(), 'lists'),
  utils: () => path.join(activePath(), 'utils'),
  service: () => path.join(activePath(), 'service.bat'),
};

// --------------------------------------------------------------- утилиты ------
// Выполнить команду в cmd.exe и вернуть stdout/stderr/код.
// chcp 65001 переключает консоль в UTF-8 перед командой — без этого команды вроде
// sc/reg/tasklist на русской Windows выводят кириллицу в кодировке OEM (866),
// а мы декодируем как UTF-8, и текст превращается в кракозябры.
function run(cmd, opts = {}) {
  const wrapped = `chcp 65001>nul & ${cmd}`;
  const quiet = opts.quiet;                 // рутинный опрос статуса — не логируем
  if (opts.quiet !== undefined) { opts = { ...opts }; delete opts.quiet; }
  return new Promise((resolve) => {
    exec(wrapped, { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16, ...opts },
      (err, stdout, stderr) => {
        const code = err ? (err.code ?? 1) : 0;
        // В тех-лог пишем команды-действия и любые реальные ошибки. Частый опрос
        // статуса (sc query / tasklist каждые 5 сек) помечен quiet и молчит,
        // кроме случаев, когда команда неожиданно упала.
        if (!quiet) {
          logTech(`$ ${cmd}  →  code ${code}`);
          if (stderr && stderr.trim()) logTech('  stderr: ' + stderr.trim().split(/\r?\n/)[0]);
        }
        resolve({ code, stdout: stdout || '', stderr: stderr || '' });
      });
  });
}
// Выполнить PowerShell-скрипт и вернуть stdout.
function ps(script) {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: stdout || '', stderr: stderr || '' }));
  });
}

let mainWindow = null;
/*
 * Журнал в два слоя. log() — человеческие сообщения (их видит любой пользователь
 * в простой вкладке). logTech() — сырой технический вывод (команды, коды, stderr).
 * Оба слоя копятся в кольцевых буферах, чтобы кнопка «Сохранить лог» могла выгрузить
 * их в файл даже то, что уже уехало за пределы видимой области.
 */
const LOG_BUF = { simple: [], tech: [] };
const LOG_BUF_MAX = 2000;
function sendLog(level, line) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
  LOG_BUF.tech.push(stamped);
  if (level === 'simple') LOG_BUF.simple.push(stamped);
  if (LOG_BUF.tech.length > LOG_BUF_MAX) LOG_BUF.tech.shift();
  if (LOG_BUF.simple.length > LOG_BUF_MAX) LOG_BUF.simple.shift();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', { level, line, ts: Date.now() });
}
function log(line)     { sendLog('simple', line); }   // видят все
function logTech(line) { sendLog('tech', line); }      // только расширенная вкладка

// Проверка прав администратора (net session возвращает 0 только под админом).
async function isAdmin() {
  const r = await run('net session >nul 2>&1');
  return r.code === 0;
}

/*
 * Автоматический запрос прав администратора при запуске.
 * Если прав нет — пробуем перезапуститься через UAC. Пометка --elevation-tried
 * не даёт зациклиться, если пользователь нажмёт "Нет": в этом случае просто
 * продолжаем работать без прав, а в интерфейсе останется кнопка для ручного
 * повышения прав.
 */
async function autoElevate() {
  if (process.platform !== 'win32') return true;
  if (await isAdmin()) return true;
  if (process.argv.includes('--elevation-tried')) return false;

  const exe = process.execPath;
  const args = process.argv.slice(1).filter(a => a !== '--elevation-tried');
  args.push('--elevation-tried');
  const argList = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');

  const r = await ps(`Start-Process -FilePath '${exe}' -ArgumentList ${argList} -Verb RunAs`);
  if (r.code === 0) {
    // Новый процесс с правами запущен — этот закрываем.
    app.isQuitting = true;
    app.quit();
    return true;
  }
  // Пользователь отказался в окне UAC — работаем без прав.
  return false;
}

// ------------------------------------------------------ парсер стратегии ------
/*
 * Читаем выбранный general*.bat, вытаскиваем вызов winws.exe со всеми аргументами
 * и подставляем плейсхолдеры (%BIN%, %LISTS%, %GameFilter*%). Возвращаем массив
 * аргументов argv — его можно и напрямую передать winws.exe, и собрать в строку
 * для sc create.
 */
function gameFilterValues() {
  const flag = path.join(P.utils(), 'game_filter.enabled');
  let mode = '';
  try { mode = fs.readFileSync(flag, 'utf8').trim().toLowerCase(); } catch { mode = ''; }
  if (!fs.existsSync(flag)) return { GameFilter: '12', GameFilterTCP: '12', GameFilterUDP: '12' };
  if (mode === 'all') return { GameFilter: '1024-65535', GameFilterTCP: '1024-65535', GameFilterUDP: '1024-65535' };
  if (mode === 'tcp') return { GameFilter: '1024-65535', GameFilterTCP: '1024-65535', GameFilterUDP: '12' };
  return { GameFilter: '1024-65535', GameFilterTCP: '12', GameFilterUDP: '1024-65535' }; // udp / прочее
}

function tokenize(str) {
  // Разбить строку на токены с учётом кавычек. Кавычки сохраняем внутри токена,
  // затем убираем при подстановке путей.
  const tokens = [];
  let cur = '', inQuote = false;
  for (const ch of str) {
    if (ch === '"') { inQuote = !inQuote; cur += ch; }
    else if (/\s/.test(ch) && !inQuote) { if (cur) { tokens.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseStrategy(batName) {
  const batPath = path.join(activePath(), batName);
  const raw = fs.readFileSync(batPath, 'utf8');
  // Склеиваем строки с продолжением ^ в конце.
  const lines = raw.split(/\r?\n/);
  let joined = '', cont = false;
  for (let ln of lines) {
    let t = ln.replace(/\r$/, '');
    const isCont = /\^\s*$/.test(t);
    t = t.replace(/\^\s*$/, '');
    if (cont) joined += ' ' + t.trim();
    else if (/winws\.exe/i.test(t)) joined = t;
    if (/winws\.exe/i.test(t) || cont) cont = isCont;
  }
  if (!joined) throw new Error('Не найден вызов winws.exe в ' + batName);

  // Оставляем всё после winws.exe"
  const m = joined.match(/winws\.exe"?\s*(.*)$/i);
  const argsStr = m ? m[1] : '';
  const g = gameFilterValues();
  const binPath = P.bin() + path.sep;
  const listsPath = P.lists() + path.sep;

  const subst = (tok) => {
    let t = tok;
    t = t.replace(/%BIN%/gi, binPath).replace(/%LISTS%/gi, listsPath);
    t = t.replace(/%GameFilterTCP%/gi, g.GameFilterTCP)
         .replace(/%GameFilterUDP%/gi, g.GameFilterUDP)
         .replace(/%GameFilter%/gi, g.GameFilter);
    // Убираем окружающие кавычки, но оставляем значение как единый токен.
    if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
    // Кавычки вида --opt="path"
    t = t.replace(/="([^"]*)"/g, '=$1');
    return t;
  };

  const argv = tokenize(argsStr).map(subst).filter(x => x && x !== '^');
  return argv;
}

// ------------------------------------------------------ запуск / остановка ----
let winwsChild = null;

async function stopEverything() {
  log('Останавливаю winws и службу zapret…');
  await run('taskkill /IM winws.exe /F >nul 2>&1');
  await run('net stop zapret >nul 2>&1');
  await run('sc delete zapret >nul 2>&1');
  await run('net stop WinDivert >nul 2>&1');
  await run('sc delete WinDivert >nul 2>&1');
  await run('net stop WinDivert14 >nul 2>&1');
  await run('sc delete WinDivert14 >nul 2>&1');
  winwsChild = null;
}

async function startProcess(batName) {
  await stopEverything();
  const argv = parseStrategy(batName);
  const winws = path.join(P.bin(), 'winws.exe');
  log('Запуск winws.exe как процесс, стратегия: ' + batName);
  winwsChild = spawn(winws, argv, { cwd: P.bin(), detached: true, windowsHide: true, stdio: 'ignore' });
  winwsChild.unref();
  return { ok: true, mode: 'process' };
}

async function installService(batName) {
  await stopEverything();
  const argv = parseStrategy(batName);
  const winws = path.join(P.bin(), 'winws.exe');
  // Собираем строку binPath для sc create, экранируя токены с пробелами.
  const argStr = argv.map(a => (/\s/.test(a) ? `\\"${a}\\"` : a)).join(' ');
  await run('netsh interface tcp set global timestamps=enabled >nul 2>&1');
  const bin = `"\\"${winws}\\" ${argStr}"`;
  log('Создаю службу zapret из стратегии: ' + batName);
  let r = await run(`sc create zapret binPath= ${bin} DisplayName= "zapret" start= auto`);
  log(r.stdout + r.stderr);
  await run('sc description zapret "Zapret DPI bypass software"');
  r = await run('sc start zapret');
  log(r.stdout + r.stderr);
  const name = path.basename(batName, '.bat');
  await run(`reg add "HKLM\\System\\CurrentControlSet\\Services\\zapret" /v zapret-discord-youtube /t REG_SZ /d "${name}" /f >nul 2>&1`);
  return { ok: r.code === 0, mode: 'service' };
}

// ------------------------------------------------------------- статус ---------
async function getStatus() {
  const cfg = readConfig();
  if (!cfg.activePath || !fs.existsSync(P.service())) {
    return { ready: false };
  }
  const tl = await run('tasklist /FI "IMAGENAME eq winws.exe"', { quiet: true });
  const winwsRunning = /winws\.exe/i.test(tl.stdout);
  const svc = await run('sc query zapret', { quiet: true });
  const serviceRunning = /RUNNING/i.test(svc.stdout);
  const serviceInstalled = !/1060|does not exist/i.test(svc.stdout) && svc.code === 0;
  const wd = await run('sc query WinDivert', { quiet: true });
  const windivert = /RUNNING/i.test(wd.stdout);
  // текущая стратегия из реестра
  const reg = await run('reg query "HKLM\\System\\CurrentControlSet\\Services\\zapret" /v zapret-discord-youtube', { quiet: true });
  let strategy = null;
  const mm = reg.stdout.match(/zapret-discord-youtube\s+REG_SZ\s+(.+)/i);
  if (mm) strategy = mm[1].trim();
  // версия
  let version = null;
  try {
    const sb = fs.readFileSync(P.service(), 'utf8');
    const vm = sb.match(/LOCAL_VERSION=([^\r\n"]+)/);
    if (vm) version = vm[1].trim();
  } catch {}
  return {
    ready: true, activePath: cfg.activePath, version,
    winwsRunning, serviceRunning, serviceInstalled, windivert, strategy,
    running: winwsRunning || serviceRunning,
  };
}

// ---------------------------------------------------------- переключатели -----
function gameFilterGet() {
  const flag = path.join(P.utils(), 'game_filter.enabled');
  if (!fs.existsSync(flag)) return 'off';
  const m = (fs.readFileSync(flag, 'utf8').trim().toLowerCase()) || 'off';
  return ['all', 'tcp', 'udp'].includes(m) ? m : 'off';
}
function gameFilterSet(mode) {
  const flag = path.join(P.utils(), 'game_filter.enabled');
  fs.mkdirSync(P.utils(), { recursive: true });
  if (mode === 'off') { if (fs.existsSync(flag)) fs.unlinkSync(flag); }
  else fs.writeFileSync(flag, mode, 'utf8');
  return gameFilterGet();
}
function autoUpdateGet() {
  return fs.existsSync(path.join(P.utils(), 'check_updates.enabled'));
}
function autoUpdateSet(on) {
  const flag = path.join(P.utils(), 'check_updates.enabled');
  fs.mkdirSync(P.utils(), { recursive: true });
  if (on) fs.writeFileSync(flag, 'ENABLED', 'utf8');
  else if (fs.existsSync(flag)) fs.unlinkSync(flag);
  return autoUpdateGet();
}
// IPSet: loaded / none / any
function ipsetGet() {
  const f = path.join(P.lists(), 'ipset-all.txt');
  let content = '';
  try { content = fs.readFileSync(f, 'utf8'); } catch { return 'any'; }
  const lines = content.split(/\r?\n/).filter(x => x.trim());
  if (lines.length === 0) return 'any';
  if (content.includes('203.0.113.113/32') && lines.length <= 1) return 'none';
  return 'loaded';
}
function ipsetSet(target) {
  const f = path.join(P.lists(), 'ipset-all.txt');
  const backup = f + '.backup';
  const cur = ipsetGet();
  if (target === 'none' && cur === 'loaded') {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
    if (fs.existsSync(f)) fs.renameSync(f, backup);
    fs.writeFileSync(f, '203.0.113.113/32\n', 'utf8');
  } else if (target === 'any') {
    fs.writeFileSync(f, '', 'utf8');
  } else if (target === 'loaded') {
    if (fs.existsSync(backup)) { if (fs.existsSync(f)) fs.unlinkSync(f); fs.renameSync(backup, f); }
    else throw new Error('Нет резервной копии списка. Сначала обновите IPSet-список.');
  }
  return ipsetGet();
}

// --------------------------------------------------------------- списки -------
const LIST_FILES = {
  bypass: 'list-general-user.txt',   // домены В ОБХОД (проксировать через zapret)
  exclude: 'list-exclude-user.txt',  // домены В ИСКЛЮЧЕНИЯ (не трогать)
  ipexclude: 'ipset-exclude-user.txt', // IP/подсети в исключения
};

/*
 * Домены — недоверенные данные (импорт, чужой файл, ручной ввод). Каждую строку
 * чистим и проверяем регуляркой, прежде чем писать в файл, который потом уходит
 * в winws как --hostlist. Никаких shell-метасимволов, пробелов, управляющих
 * символов: домены/подсети из букв, цифр, дефисов, точек и (для IP) слэша.
 */
const RE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const RE_IPNET  = /^(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?$/;

function cleanEntry(raw, which) {
  let s = String(raw).trim().toLowerCase();
  if (!s || s.startsWith('#')) return null;
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''); // url -> host
  if (which === 'ipexclude') return RE_IPNET.test(s) ? s : null;
  return RE_DOMAIN.test(s) ? s : null;
}

function listPathOf(which) { return path.join(P.lists(), LIST_FILES[which]); }

// Возвращает ВСЕ валидные строки файла. Тяжёлый вызов — не гонять его в интерфейс,
// использовать только внутри main для операций записи/подсчёта.
function listReadAll(which) {
  try {
    return fs.readFileSync(listPathOf(which), 'utf8').split(/\r?\n/)
      .map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  } catch { return []; }
}

function listWriteAll(which, items) {
  fs.mkdirSync(P.lists(), { recursive: true });
  const uniq = [...new Set(items.map(x => x.trim()).filter(Boolean))];
  fs.writeFileSync(listPathOf(which), uniq.join('\r\n') + '\r\n', 'utf8');
  return uniq.length;
}

/*
 * Страница для интерфейса: сортировка и фильтр по подстроке считаются здесь, в
 * интерфейс уходит только текущий срез (по умолчанию 50 строк) плюс общее число.
 * Так хоть 430 000 доменов — окно получает максимум 50 и не захлёбывается на IPC.
 */
function listPage(which, { page = 0, pageSize = 50, query = '' } = {}) {
  let items = listReadAll(which);
  const q = String(query).trim().toLowerCase();
  if (q) items = items.filter(x => x.toLowerCase().includes(q));
  items.sort((a, b) => a.localeCompare(b));           // алфавит, файл на диске не трогаем
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(p * pageSize, p * pageSize + pageSize), total, page: p, pages, pageSize };
}

// Добавление с валидацией. Возвращает, сколько добавили, сколько дублей, что отбраковали.
function listAdd(which, value) {
  const existing = new Set(listReadAll(which));
  const parts = String(value).split(/[\s,;]+/);
  let added = 0, dup = 0; const bad = [];
  for (const raw of parts) {
    if (!raw.trim()) continue;
    const clean = cleanEntry(raw, which);
    if (!clean) { bad.push(raw.trim()); continue; }
    if (existing.has(clean)) { dup++; continue; }
    existing.add(clean); added++;
  }
  const total = listWriteAll(which, [...existing]);
  return { added, dup, bad, total };
}

// Пакетное добавление пресета: та же валидация, отдельный ответ для окна выбора.
function listAddPreset(which, arr) {
  const existing = new Set(listReadAll(which));
  let added = 0, dup = 0;
  for (const raw of arr) {
    const clean = cleanEntry(raw, which);
    if (!clean) continue;
    if (existing.has(clean)) { dup++; continue; }
    existing.add(clean); added++;
  }
  const total = listWriteAll(which, [...existing]);
  return { added, dup, total };
}

function listRemove(which, value) {
  const items = listReadAll(which).filter(x => x !== value);
  return { total: listWriteAll(which, items) };
}

function listClear(which) { return { total: listWriteAll(which, []) }; }

// ----------------------------------------------------------- диагностика ------
async function diagnostics() {
  const res = [];
  const add = (name, status, message, fix = null) => res.push({ name, status, message, fix });

  // Base Filtering Engine
  let r = await run('sc query BFE');
  add('Base Filtering Engine', /RUNNING/i.test(r.stdout) ? 'ok' : 'error',
    /RUNNING/i.test(r.stdout) ? 'Служба BFE работает.' : 'Служба BFE не запущена — она обязательна для работы Zapret.');

  // Прокси
  r = await run('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable');
  const proxyOn = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(r.stdout);
  add('Системный прокси', proxyOn ? 'warn' : 'ok',
    proxyOn ? 'Включён системный прокси — убедитесь, что он рабочий, иначе отключите.' : 'Прокси выключен.');

  // TCP timestamps
  r = await run('netsh interface tcp show global');
  const tsOn = /timestamps[^\r\n]*enabled/i.test(r.stdout);
  add('TCP timestamps', tsOn ? 'ok' : 'warn',
    tsOn ? 'TCP timestamps включены.' : 'TCP timestamps выключены — рекомендуется включить.',
    tsOn ? null : 'tcp_timestamps');

  // Конфликтующие процессы/службы
  const conflicts = [
    ['AdguardSvc.exe', 'process', 'Adguard', 'Adguard может мешать Discord.'],
    ['Killer', 'service', 'Killer', 'Службы Killer конфликтуют с Zapret.'],
    ['SmartByte', 'service', 'SmartByte', 'SmartByte конфликтует с Zapret.'],
  ];
  for (const [needle, kind, label, msg] of conflicts) {
    let found;
    if (kind === 'process') { const t = await run(`tasklist /FI "IMAGENAME eq ${needle}"`); found = new RegExp(needle, 'i').test(t.stdout); }
    else { const t = await run('sc query'); found = new RegExp(needle, 'i').test(t.stdout); }
    add(label, found ? 'error' : 'ok', found ? msg : `${label}: конфликтов нет.`);
  }

  // Intel Connectivity Network Service
  r = await run('sc query');
  const intel = /Intel/i.test(r.stdout) && /Connectivity/i.test(r.stdout);
  add('Intel Connectivity', intel ? 'error' : 'ok',
    intel ? 'Найдена Intel Connectivity Network Service — конфликтует с Zapret.' : 'Конфликтов нет.');

  // VPN
  const vpn = /VPN/i.test(r.stdout);
  add('VPN', vpn ? 'warn' : 'ok',
    vpn ? 'Обнаружены VPN-службы — некоторые VPN конфликтуют с Zapret, отключите их.' : 'Активных VPN не найдено.');

  // WinDivert.sys
  const sysOk = fs.existsSync(P.bin()) && fs.readdirSync(P.bin()).some(f => f.endsWith('.sys'));
  add('WinDivert драйвер', sysOk ? 'ok' : 'error',
    sysOk ? 'Файл WinDivert64.sys на месте.' : 'Не найден WinDivert64.sys в папке bin.');

  // Конфликтующие обходы
  const bypassSvcs = ['GoodbyeDPI', 'discordfix_zapret', 'winws1', 'winws2'];
  const foundBypass = [];
  for (const s of bypassSvcs) { const q = await run(`sc query "${s}"`); if (q.code === 0 && !/does not exist/i.test(q.stdout)) foundBypass.push(s); }
  add('Другие обходы DPI', foundBypass.length ? 'error' : 'ok',
    foundBypass.length ? 'Найдены конфликтующие службы: ' + foundBypass.join(', ') : 'Других обходов не найдено.',
    foundBypass.length ? 'remove_bypass:' + foundBypass.join(',') : null);

  // hosts файл
  const hostsFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  try {
    const h = fs.readFileSync(hostsFile, 'utf8');
    const bad = /youtube\.com|youtu\.be/i.test(h);
    add('Файл hosts', bad ? 'warn' : 'ok',
      bad ? 'В hosts есть записи youtube.com/youtu.be — это может мешать доступу к YouTube.' : 'Подозрительных записей нет.');
  } catch { add('Файл hosts', 'ok', 'Файл hosts не читается (это нормально без админ-прав).'); }

  return res;
}

async function applyFix(fix) {
  if (fix === 'tcp_timestamps') {
    const r = await run('netsh interface tcp set global timestamps=enabled');
    log('Включаю TCP timestamps: ' + (r.code === 0 ? 'готово' : 'ошибка'));
    return r.code === 0;
  }
  if (fix.startsWith('remove_bypass:')) {
    const svcs = fix.split(':')[1].split(',');
    for (const s of svcs) { await run(`net stop "${s}" >nul 2>&1`); await run(`sc delete "${s}" >nul 2>&1`); log('Удаляю службу ' + s); }
    await run('net stop WinDivert >nul 2>&1'); await run('sc delete WinDivert >nul 2>&1');
    return true;
  }
  return false;
}

async function clearDiscordCache() {
  await run('taskkill /IM Discord.exe /F >nul 2>&1');
  const base = path.join(process.env.APPDATA || '', 'discord');
  for (const d of ['Cache', 'Code Cache', 'GPUCache']) {
    const p = path.join(base, d);
    try { fs.rmSync(p, { recursive: true, force: true }); log('Очищено: ' + p); } catch {}
  }
  return true;
}

// ------------------------------------------------------------- обновления -----
const REPO_RAW = 'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/main';
const REPO = 'https://github.com/Flowseal/zapret-discord-youtube';

async function checkAppUpdate() {
  const r = await ps(`(Invoke-WebRequest -Uri '${REPO_RAW}/.service/version.txt' -Headers @{'Cache-Control'='no-cache'} -UseBasicParsing -TimeoutSec 8).Content.Trim()`);
  const remote = r.stdout.trim();
  if (!remote) return { ok: false, message: 'Не удалось получить версию с GitHub.' };
  let local = null;
  try { local = (fs.readFileSync(P.service(), 'utf8').match(/LOCAL_VERSION=([^\r\n"]+)/) || [])[1]?.trim(); } catch {}
  const upToDate = local === remote;
  return { ok: true, local, remote, upToDate, releaseUrl: `${REPO}/releases/tag/${remote}`, downloadUrl: `${REPO}/releases/latest` };
}

async function updateIpset() {
  const listFile = path.join(P.lists(), 'ipset-all.txt');
  const url = `${REPO_RAW}/.service/ipset-service.txt`;
  log('Скачиваю IPSet-список…');
  const r = await ps(`Invoke-WebRequest -Uri '${url}' -TimeoutSec 20 -UseBasicParsing -OutFile '${listFile}'`);
  log(r.code === 0 ? 'IPSet обновлён.' : 'Ошибка обновления IPSet.');
  return { ok: r.code === 0 };
}

async function updateHosts() {
  const hostsFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  const url = `${REPO_RAW}/.service/hosts`;
  const tmp = path.join(os.tmpdir(), 'zapret_hosts.txt');
  const r = await ps(`Invoke-WebRequest -Uri '${url}' -TimeoutSec 20 -UseBasicParsing -OutFile '${tmp}'`);
  if (r.code !== 0 || !fs.existsSync(tmp)) return { ok: false, message: 'Не удалось скачать hosts из репозитория.' };
  const remote = fs.readFileSync(tmp, 'utf8').split(/\r?\n/).filter(Boolean);
  const cur = fs.existsSync(hostsFile) ? fs.readFileSync(hostsFile, 'utf8') : '';
  const need = remote.length && (!cur.includes(remote[0]) || !cur.includes(remote[remote.length - 1]));
  if (need) { shell.openPath(tmp); return { ok: true, needsUpdate: true, message: 'Файл hosts нужно обновить вручную — открыт скачанный файл.' }; }
  return { ok: true, needsUpdate: false, message: 'Файл hosts актуален.' };
}

// --------------------------------------------- применение нового zip ----------
/*
 * Пользователь бросает zip новой версии. Мы распаковываем его во временную папку,
 * находим папку с service.bat, переносим её в installs/<имя>, мигрируем пользо-
 * вательские списки и флаги из текущей активной установки и делаем новую активной.
 */
async function applyZip(zipPath) {
  if (!fs.existsSync(zipPath)) throw new Error('Файл не найден: ' + zipPath);
  fs.mkdirSync(INSTALLS_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-'));
  log('Распаковываю ' + path.basename(zipPath) + ' …');
  const r = await ps(`Expand-Archive -Path '${zipPath}' -DestinationPath '${tmp}' -Force`);
  if (r.code !== 0) throw new Error('Не удалось распаковать архив. ' + r.stderr);

  // Ищем папку, содержащую service.bat (или сам корень).
  let srcDir = null;
  const walk = (dir, depth = 0) => {
    if (srcDir || depth > 3) return;
    if (fs.existsSync(path.join(dir, 'service.bat'))) { srcDir = dir; return; }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(tmp);
  if (!srcDir) throw new Error('В архиве не найден service.bat — это точно Zapret?');

  const versionName = path.basename(srcDir) || ('zapret-' + Date.now());
  const dest = path.join(INSTALLS_DIR, versionName);

  // Пользовательские файлы читаем В ПАМЯТЬ до того, как что-либо удалять:
  // если имя папки в архиве совпадёт с текущей установкой (переустановка той же
  // версии), dest === prev, и rmSync ниже снёс бы списки вместе с папкой.
  //
  // Переносим ВСЁ, что мог настроить пользователь: пользовательские списки,
  // их IP-исключения, режим IPSet и флаги. Списки *-user трогает пользователь
  // напрямую, поэтому они в приоритете.
  const USER_FILES = [
    ['lists', 'list-general-user.txt'],    // домены в обход
    ['lists', 'list-exclude-user.txt'],    // домены в исключения
    ['lists', 'ipset-exclude-user.txt'],   // IP-исключения
    ['lists', 'ipset-all.txt'],            // режим IPSet (loaded/none/any)
    ['lists', 'ipset-all.txt.backup'],     // резервная копия для режима "loaded"
    ['utils', 'game_filter.enabled'],
    ['utils', 'check_updates.enabled'],
  ];
  const prev = activePath();
  const saved = [];
  if (prev && fs.existsSync(prev)) {
    for (const [sub, file] of USER_FILES) {
      const from = path.join(prev, sub, file);
      try { if (fs.existsSync(from)) saved.push([sub, file, fs.readFileSync(from)]); }
      catch (e) { log('Не удалось прочитать ' + file + ': ' + e.message); }
    }
  }

  // Запоминаем, что было включено ДО обновления: активную стратегию (она хранится
  // в реестре, а не в файле, поэтому в USER_FILES её нет) и работал ли обход.
  // После обновления восстановим службу с той же стратегией — иначе пользователь
  // остался бы с выключенным обходом и «слетевшей» стратегией.
  let priorStrategy = null, wasRunning = false;
  try {
    const st = await getStatus();
    wasRunning = st.running;
    priorStrategy = st.strategy || null;
  } catch {}

  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  // Возвращаем сохранённое поверх свежей установки.
  if (saved.length) {
    for (const [sub, file, data] of saved) {
      const to = path.join(dest, sub, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, data);
    }
    log(`Пользовательские списки и настройки перенесены (${saved.length} файлов).`);
  }

  const cfg = readConfig(); cfg.activePath = dest; writeConfig(cfg);
  log('Активная версия: ' + versionName);

  // Восстанавливаем обход на той же стратегии, если он был включён и такая
  // стратегия есть в новой версии.
  if (wasRunning && priorStrategy) {
    const bat = priorStrategy.endsWith('.bat') ? priorStrategy : priorStrategy + '.bat';
    if (fs.existsSync(path.join(dest, bat))) {
      log('Восстанавливаю обход на прежней стратегии: ' + priorStrategy);
      try { await installService(bat); }
      catch (e) { log('Не удалось восстановить службу: ' + e.message); }
    } else {
      log('Прежняя стратегия «' + priorStrategy + '» отсутствует в новой версии — включите обход заново.');
    }
  }

  return { ok: true, version: versionName, path: dest, restored: wasRunning && !!priorStrategy };
}

// ============================================================ тесты ===========
/*
 * Оба режима перебирают конфиги — разница в глубине проверки:
 *   • Стандартный — базовый набор целей (YouTube + Discord), быстро.
 *   • DPI Check   — полный набор: плюс Cloudflare, Twitch, соцсети и прочее,
 *                   что обычно режет DPI. Дольше, зато видно всю картину.
 *
 * Перед началом обход принудительно выключается, иначе первый конфиг тестировался
 * бы поверх уже работающей службы и результат был бы грязным. После теста прежнее
 * состояние восстанавливается: человек не должен уйти с тестового winws вместо
 * своей службы и обнаружить пропажу обхода после перезагрузки.
 */
const https = require('https');

const TARGETS = [
  // --- базовый набор (участвует в обоих режимах) ---
  { host: 'www.youtube.com', group: 'YouTube', tier: 'basic',
    desc: 'Главная страница YouTube. Если не открывается — блокируется сам сайт, а не видео.' },
  { host: 'redirector.googlevideo.com', group: 'YouTube', tier: 'basic',
    desc: 'Раздаёт адреса видеосерверов. Когда страница грузится, а видео вечно буферизует — виноват обычно он.' },
  { host: 'i.ytimg.com', group: 'YouTube', tier: 'basic',
    desc: 'Превью роликов. Не работает — YouTube выглядит как страница без картинок.' },
  { host: 'discord.com', group: 'Discord', tier: 'basic',
    desc: 'Основной сайт и вход в аккаунт Discord.' },
  { host: 'gateway.discord.gg', group: 'Discord', tier: 'basic',
    desc: 'Постоянное соединение с Discord. Без него клиент висит на «Подключение…» и чат не приходит.' },
  { host: 'cdn.discordapp.com', group: 'Discord', tier: 'basic',
    desc: 'Файлы, аватарки и вложения Discord. Не грузится — сообщения есть, а картинок нет.' },

  // --- расширенный набор (только DPI Check) ---
  { host: 'media.discordapp.net', group: 'Discord', tier: 'full',
    desc: 'Картинки и превью в чатах Discord, отдельный от CDN адрес.' },
  { host: 'www.cloudflare.com', group: 'Cloudflare', tier: 'full',
    desc: 'Cloudflare обслуживает огромную часть интернета. Его блокировка ломает тысячи сайтов разом.' },
  { host: 'cdnjs.cloudflare.com', group: 'Cloudflare', tier: 'full',
    desc: 'Библиотеки скриптов с Cloudflare. Не работает — многие сайты открываются «сломанными».' },
  { host: 'speed.cloudflare.com', group: 'Cloudflare', tier: 'full',
    desc: 'Проверка скорости Cloudflare. Хороший индикатор того, как DPI обходится с TLS.' },
  { host: 'www.twitch.tv', group: 'Twitch', tier: 'full',
    desc: 'Twitch — стриминговый сервис, часто попадает под те же фильтры, что и YouTube.' },
  { host: 'static-cdn.jtvnw.net', group: 'Twitch', tier: 'full',
    desc: 'Раздача превью и видеопотоков Twitch.' },
  { host: 'x.com', group: 'Соцсети', tier: 'full',
    desc: 'X (бывший Twitter).' },
  { host: 'www.instagram.com', group: 'Соцсети', tier: 'full',
    desc: 'Instagram.' },
  { host: 'steamcommunity.com', group: 'Игры', tier: 'full',
    desc: 'Сообщество Steam: профили, обсуждения, торговая площадка.' },
  { host: 'open.spotify.com', group: 'Музыка', tier: 'full',
    desc: 'Spotify. Полезен как проверка обычного TLS-трафика, не связанного с видео.' },
];

const targetsFor = (mode) => TARGETS.filter(t => mode === 'dpi' || t.tier === 'basic');

// ------------------------------------------------- монитор индикаторов --------
/*
 * Три лампочки на стенде следят за главными сервисами. Проверка отдельная от
 * вкладки «Тесты»: лёгкий TLS-хендшейк к одному хосту на сервис, раз в 12 секунд.
 * Логика трёхцветная:
 *   • сначала контрольный хост (заведомо доступный) — если и он не отвечает,
 *     проблема в сети вообще, лампы серые «нет сети», а не красные;
 *   • дальше целевые хосты: прошёл хендшейк — зелёный, оборвался — красный.
 * Опрос редкий и с дебаунсом, чтобы лампы не мигали.
 */
const tls = require('tls');
const MONITORS = [
  { key: 'discord',    label: 'Discord',    host: 'gateway.discord.gg' },
  { key: 'youtube',    label: 'YouTube',    host: 'www.youtube.com' },
  { key: 'cloudflare', label: 'Cloudflare', host: 'www.cloudflare.com' },
];
// Контроль сети: несколько крупных хостов, которые почти никогда не блокируют.
// Сеть считается живой, если ответил ХОТЬ ОДИН — один ненадёжный хост (как
// msftconnecttest, который на 443 отвечает через раз) больше не гасит все лампы.
const NET_CHECK_HOSTS = ['dns.google', 'one.one.one.one', 'yandex.ru'];
let monitorTimer = null;

function tlsProbe(host, timeout = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = tls.connect({ host, servername: host, port: 443, timeout }, () => {
      sock.end(); resolve({ ok: true, ms: Date.now() - t0 });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ ok: false }); });
    sock.on('error', () => resolve({ ok: false }));
  });
}

async function hasNetwork() {
  const results = await Promise.all(NET_CHECK_HOSTS.map(h => tlsProbe(h, 4000)));
  return results.some(r => r.ok);
}

async function monitorTick() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (!await hasNetwork()) {
    emit2('monitor', { states: Object.fromEntries(MONITORS.map(m => [m.key, { state: 'nonet' }])) });
    return;
  }
  const states = {};
  for (const m of MONITORS) {
    const r = await tlsProbe(m.host);
    states[m.key] = { state: r.ok ? 'ok' : 'blocked', ms: r.ms };
  }
  emit2('monitor', { states });
}

function startMonitor() {
  if (monitorTimer) return;
  monitorTick();
  monitorTimer = setInterval(monitorTick, 12000);
}
function stopMonitor() { clearInterval(monitorTimer); monitorTimer = null; }

// отдельный emit, чтобы не завязываться на канал тестов
const emit2 = (type, data) => { if (mainWindow) mainWindow.webContents.send('monitor:event', { type, ...data }); };

/*
 * Сколько ждём после запуска winws, прежде чем проверять. Драйвер WinDivert
 * поднимается не мгновенно, и если начать пробы раньше — стратегия покажет 0 из 6
 * не потому, что плохая, а потому, что перехват ещё не встал. На медленных машинах
 * можно поднять до 4000.
 */
const WINWS_WARMUP = 3000;

let testAbort = false;
let testBusy = false;

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const emit = (type, data) => { if (mainWindow) mainWindow.webContents.send('test:event', { type, ...data }); };

/*
 * Одна проба. Важен не ответ, а сам факт, что TLS-хендшейк прошёл: DPI обычно
 * рвёт соединение (ECONNRESET) или молча топит его в таймауте. Сертификаты не
 * проверяем — нас интересует только проходимость канала.
 */
function probe(host, timeout = 6000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request({
      host, port: 443, path: '/', method: 'HEAD', timeout,
      rejectUnauthorized: false,
      headers: { 'User-Agent': 'Mozilla/5.0', Connection: 'close' },
    }, (res) => {
      res.resume();
      resolve({ ok: true, ms: Date.now() - t0, code: res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - t0, error: e.code || e.message || 'error' }));
    req.end();
  });
}

async function runProbes(label, targets) {
  const results = [];
  for (const t of targets) {
    if (testAbort) break;
    emit('probe', { config: label, host: t.host, group: t.group, state: 'run' });
    const r = await probe(t.host);
    results.push({ host: t.host, group: t.group, ...r });
    emit('probe', { config: label, host: t.host, group: t.group, state: r.ok ? 'ok' : 'fail', ms: r.ms, error: r.error });
  }
  const ok = results.filter(r => r.ok);
  return {
    results,
    okCount: ok.length,
    total: results.length,
    avg: ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0,
    score: results.length ? Math.round(ok.length / results.length * 100) : 0,
  };
}

/* Общий перебор для обоих режимов. */
async function runSweep(mode, batList, withBaseline = true) {
  if (testBusy) return { busy: true };
  testBusy = true; testAbort = false;
  stopMonitor();                       // во время перебора лампы не опрашиваем

  const targets = targetsFor(mode);
  const before = await getStatus();
  const restore = before.serviceInstalled ? before.strategy : null;
  const out = [];

  try {
    const steps = batList.length + (withBaseline ? 1 : 0);
    emit('start', { mode, total: steps, targets });

    // Чистый старт: гасим всё, что уже работает, иначе первый конфиг проверялся
    // бы поверх активной службы.
    log('Тест: выключаю обход для чистой проверки…');
    emit('phase', { text: 'Выключаю обход для чистой проверки…' });
    await stopEverything();
    await delay(900);

    if (withBaseline && !testAbort) {
      emit('config', { bat: '__baseline__', label: 'без обхода', state: 'run', index: 0, total: steps });
      const r = await runProbes('__baseline__', targets);
      out.push({ bat: '__baseline__', label: 'без обхода', baseline: true, ...r });
      emit('config', { bat: '__baseline__', label: 'без обхода', state: 'done', index: 0, total: steps, ...r });
    }

    for (let i = 0; i < batList.length; i++) {
      if (testAbort) break;
      const bat = batList[i];
      const idx = i + (withBaseline ? 1 : 0);
      emit('config', { bat, label: bat, state: 'run', index: idx, total: steps });
      await startProcess(bat);
      await delay(WINWS_WARMUP);       // даём WinDivert подняться и перехватить трафик
      const r = await runProbes(bat, targets);
      out.push({ bat, label: bat, ...r });
      emit('config', { bat, label: bat, state: 'done', index: idx, total: steps, ...r });
    }
  } finally {
    emit('phase', { text: 'Возвращаю прежние настройки…' });
    await stopEverything();
    if (restore) {
      log('Восстанавливаю прежнюю службу: ' + restore);
      await installService(restore.endsWith('.bat') ? restore : restore + '.bat');
    }
    testBusy = false;
    startMonitor();                    // возвращаем опрос ламп
  }

  const real = out.filter(r => !r.baseline);
  const best = real.slice().sort((a, b) => b.okCount - a.okCount || a.avg - b.avg)[0] || null;
  const bestBat = best && best.okCount > 0 ? best.bat : null;

  let file = null;
  if (out.length) file = await saveReport(mode, { results: out, best: bestBat });

  emit('done', { mode, aborted: testAbort, best: bestBat, file });
  return { results: out, best: bestBat, aborted: testAbort, file };
}

// ------------------------------------------------------- отчёт (один файл) ----
/*
 * Все прогоны дописываются в ОДИН файл рядом с папкой core. Если корень
 * недоступен для записи (приложение утащили в Program Files) — уходим в userData,
 * чтобы тест не падал из-за невозможности сохранить отчёт.
 */
function testResultsFile() {
  const near = path.join(__dirname, '..', 'Test results.txt');
  try {
    fs.appendFileSync(near, '');
    return near;
  } catch {
    return path.join(app.getPath('userData'), 'Test results.txt');
  }
}

function stampHuman(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function saveReport(mode, { results, best }) {
  const file = testResultsFile();
  const st = await getStatus().catch(() => ({}));
  const L = [];

  L.push('');
  L.push('='.repeat(70));
  L.push(`  ТЕСТ ${stampHuman(new Date())}   —   ${mode === 'dpi' ? 'DPI Check (полная проверка)' : 'Стандартный тест'}`);
  L.push(`  Версия Zapret: ${st.version || '—'}`);
  L.push('='.repeat(70));
  L.push('');

  const sorted = results.slice().sort((a, b) => {
    if (a.baseline) return 1;              // база сравнения — в самый низ
    if (b.baseline) return -1;
    return b.okCount - a.okCount || a.avg - b.avg;
  });

  L.push(`  ${'Стратегия'.padEnd(34)} ${'Пробы'.padEnd(8)} ${'Задержка'.padEnd(10)} Оценка`);
  L.push('  ' + '-'.repeat(66));
  for (const r of sorted) {
    const name = (r.baseline ? '— без обхода —' : r.bat.replace(/\.bat$/i, '')).slice(0, 33);
    const mark = (!r.baseline && r.bat === best) ? '   <-- ЛУЧШАЯ' : '';
    L.push(`  ${name.padEnd(34)} ${`${r.okCount}/${r.total}`.padEnd(8)} ${(r.avg ? r.avg + ' мс' : '—').padEnd(10)} ${r.score}%${mark}`);
  }
  L.push('');
  L.push(best
    ? `  РЕКОМЕНДУЕТСЯ: ${best.replace(/\.bat$/i, '')}`
    : '  Рабочих стратегий не найдено. Загляните во вкладку «Диагностика».');
  L.push('');
  L.push('  Подробности по каждой стратегии:');
  for (const r of sorted) {
    L.push('');
    L.push(`  ${r.baseline ? '— без обхода —' : r.bat.replace(/\.bat$/i, '')}  (${r.okCount}/${r.total}, ${r.score}%)`);
    for (const pr of r.results) {
      const mark = pr.ok ? '[ OK ]' : '[FAIL]';
      const tail = pr.ok ? `${pr.ms} мс` : (pr.error || 'нет связи');
      L.push(`    ${mark} ${pr.host.padEnd(32)} ${tail}`);
    }
  }
  L.push('');

  const head = fs.existsSync(file) && fs.statSync(file).size > 0
    ? ''
    : '\uFEFF ZAPRET CONTROL — журнал тестов\r\n Каждый новый тест дописывается снизу.\r\n';

  // CRLF и BOM: иначе «Блокнот» слепит всё в одну строку и покажет кракозябры.
  fs.appendFileSync(file, head + L.join('\r\n') + '\r\n', 'utf8');
  log('Отчёт дописан в: ' + file);
  emit('saved', { file });
  return file;
}

// ======================================================== автозагрузка ========
/*
 * Автозапуск делаем через Планировщик задач, а НЕ через ключ реестра Run.
 * Причина: приложению нужны права администратора (оно ставит службу). Запись в
 * Run стартует процесс без прав, тот дёргает autoElevate() — и пользователь при
 * каждом входе в Windows ловит окно UAC. Задача с RunLevel=HighestAvailable
 * поднимается сразу с правами и молча.
 *
 * Флаг --hidden говорит окну не показываться: приложение садится в трей.
 */
const TASK_NAME = 'Zapret Control Autostart';

// В dev это electron.exe + путь к папке core; в упакованном виде — сам exe.
// hidden=true → окно не показывается (трей); false → открывается обычным окном.
function autostartCmd(hidden) {
  const exe = process.execPath;
  const packaged = app.isPackaged;
  const flag = hidden ? ' --hidden' : '';
  return {
    exe,
    args: packaged ? flag.trim() : `"${app.getAppPath()}"${flag}`,
    dir: packaged ? path.dirname(exe) : app.getAppPath(),
  };
}

async function autostartGet() {
  const r = await run(`schtasks /query /tn "${TASK_NAME}" /xml`);
  const enabled = r.code === 0 && !/ERROR|не найден|cannot find/i.test(r.stdout + r.stderr);
  // Режим определяем по наличию --hidden в аргументах задачи.
  const hidden = enabled ? /--hidden/.test(r.stdout) : true;
  return { enabled, hidden };
}

async function autostartSet(on, hidden = true) {
  if (!on) {
    await run(`schtasks /delete /tn "${TASK_NAME}" /f`);
    log('Автозагрузка отключена.');
    return autostartGet();
  }

  const { exe, args, dir } = autostartCmd(hidden);
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME || os.userInfo().username}`;

  // Через XML, а не через /tr: только так можно задать рабочую папку и уровень
  // прав, а кавычки внутри /tr на путях с пробелами разбираются криво.
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Автозапуск Zapret Control в трее при входе в Windows</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(exe)}</Command>
      <Arguments>${esc(args)}</Arguments>
      <WorkingDirectory>${esc(dir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

  // Планировщик требует UTF-16 LE с BOM — иначе ругается на кодировку.
  const tmp = path.join(app.getPath('temp'), 'zapret-control-task.xml');
  fs.writeFileSync(tmp, '\uFEFF' + xml, 'utf16le');

  const r = await run(`schtasks /create /tn "${TASK_NAME}" /xml "${tmp}" /f`);
  fs.rmSync(tmp, { force: true });

  if (r.code !== 0) {
    log('Не удалось создать задачу автозагрузки: ' + (r.stdout + r.stderr).trim());
    throw new Error('Не удалось создать задачу. Нужны права администратора.');
  }
  log('Автозагрузка включена: приложение будет стартовать в трее.');
  return autostartGet();
}

// ------------------------------------------------------------------ окно ------
let tray = null;
const startHidden = process.argv.includes('--hidden');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160, height: 780, minWidth: 940, minHeight: 640,
    backgroundColor: '#0b0b12', show: false, frame: true, autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // При старте из автозагрузки окно не показываем — приложение сразу в трее.
  mainWindow.once('ready-to-show', () => { if (!startHidden) mainWindow.show(); });

  // Закрытие окна (крестик) сворачивает в трей, а не завершает приложение.
  // Полный выход — только через пункт "Выход" в меню трея.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// Единая точка выхода: помечаем намерение, закрываем окно, чистим трей. Дальше
// отработают before-quit / will-quit, которые дожмут процесс, если он застрянет.
function quitApp() {
  app.isQuitting = true;
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {}
  tray = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  app.quit();
}

function createTray() {  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('Zapret Control');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Zapret Control', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Выход', click: () => quitApp() },
  ]));
  tray.on('click', () => showMainWindow());
}

// ------------------------------------------------------------- IPC-мост -------
function reg() {
  const H = ipcMain.handle.bind(ipcMain);
  H('app:isAdmin', () => isAdmin());
  H('app:relaunchAdmin', async () => {
    const exe = process.execPath;
    // Убираем пометку --elevation-tried, иначе новый процесс решит, что попытка
    // уже была, и не покажет запрос UAC.
    const args = process.argv.slice(1).filter(a => a !== '--elevation-tried');
    const argList = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
    const r = await ps(`Start-Process -FilePath '${exe}'${argList ? ` -ArgumentList ${argList}` : ''} -Verb RunAs`);
    if (r.code === 0) { app.isQuitting = true; app.quit(); }
    return { ok: r.code === 0 };
  });
  H('config:get', () => readConfig());
  H('config:setPref', (_e, key, value) => {
    // Разрешаем менять только UI-предпочтения, не трогая служебные поля конфига.
    const allowed = ['mode', 'theme'];
    if (!allowed.includes(key)) return readConfig();
    const cfg = readConfig(); cfg[key] = value; writeConfig(cfg);
    return cfg;
  });
  H('config:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Выберите папку Zapret' });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    if (!fs.existsSync(path.join(dir, 'service.bat'))) throw new Error('В папке нет service.bat.');
    const cfg = readConfig(); cfg.activePath = dir; writeConfig(cfg);
    return cfg;
  });
  H('config:pickZip', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'ZIP', extensions: ['zip'] }], title: 'Выберите zip новой версии Zapret' });
    if (r.canceled || !r.filePaths[0]) return null;
    return applyZip(r.filePaths[0]);
  });
  H('zip:apply', (_e, p) => applyZip(p));

  H('status:get', () => getStatus());
  H('strategies:list', () => {
    const p = activePath();
    if (!p) return [];
    return fs.readdirSync(p).filter(f => /\.bat$/i.test(f) && !/^service/i.test(f))
      .sort((a, b) => a.replace(/\d+/g, m => m.padStart(8, '0')).localeCompare(b.replace(/\d+/g, m => m.padStart(8, '0'))));
  });
  H('control:start', (_e, bat) => startProcess(bat));
  H('control:installService', (_e, bat) => installService(bat));
  H('control:stop', () => stopEverything().then(() => ({ ok: true })));

  H('game:get', () => gameFilterGet());
  H('game:set', (_e, m) => gameFilterSet(m));
  H('ipset:get', () => ipsetGet());
  H('ipset:set', (_e, t) => ipsetSet(t));
  H('autoupdate:get', () => autoUpdateGet());
  H('autoupdate:set', (_e, on) => autoUpdateSet(on));

  H('list:page', (_e, w, opts) => listPage(w, opts));
  H('list:add', (_e, w, v) => listAdd(w, v));
  H('list:addPreset', (_e, w, arr) => listAddPreset(w, arr));
  H('list:remove', (_e, w, v) => listRemove(w, v));
  H('list:clear', (_e, w) => listClear(w));
  H('list:presets', () => PRESETS);

  H('diag:run', () => diagnostics());
  H('diag:fix', (_e, fix) => applyFix(fix));
  H('diag:clearDiscord', () => clearDiscordCache());

  H('update:checkApp', () => checkAppUpdate());
  H('update:ipset', () => updateIpset());
  H('update:hosts', () => updateHosts());
  H('monitor:info', () => MONITORS.map(m => ({ key: m.key, label: m.label, host: m.host })));

  H('log:save', async () => {
    const st = await getStatus().catch(() => ({}));
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const stamp = `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    const L = [];
    L.push('ZAPRET CONTROL — журнал');
    L.push('Сохранён: ' + d.toLocaleString());
    L.push('Версия Zapret: ' + (st.version || '—') + ' | Стратегия: ' + (st.strategy || '—'));
    L.push('');
    L.push('========== ПРОСТОЙ ЖУРНАЛ ==========');
    L.push(...(LOG_BUF.simple.length ? LOG_BUF.simple : ['(пусто)']));
    L.push('');
    L.push('========== РАСШИРЕННЫЙ ЖУРНАЛ ==========');
    L.push(...(LOG_BUF.tech.length ? LOG_BUF.tech : ['(пусто)']));
    L.push('');
    // Рядом с core, как и отчёты тестов; при недоступности — в userData.
    let dir = path.join(__dirname, '..');
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { dir = app.getPath('userData'); }
    const file = path.join(dir, `zapret-log_${stamp}.txt`);
    fs.writeFileSync(file, '\uFEFF' + L.join('\r\n') + '\r\n', 'utf8');
    shell.showItemInFolder(file);
    return { ok: true, file };
  });

  H('autostart:get', () => autostartGet());
  H('autostart:set', (_e, on, hidden) => autostartSet(on, hidden));

  H('test:run', (_e, mode, list, baseline) => runSweep(mode, list, baseline));
  H('test:abort', () => { testAbort = true; return { ok: true }; });
  H('test:resultsFile', () => testResultsFile());
  H('test:openResults', () => shell.openPath(testResultsFile()));

  H('open:external', (_e, url) => shell.openExternal(url));
  H('open:folder', async () => {
    const p = activePath();
    // При первой установке папка ещё не выбрана — раньше кнопка молча не работала.
    if (!p) return { ok: false, reason: 'no-path' };
    if (!fs.existsSync(p)) return { ok: false, reason: 'missing' };
    const err = await shell.openPath(p);       // возвращает '' при успехе, текст ошибки иначе
    return { ok: !err, reason: err || null };
  });
}

// Второй запуск (с ярлыка, из трея, откуда угодно) не должен плодить окна и
// иконки в трее — он просто будит уже работающий экземпляр.
app.on('second-instance', () => showMainWindow());

app.whenReady().then(async () => {
  reg();

  // Порядок важен. Сначала повышение прав: при перезапуске через UAC этот
  // процесс завершится, а окно откроет привилегированная копия. Если бы замок
  // бралcя раньше, дочерний процесс не смог бы его получить и молча закрылся.
  const elevated = await autoElevate();
  if (app.isQuitting) return;

  // Теперь можно занимать замок. Не получилось — значит копия уже запущена:
  // она поймает 'second-instance' и покажет своё окно, а мы тихо выходим.
  if (!app.requestSingleInstanceLock()) {
    app.isQuitting = true;
    app.quit();
    return;
  }

  createWindow();
  createTray();
  startMonitor();
  if (!elevated) log('Приложение работает без прав администратора. Часть функций недоступна.');
});
// window-all-closed НЕ должен завершать процесс сам по себе (уходим в трей).
// Но если запущен штатный выход (app.isQuitting) — не мешаем ему.
app.on('window-all-closed', () => {
  if (app.isQuitting) app.quit();
});

// Полный выход: гарантированно убираем иконку трея (иначе она держит процесс
// живым, и electron.exe висит в диспетчере даже после «Выхода»).
app.on('before-quit', () => {
  app.isQuitting = true;
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {}
  tray = null;
});

// Страховка: если через полсекунды после запроса выхода процесс всё ещё жив
// (застрял на висящей иконке или таймере) — принудительно завершаем.
app.on('will-quit', () => {
  setTimeout(() => { try { app.exit(0); } catch {} }, 500).unref?.();
});

app.on('activate', () => { showMainWindow(); });
