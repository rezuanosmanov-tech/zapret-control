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
  return new Promise((resolve) => {
    exec(wrapped, { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 * 16, ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' }));
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
function log(line) { if (mainWindow) mainWindow.webContents.send('log', line); }

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
  const tl = await run('tasklist /FI "IMAGENAME eq winws.exe"');
  const winwsRunning = /winws\.exe/i.test(tl.stdout);
  const svc = await run('sc query zapret');
  const serviceRunning = /RUNNING/i.test(svc.stdout);
  const serviceInstalled = !/1060|does not exist/i.test(svc.stdout) && svc.code === 0;
  const wd = await run('sc query WinDivert');
  const windivert = /RUNNING/i.test(wd.stdout);
  // текущая стратегия из реестра
  const reg = await run('reg query "HKLM\\System\\CurrentControlSet\\Services\\zapret" /v zapret-discord-youtube');
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
function listRead(which) {
  const f = path.join(P.lists(), LIST_FILES[which]);
  try {
    return fs.readFileSync(f, 'utf8').split(/\r?\n/)
      .map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  } catch { return []; }
}
function listWrite(which, items) {
  const f = path.join(P.lists(), LIST_FILES[which]);
  fs.mkdirSync(P.lists(), { recursive: true });
  const uniq = [...new Set(items.map(x => x.trim()).filter(Boolean))];
  fs.writeFileSync(f, uniq.join('\r\n') + '\r\n', 'utf8');
  return uniq;
}
function listAdd(which, value) {
  const items = listRead(which);
  for (const v of String(value).split(/[\s,]+/).map(x => x.trim()).filter(Boolean)) {
    if (!items.includes(v)) items.push(v);
  }
  return listWrite(which, items);
}
function listRemove(which, value) {
  return listWrite(which, listRead(which).filter(x => x !== value));
}

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
  return { ok: true, version: versionName, path: dest };
}

// ------------------------------------------------------------------ окно ------
let tray = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160, height: 780, minWidth: 940, minHeight: 640,
    backgroundColor: '#0b0b12', show: false, frame: true, autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

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

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32, height: 32 });
  tray = new Tray(icon);
  tray.setToolTip('Zapret Control');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Zapret Control', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Выход', click: () => { app.isQuitting = true; app.quit(); } },
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

  H('list:read', (_e, w) => listRead(w));
  H('list:add', (_e, w, v) => listAdd(w, v));
  H('list:remove', (_e, w, v) => listRemove(w, v));
  H('list:write', (_e, w, items) => listWrite(w, items));

  H('diag:run', () => diagnostics());
  H('diag:fix', (_e, fix) => applyFix(fix));
  H('diag:clearDiscord', () => clearDiscordCache());

  H('update:checkApp', () => checkAppUpdate());
  H('update:ipset', () => updateIpset());
  H('update:hosts', () => updateHosts());
  H('open:external', (_e, url) => shell.openExternal(url));
  H('open:folder', () => { const p = activePath(); if (p) shell.openPath(p); });
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
  if (!elevated) log('Приложение работает без прав администратора. Часть функций недоступна.');
});
app.on('window-all-closed', () => { /* уходим в трей, не завершаем процесс */ });
app.on('before-quit', () => { app.isQuitting = true; });
app.on('activate', () => { showMainWindow(); });
