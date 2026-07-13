'use strict';
const Z = window.zapret;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------ эффект свечения ------
// Волна свечения при нажатии, в духе Windows 11. Навешена через делегирование
// на document, поэтому работает и для кнопок, добавленных позже (стратегии,
// чипы доменов, кнопки "исправить" в диагностике).
const RIPPLE_SELECTOR = '.primary, .ghost, .mini, .nav-item, .seg-btn, ' +
  '.chip .x, .diag-item .fix, .admin-badge, .strategy-actions button';
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest(RIPPLE_SELECTOR);
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.3;
  const span = document.createElement('span');
  span.className = 'ripple-effect';
  span.style.width = span.style.height = size + 'px';
  span.style.left = (e.clientX - rect.left - size / 2) + 'px';
  span.style.top = (e.clientY - rect.top - size / 2) + 'px';
  el.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
});

let selectedStrategy = null;   // выбранный .bat
let currentList = 'bypass';
let lastStatus = null;

// ---------------------------------------------------------------- утилиты ----
function toast(msg, kind = 'info') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function logLine(s) {
  const el = $('#log'); el.textContent += (el.textContent ? '\n' : '') + s;
  el.scrollTop = el.scrollHeight;
}
Z.onLog((l) => l && logLine(l));

// ------------------------------------------------------------- навигация -----
$$('.nav-item').forEach(btn => btn.addEventListener('click', () => {
  $$('.nav-item').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const v = btn.dataset.view;
  $$('.view').forEach(sec => {
    const show = sec.dataset.view === v;
    sec.classList.toggle('hidden', !show);
    if (show) {
      // перезапускаем анимацию появления: снимаем класс, форсируем reflow, ставим заново
      sec.classList.remove('enter');
      void sec.offsetWidth;
      sec.classList.add('enter');
    }
  });
  if (v === 'strategies') loadStrategies();
  if (v === 'lists') loadList(currentList);
  if (v === 'settings') loadSettings();
  if (v === 'dashboard') refreshStatus();
}));

// -------------------------------------------------------------- права --------
async function checkAdmin() {
  const admin = await Z.isAdmin();
  const b = $('#adminBadge');
  if (admin) { b.className = 'admin-badge ok'; b.textContent = 'Права администратора'; }
  else {
    b.className = 'admin-badge err'; b.textContent = 'Нет прав админа — нажмите';
    b.onclick = () => Z.relaunchAdmin();
  }
}

// ------------------------------------------------------------- config --------
async function ensureConfig() {
  const cfg = await Z.getConfig();
  if (!cfg.activePath) {
    toast('Укажите папку Zapret или перетащите zip новой версии', 'info');
    // подскажем на вкладке настроек
  }
  return cfg;
}

// ------------------------------------------------------------- реактор -------
// Состояние ядра переключается ТОЛЬКО классом на .reactor: он меняет --core и
// --energy, а те плавно транзишатся (свойства зарегистрированы через @property).
// Keyframe-анимации сферы при этом никогда не перезапускаются — поэтому нет
// рывков при каждом опросе статуса.
const REACTOR_STATES = ['on', 'off', 'pending', 'idle'];
function setCore(state, text) {
  const r = $('#reactor');
  r.classList.remove(...REACTOR_STATES);
  r.classList.add(state);
  if (text !== undefined) $('#statusText').textContent = text;
}

// --- искры: от ядра к карточкам, будто заряжают их ---
const SVG_NS = 'http://www.w3.org/2000/svg';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function chargeStats() {
  const orb = $('#powerBtn');
  if (reducedMotion || !orb.offsetParent) return;   // вкладка скрыта — не тратим кадры
  $$('#dashGrid .stat').forEach((card, i) => setTimeout(() => sendSpark(orb, card), 150 + 90 * i));
}

function sendSpark(orb, card) {
  const layer = $('#sparkLayer');
  const L = layer.getBoundingClientRect();
  const O = orb.getBoundingClientRect();
  const C = card.getBoundingClientRect();
  if (!L.width || !C.width) return;

  const x0 = O.left + O.width / 2 - L.left;
  const y0 = O.top + O.height / 2 - L.top;
  const toRight = (C.left + C.width / 2) > (O.left + O.width / 2);
  const x1 = (toRight ? C.left : C.right) - L.left;
  const y1 = C.top + C.height / 2 - L.top;
  const dx = x1 - x0;
  const d = `M ${x0} ${y0} C ${x0 + dx * .35} ${y0 - 42}, ${x0 + dx * .72} ${y1 - 30}, ${x1} ${y1}`;

  // светящийся след
  const beam = document.createElementNS(SVG_NS, 'path');
  beam.setAttribute('d', d);
  beam.setAttribute('class', 'beam');
  $('#beamLayer').appendChild(beam);
  const len = beam.getTotalLength();
  beam.style.strokeDasharray = String(len);
  beam.animate([
    { strokeDashoffset: len, opacity: 0 },
    { strokeDashoffset: len * .55, opacity: .95, offset: .35 },
    { strokeDashoffset: 0, opacity: .5, offset: .75 },
    { strokeDashoffset: 0, opacity: 0 },
  ], { duration: 950, easing: 'cubic-bezier(.35,0,.25,1)' }).onfinish = () => beam.remove();

  // сама искра и два хвоста за ней
  for (let i = 0; i < 3; i++) {
    const s = document.createElement('div');
    s.className = 'spark' + (i ? ' trail' : '');
    s.style.offsetPath = `path("${d}")`;
    layer.appendChild(s);
    const a = s.animate([
      { offsetDistance: '0%', opacity: 0 },
      { offsetDistance: '12%', opacity: 1, offset: .14 },
      { offsetDistance: '100%', opacity: 1 },
    ], { duration: 720, delay: i * 70, easing: 'cubic-bezier(.3,0,.25,1)', fill: 'both' });
    a.onfinish = () => { s.remove(); if (i === 0) sparkImpact(layer, x1, y1, card); };
  }
}

function sparkImpact(layer, x, y, card) {
  card.classList.remove('charged');
  void card.offsetWidth;                      // рестарт анимации карточки
  card.classList.add('charged');
  setTimeout(() => card.classList.remove('charged'), 900);

  const ring = document.createElement('div');
  ring.className = 'impact-ring';
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  layer.appendChild(ring);
  ring.animate([
    { transform: 'scale(.2)', opacity: 1 },
    { transform: 'scale(2.6)', opacity: 0 },
  ], { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => ring.remove();
}

// ------------------------------------------------------------- статус --------
let wasRunning = null;   // чтобы искры летели только в момент включения

async function refreshStatus() {
  let st;
  try { st = await Z.status(); } catch { st = { ready: false }; }
  lastStatus = st;
  const title = $('#stateTitle');

  if (!st.ready) {
    title.textContent = 'Zapret не подключён';
    setCore('idle', 'Не настроено');
    $('#coreStrategy').textContent = 'укажите папку в «Настройки»';
    setStat('statWinws', '—', 'neutral'); setStat('statService', '—', 'neutral');
    setStat('statDivert', '—', 'neutral'); setStat('statGame', '—', 'neutral');
    $('#versionLine').textContent = 'версия —';
    wasRunning = null;
    return;
  }

  const running = st.running;
  title.textContent = running ? 'Обход активен' : 'Обход остановлен';
  setCore(running ? 'on' : 'off', running ? 'Запрет включён' : 'Запрет выключен');
  $('#coreStrategy').textContent = st.strategy ? st.strategy : (selectedStrategy || 'стратегия не выбрана');
  $('#versionLine').textContent = 'версия ' + (st.version || '—');

  setStat('statWinws', st.winwsRunning ? 'работает' : 'выкл', st.winwsRunning ? 'on' : 'off');
  setStat('statService', st.serviceRunning ? 'RUNNING' : (st.serviceInstalled ? 'STOPPED' : 'нет'),
    st.serviceRunning ? 'on' : (st.serviceInstalled ? 'neutral' : 'off'));
  setStat('statDivert', st.windivert ? 'загружен' : 'выкл', st.windivert ? 'on' : 'off');

  const g = await Z.gameGet();
  const map = { off: 'выкл', all: 'TCP+UDP', tcp: 'TCP', udp: 'UDP' };
  setStat('statGame', map[g] || g, g === 'off' ? 'off' : 'neutral');

  // ядро зарядило параметры: только при переходе в «включено», не на каждом опросе
  if (running && wasRunning !== true) chargeStats();
  wasRunning = running;
}
function setStat(id, val, cls) {
  const el = $('#' + id);
  const charged = el.classList.contains('charged');
  el.className = 'stat ' + cls + (charged ? ' charged' : '');
  el.querySelector('.stat-val').textContent = val;
}

// сфера = кнопка питания
$('#powerBtn').addEventListener('click', async () => {
  if (!lastStatus || !lastStatus.ready) { toast('Сначала укажите папку Zapret', 'err'); return; }
  if (lastStatus.running) {
    setCore('pending', 'Выключаю…');
    await Z.stop(); toast('Обход остановлен', 'ok');
  } else {
    const bat = selectedStrategy || lastStatus.strategy;
    if (!bat) { toast('Выберите стратегию во вкладке «Стратегии»', 'err'); return; }
    setCore('pending', 'Включаю…');
    try { await Z.installService(bat.endsWith('.bat') ? bat : bat + '.bat'); toast('Служба запущена: ' + bat, 'ok'); }
    catch (e) { toast('Ошибка: ' + e.message, 'err'); }
  }
  setTimeout(refreshStatus, 800);
});
$('#openFolderBtn').addEventListener('click', () => Z.openFolder());
$('#clearLog').addEventListener('click', () => { $('#log').textContent = ''; });

// ------------------------------------------------------------ стратегии ------
async function loadStrategies() {
  const list = $('#strategyList');
  let items = [];
  try { items = await Z.strategies(); } catch {}
  if (!items.length) { list.innerHTML = '<div class="empty">Стратегии не найдены. Укажите папку Zapret в «Настройки».</div>'; return; }
  const active = lastStatus?.strategy;
  list.innerHTML = '';
  for (const f of items) {
    const name = f.replace(/\.bat$/i, '');
    const el = document.createElement('div');
    el.className = 'strategy' + (name === selectedStrategy || name === active ? ' active' : '');
    el.innerHTML = `
      <div>
        <div class="strategy-name">${name}</div>
        ${name === active ? '<div class="strategy-badge">установлена как служба</div>' : ''}
      </div>
      <div class="strategy-actions">
        <button class="ghost run">Запустить</button>
        <button class="primary svc">Как службу</button>
      </div>`;
    el.querySelector('.run').addEventListener('click', async () => {
      selectedStrategy = name;
      try { await Z.start(f); toast('Запущено (процесс): ' + name, 'ok'); }
      catch (e) { toast('Ошибка: ' + e.message, 'err'); }
      setTimeout(() => { refreshStatus(); loadStrategies(); }, 800);
    });
    el.querySelector('.svc').addEventListener('click', async () => {
      selectedStrategy = name;
      try { await Z.installService(f); toast('Установлена служба: ' + name, 'ok'); }
      catch (e) { toast('Ошибка: ' + e.message, 'err'); }
      setTimeout(() => { refreshStatus(); loadStrategies(); }, 900);
    });
    el.addEventListener('click', (ev) => {
      if (ev.target.tagName === 'BUTTON') return;
      selectedStrategy = name;
      $$('.strategy').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
    });
    list.appendChild(el);
  }
}

// --------------------------------------------------------------- списки ------
const LIST_HINTS = {
  bypass: 'Домены, которые нужно проводить через обход Zapret (list-general-user).',
  exclude: 'Домены-исключения — Zapret их не трогает, трафик идёт напрямую (list-exclude-user).',
  ipexclude: 'IP-адреса и подсети в исключения (ipset-exclude-user). Формат: 1.2.3.4 или 1.2.3.0/24.',
};
$$('#listTabs .seg-btn').forEach(b => b.addEventListener('click', () => {
  $$('#listTabs .seg-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); currentList = b.dataset.list; loadList(currentList);
}));
async function loadList(which) {
  $('#listHint').textContent = LIST_HINTS[which];
  const box = $('#listItems');
  let items = [];
  try { items = await Z.listRead(which); } catch {}
  if (!items.length) { box.innerHTML = '<div class="empty">Список пуст. Добавьте домены выше.</div>'; return; }
  box.innerHTML = '';
  for (const v of items) {
    const chip = document.createElement('div');
    chip.className = 'chip ' + which;
    chip.innerHTML = `<span>${v}</span><span class="x">×</span>`;
    chip.querySelector('.x').addEventListener('click', async () => {
      await Z.listRemove(which, v); loadList(which);
    });
    box.appendChild(chip);
  }
}
async function addToList() {
  const inp = $('#listInput'); const val = inp.value.trim();
  if (!val) return;
  try { await Z.listAdd(currentList, val); inp.value = ''; loadList(currentList); toast('Добавлено', 'ok'); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}
$('#listAddBtn').addEventListener('click', addToList);
$('#listInput').addEventListener('keydown', e => { if (e.key === 'Enter') addToList(); });

// ----------------------------------------------------------- диагностика -----
$('#runDiagBtn').addEventListener('click', async () => {
  const box = $('#diagResults');
  box.innerHTML = '<div class="empty">Проверяю окружение…</div>';
  let res = [];
  try { res = await Z.diagRun(); } catch (e) { box.innerHTML = `<div class="empty">Ошибка: ${e.message}</div>`; return; }
  box.innerHTML = '';
  for (const r of res) {
    const el = document.createElement('div');
    el.className = 'diag-item ' + r.status;
    el.innerHTML = `<span class="icon"></span>
      <div class="body"><div class="d-name">${r.name}</div><div class="d-msg">${r.message}</div></div>`;
    if (r.fix) {
      const btn = document.createElement('button');
      btn.className = 'fix'; btn.textContent = 'Исправить';
      btn.addEventListener('click', async () => {
        btn.textContent = '…';
        try { await Z.diagFix(r.fix); toast('Исправлено', 'ok'); $('#runDiagBtn').click(); }
        catch (e) { toast('Ошибка: ' + e.message, 'err'); }
      });
      el.appendChild(btn);
    }
    box.appendChild(el);
  }
  toast('Диагностика завершена', 'ok');
});
$('#clearDiscordBtn').addEventListener('click', async () => {
  if (!confirm('Закрыть Discord и очистить его кэш?')) return;
  try { await Z.clearDiscord(); toast('Кэш Discord очищен', 'ok'); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
});

// ------------------------------------------------------------ обновления -----
$('#checkAppBtn').addEventListener('click', async () => {
  $('#updVersionText').textContent = 'Проверяю…';
  const r = await Z.checkApp();
  if (!r.ok) { $('#updVersionText').textContent = r.message; return; }
  if (r.upToDate) $('#updVersionText').textContent = `Установлена последняя версия: ${r.local}.`;
  else {
    $('#updVersionText').innerHTML = `Доступна новая версия <b>${r.remote}</b> (у вас ${r.local || '—'}).
      <a href="#" id="dlLink" style="color:var(--purple)">Открыть страницу загрузки</a>`;
    $('#dlLink').addEventListener('click', (e) => { e.preventDefault(); Z.openExternal(r.downloadUrl); });
  }
});
$('#updIpsetBtn').addEventListener('click', async () => {
  const r = await Z.updateIpset(); toast(r.ok ? 'IPSet обновлён' : 'Ошибка обновления', r.ok ? 'ok' : 'err');
});
$('#updHostsBtn').addEventListener('click', async () => {
  const r = await Z.updateHosts(); toast(r.message || (r.ok ? 'Готово' : 'Ошибка'), r.ok ? 'ok' : 'err');
});
$('#pickZipBtn').addEventListener('click', pickZip);
async function pickZip() {
  try {
    const r = await Z.pickZip();
    if (r) { toast('Установлена версия ' + r.version, 'ok'); afterInstall(); }
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}

// ----------------------------------------------- drag&drop zip по всему окну -
let dragDepth = 0;
const overlay = $('#dropOverlay');
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; overlay.classList.add('show'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) overlay.classList.remove('show'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; overlay.classList.remove('show');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) { toast('Нужен zip-архив', 'err'); return; }
  toast('Распаковываю ' + file.name + '…', 'info');
  try {
    const r = await Z.applyZip(file.path);
    toast('Установлена версия ' + r.version, 'ok'); afterInstall();
  } catch (err) { toast('Ошибка: ' + err.message, 'err'); }
});
// dropzone-подсветка на вкладке обновлений
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('hot'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, () => dz.classList.remove('hot')));

function afterInstall() {
  refreshStatus(); loadSettings();
  if (!$('.view[data-view="strategies"]').classList.contains('hidden')) loadStrategies();
}

// -------------------------------------------------------------- настройки ----
async function loadSettings() {
  const cfg = await Z.getConfig();
  $('#pathText').textContent = cfg.activePath || 'не выбрана';
  const g = await Z.gameGet();
  $$('#gameSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.game === g));
  let ip = 'loaded'; try { ip = await Z.ipsetGet(); } catch {}
  $$('#ipsetSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.ipset === ip));
  $('#autoUpdate').checked = await Z.autoUpdateGet();
}
$('#pickFolderBtn').addEventListener('click', async () => {
  try { const cfg = await Z.pickFolder(); if (cfg) { toast('Папка выбрана', 'ok'); afterInstall(); } }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
});
$$('#gameSeg .seg-btn').forEach(b => b.addEventListener('click', async () => {
  try { await Z.gameSet(b.dataset.game); loadSettings(); refreshStatus(); toast('Игровой фильтр: ' + b.textContent, 'ok'); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}));
$$('#ipsetSeg .seg-btn').forEach(b => b.addEventListener('click', async () => {
  try { await Z.ipsetSet(b.dataset.ipset); loadSettings(); toast('IPSet: ' + b.textContent, 'ok'); }
  catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}));
$('#autoUpdate').addEventListener('change', async (e) => {
  await Z.autoUpdateSet(e.target.checked);
  toast('Автопроверка ' + (e.target.checked ? 'включена' : 'выключена'), 'ok');
});

// ------------------------------------------------------------------ старт ----
(async function init() {
  // анимация появления и на стартовой вкладке
  const first = $('.view:not(.hidden)');
  if (first) { void first.offsetWidth; first.classList.add('enter'); }
  await checkAdmin();
  await ensureConfig();
  await refreshStatus();
  setInterval(refreshStatus, 5000);
})();
