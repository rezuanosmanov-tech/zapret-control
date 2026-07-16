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
let lastStatus = null;

// ---------------------------------------------------------------- утилиты ----
function toast(msg, kind = 'info') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
/*
 * Журнал в два слоя: простой (человеческие сообщения) и расширенный (всё,
 * включая технические). Переключаются как вкладки. Обе строки ротируются, чтобы
 * не разрастались бесконечно.
 */
const LOG_MAX = 500;
function appendLog(el, s) {
  const div = document.createElement('div');
  div.textContent = s;
  el.appendChild(div);
  while (el.childElementCount > LOG_MAX) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
function logLine(ev) {
  // Совместимость: старые строки могли приходить как обычный текст.
  const level = typeof ev === 'object' ? ev.level : 'simple';
  const line = typeof ev === 'object' ? ev.line : ev;
  if (!line) return;
  const t = new Date().toLocaleTimeString();
  const stamped = `[${t}] ${line}`;
  // Технический слой видит всё; простой — только человеческие сообщения.
  appendLog($('#logTech'), stamped);
  if (level === 'simple') appendLog($('#logSimple'), stamped);
}
Z.onLog(logLine);

$$('#logTabs .seg-btn').forEach(b => b.addEventListener('click', () => {
  $$('#logTabs .seg-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  const tech = b.dataset.log === 'tech';
  $('#logTech').classList.toggle('hidden', !tech);
  $('#logSimple').classList.toggle('hidden', tech);
}));

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
  if (v === 'tests') testLoadStrategies();
  if (v === 'autostart') autostartRefresh();
  if (v === 'lists') { loadList(); loadPresets(); }
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

  // SVG-луч рисуется в тех же ПИКСЕЛЬНЫХ координатах, что и искра (offset-path).
  // Без явного viewBox, совпадающего с размером слоя, путь SVG масштабируется
  // иначе, чем CSS-путь искры, и линия с шариком разъезжаются.
  const beamSvg = $('#beamLayer');
  beamSvg.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
  beamSvg.setAttribute('preserveAspectRatio', 'none');

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
    setTimeout(refreshStatus, 800);
  } else {
    const bat = selectedStrategy || lastStatus.strategy;
    // Вкладка «Стратегии» в простом режиме скрыта, поэтому выбор показываем прямо
    // здесь выпадающим списком, а не отправляем в несуществующую вкладку.
    if (!bat) { await openStrategyPicker(); return; }
    startBypass(bat);
  }
});

async function startBypass(bat) {
  setCore('pending', 'Включаю…');
  try {
    await Z.installService(bat.endsWith('.bat') ? bat : bat + '.bat');
    selectedStrategy = bat.replace(/\.bat$/i, '');
    toast('Обход включён: ' + selectedStrategy, 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
  setTimeout(refreshStatus, 800);
}

async function openStrategyPicker() {
  const sel = $('#stratSelect');
  let list = [];
  try { list = await Z.strategies(); } catch {}
  if (!list.length) { toast('Стратегии не найдены — проверьте папку Zapret', 'err'); return; }
  sel.innerHTML = '';
  for (const f of list) {
    const o = document.createElement('option');
    o.value = f; o.textContent = f.replace(/\.bat$/i, '');
    sel.appendChild(o);
  }
  $('#stratModal').classList.remove('hidden');
}
$('#stratCancel').addEventListener('click', () => $('#stratModal').classList.add('hidden'));
$('#stratModal').addEventListener('click', (e) => { if (e.target.id === 'stratModal') $('#stratModal').classList.add('hidden'); });
$('#stratConfirm').addEventListener('click', () => {
  const bat = $('#stratSelect').value;
  $('#stratModal').classList.add('hidden');
  if (bat) startBypass(bat);
});
$('#openFolderBtn').addEventListener('click', async () => {
  const r = await Z.openFolder();
  if (r && !r.ok) {
    if (r.reason === 'no-path') toast('Папка Zapret не выбрана — укажите её в «Настройки»', 'err');
    else if (r.reason === 'missing') toast('Папка не найдена — проверьте путь в «Настройки»', 'err');
    else toast('Не удалось открыть папку', 'err');
  }
});
$('#clearLog').addEventListener('click', () => { $('#logSimple').textContent = ''; $('#logTech').textContent = ''; });
$('#saveLog').addEventListener('click', async () => {
  try {
    const r = await Z.logSave();
    if (r && r.ok) toast('Журнал сохранён в файл', 'ok');
  } catch (e) { toast('Не удалось сохранить: ' + e.message, 'err'); }
});

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
/*
 * Список никогда не грузится в интерфейс целиком: main-процесс отдаёт страницу по
 * 50 строк (отсортированную и, если нужно, отфильтрованную) плюс общее число.
 * Поэтому даже 430 000 доменов не вешают окно — на экране максимум 50 плиток.
 * Полоса подгрузки показывается, когда в списке больше страницы: она даёт понять,
 * что программа обрабатывает большой файл, а не зависла.
 */
const LIST_HINTS = {
  bypass: 'Домены, которые нужно проводить через обход Zapret (list-general-user).',
  exclude: 'Домены-исключения — Zapret их не трогает, трафик идёт напрямую (list-exclude-user).',
  ipexclude: 'IP-адреса и подсети в исключения (ipset-exclude-user). Формат: 1.2.3.4 или 1.2.3.0/24.',
};
const PAGE_SIZE = 50;
const L = { which: 'bypass', page: 0, query: '', pages: 1, total: 0, busy: false };
let searchTimer = null;

$$('#listTabs .seg-btn').forEach(b => b.addEventListener('click', () => {
  $$('#listTabs .seg-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  L.which = b.dataset.list; L.page = 0; L.query = '';
  $('#listSearch').value = '';
  loadList();
}));

async function loadList() {
  if (L.busy) return;
  L.busy = true;
  $('#listHint').textContent = LIST_HINTS[L.which];

  const box = $('#listItems');
  const loading = $('#listLoading');

  // Полосу подгрузки показываем только на больших списках — на мелких она бы
  // мелькала и раздражала.
  const heavy = L.total > PAGE_SIZE || L.total === 0 && L.page === 0 && false;
  if (heavy) {
    loading.classList.remove('hidden');
    $('#llFill').style.width = '15%';
    $('#llText').textContent = 'Обрабатываю список…';
    box.classList.add('dim');
  }

  let res;
  try { res = await Z.listPage(L.which, { page: L.page, pageSize: PAGE_SIZE, query: L.query }); }
  catch { res = { items: [], total: 0, page: 0, pages: 1 }; }

  if (heavy) $('#llFill').style.width = '75%';

  L.total = res.total; L.pages = res.pages; L.page = res.page;

  box.innerHTML = '';
  if (!res.items.length) {
    box.innerHTML = L.query
      ? '<div class="empty">Ничего не найдено по запросу.</div>'
      : '<div class="empty">Список пуст. Добавьте домены выше.</div>';
  } else {
    const frag = document.createDocumentFragment();
    for (const v of res.items) {
      const chip = document.createElement('div');
      chip.className = 'chip ' + L.which;
      chip.innerHTML = `<span></span><span class="x">×</span>`;
      chip.querySelector('span').textContent = v;
      chip.querySelector('.x').addEventListener('click', async () => {
        await Z.listRemove(L.which, v);
        toast('Удалено: ' + v, 'ok');
        loadList();
      });
      frag.appendChild(chip);
    }
    box.appendChild(frag);
  }

  // счётчик и пагинация
  $('#listCount').textContent = L.total
    ? (L.query ? `найдено: ${L.total}` : `всего: ${L.total}`)
    : '';
  const pager = $('#listPager');
  if (L.pages > 1) {
    pager.classList.remove('hidden');
    $('#pagerInfo').textContent = `Страница ${L.page + 1} из ${L.pages}`;
    $('#pagePrev').disabled = L.page === 0;
    $('#pageNext').disabled = L.page >= L.pages - 1;
  } else {
    pager.classList.add('hidden');
  }

  if (heavy) {
    $('#llFill').style.width = '100%';
    setTimeout(() => { loading.classList.add('hidden'); box.classList.remove('dim'); }, 180);
  }
  L.busy = false;
}

$('#pagePrev').addEventListener('click', () => { if (L.page > 0) { L.page--; loadList(); } });
$('#pageNext').addEventListener('click', () => { if (L.page < L.pages - 1) { L.page++; loadList(); } });

$('#listSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { L.query = e.target.value.trim(); L.page = 0; loadList(); }, 250);
});

async function addToList() {
  const inp = $('#listInput');
  const val = inp.value.trim();
  if (!val) return;
  try {
    const r = await Z.listAdd(L.which, val);
    inp.value = '';
    inp.style.height = 'auto';
    let msg = r.added ? `Добавлено: ${r.added}` : 'Новых доменов нет';
    if (r.dup) msg += `, уже были: ${r.dup}`;
    if (r.bad.length) msg += `, отброшено неверных: ${r.bad.length}`;
    toast(msg, r.added ? 'ok' : 'info');
    L.page = 0; loadList();
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}
$('#listAddBtn').addEventListener('click', addToList);
// Enter — добавить, Shift+Enter — перенос строки (ввод многострочный).
$('#listInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addToList(); }
});
// авто-высота textarea под содержимое
$('#listInput').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
});

// ---- пресеты доменов ----
let presetCat = null;              // текущая категория { label, services }
const svcChosen = new Set();       // ключи выбранных сервисов

async function loadPresets() {
  const row = $('#presetRow');
  let presets = {};
  try { presets = await Z.listPresets(); } catch {}
  row.innerHTML = '';
  for (const [key, cat] of Object.entries(presets)) {
    const count = Object.keys(cat.services).length;
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.innerHTML = `<span></span><i>${count}</i>`;
    btn.querySelector('span').textContent = cat.label;
    btn.addEventListener('click', () => openPresetModal(cat));
    row.appendChild(btn);
  }
}

function svcUpdateCount() {
  $('#svcCount').textContent = 'выбрано: ' + svcChosen.size;
  const total = presetCat ? Object.keys(presetCat.services).length : 0;
  $('#svcAll').textContent = svcChosen.size === total && total ? 'Снять все' : 'Выбрать все';
}

function openPresetModal(cat) {
  presetCat = cat;
  svcChosen.clear();
  $('#presetTitle').textContent = 'Выбор сервисов — ' + cat.label;

  const grid = $('#svcGrid');
  grid.innerHTML = '';
  for (const [key, svc] of Object.entries(cat.services)) {
    const b = document.createElement('button');
    b.className = 'svc-btn';
    b.dataset.key = key;
    b.innerHTML = `<span class="svc-name"></span><span class="svc-num">${svc.domains.length}</span>`;
    b.querySelector('.svc-name').textContent = svc.label;
    b.addEventListener('click', () => {
      const on = b.classList.toggle('selected');
      if (on) svcChosen.add(key); else svcChosen.delete(key);
      svcUpdateCount();
    });
    grid.appendChild(b);
  }
  svcUpdateCount();
  $('#presetModal').classList.remove('hidden');
}

function closePresetModal() { $('#presetModal').classList.add('hidden'); presetCat = null; svcChosen.clear(); }

$('#svcAll').addEventListener('click', () => {
  if (!presetCat) return;
  const total = Object.keys(presetCat.services).length;
  const selectAll = svcChosen.size !== total;
  svcChosen.clear();
  $$('#svcGrid .svc-btn').forEach(b => {
    b.classList.toggle('selected', selectAll);
    if (selectAll) svcChosen.add(b.dataset.key);
  });
  svcUpdateCount();
});

async function applyPreset(which) {
  if (!presetCat) return;
  if (!svcChosen.size) { toast('Выберите хотя бы один сервис', 'err'); return; }
  // Собираем домены только выбранных сервисов.
  const domains = [];
  for (const key of svcChosen) domains.push(...presetCat.services[key].domains);
  const catLabel = presetCat.label;
  const n = svcChosen.size;
  closePresetModal();
  try {
    const r = await Z.listAddPreset(which, domains);
    const where = which === 'bypass' ? 'в обход' : 'в исключения';
    if (r.added && r.dup) toast(`Добавлено ${r.added} доменов ${where} (${r.dup} уже были)`, 'ok');
    else if (r.added) toast(`Добавлено ${r.added} доменов ${where} · сервисов: ${n}`, 'ok');
    else toast('Все выбранные домены уже в списке', 'info');
    if (which === L.which) { L.page = 0; loadList(); }
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}

$('#presetToBypass').addEventListener('click', () => applyPreset('bypass'));
$('#presetToExclude').addEventListener('click', () => applyPreset('exclude'));
$('#presetCancel').addEventListener('click', closePresetModal);
$('#presetModal').addEventListener('click', (e) => { if (e.target.id === 'presetModal') closePresetModal(); });


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

// =============================================================== тесты ========
/*
 * Оба режима перебирают конфиги. Разница только в глубине: стандартный проверяет
 * базовые адреса, DPI Check — полный список сервисов.
 *
 * Строки результатов добавляются СВЕРХУ: текущий конфиг всегда первый, готовые
 * уезжают вниз — мотать страницу не нужно. По окончании список пересортируется,
 * лучший всплывает наверх; переезд строк анимируется приёмом FLIP (замерили
 * позиции до, переставили узлы, доехали трансформом), поэтому перестановка
 * выглядит плавной, а не скачком.
 *
 * Плитки проб и строки не пересоздаются на каждое событие — меняются только
 * классы и текст, иначе CSS-анимации перезапускались бы и картинка дёргалась.
 */
const T = {
  mode: 'standard',
  running: false,
  probes: new Map(),      // host -> плитка
  rows: new Map(),        // bat  -> строка результата
  targets: [],            // описания сервисов для всплывашки
  steps: 0,
  step: 0,
  pinned: null,           // host, чья справка открыта
  simple: true,           // упрощённый режим вкладки (автоподбор)
};

const HINTS = {
  standard: 'Быстрый перебор всех стратегий по базовым адресам YouTube и Discord. Обход перед тестом выключается, чтобы проверка была честной, а после — возвращается как было.',
  dpi: 'Полная проверка: к YouTube и Discord добавляются Cloudflare, Twitch, соцсети и другие сервисы, которые обычно режет DPI. Дольше, зато видно всю картину. Связь во время теста прерывается — это нормально.',
};

function testSetMode(mode) {
  T.mode = mode;
  $$('#testMode .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('#testHint').textContent = HINTS[mode];
  testReset();
}

function testReset() {
  $('#dpiResults').innerHTML = '';
  $('#probeGrid').innerHTML = '';
  T.probes.clear(); T.rows.clear();
  popClose();
  $('#testStatus').textContent = 'Готов к запуску';
  $('#testBarFill').style.width = '0%';
}

async function testLoadStrategies() {
  const sel = $('#dpiTarget');
  let items = [];
  try { items = await Z.strategies(); } catch {}
  const keep = sel.value;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '__all__';
  all.textContent = `все стратегии (${items.length})`;
  sel.appendChild(all);
  for (const f of items) {
    const o = document.createElement('option');
    o.value = f;
    o.textContent = f.replace(/\.bat$/i, '');
    sel.appendChild(o);
  }
  if (keep) sel.value = keep;
}

async function testShowResultsPath() {
  try { $('#testResultsPath').textContent = await Z.testResultsFile(); } catch {}
}

// ---- всплывающая справка о сервисе ----
function popClose() {
  $('#probePop').classList.remove('open');
  $$('.probe.selected').forEach(el => el.classList.remove('selected'));
  T.pinned = null;
}

function popOpen(host, tile) {
  const t = T.targets.find(x => x.host === host);
  if (!t) return;
  const pop = $('#probePop');
  $('#popGroup').textContent = t.group;
  $('#popHost').textContent = t.host;
  $('#popDesc').textContent = t.desc;

  // позиционируем под плиткой, не вылезая за карточку
  const card = $('#testCard').getBoundingClientRect();
  const r = tile.getBoundingClientRect();
  const w = 290;
  let left = r.left - card.left;
  left = Math.min(left, card.width - w - 8);
  pop.style.left = Math.max(0, left) + 'px';
  pop.style.top = (r.bottom - card.top + 8) + 'px';

  $$('.probe.selected').forEach(el => el.classList.remove('selected'));
  tile.classList.add('selected');
  pop.classList.add('open');
  T.pinned = host;
}

document.addEventListener('click', (e) => {
  if (!T.pinned) return;
  if (e.target.closest('.probe') || e.target.closest('.probe-pop')) return;
  popClose();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') popClose(); });

// ---- плитки и строки ----
function probeTile(host) {
  let el = T.probes.get(host);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'probe';
  el.innerHTML = `<span class="probe-dot"></span><span class="probe-host"></span><span class="probe-ms"></span>`;
  el.querySelector('.probe-host').textContent = host;
  el.addEventListener('click', () => {
    if (T.pinned === host) popClose(); else popOpen(host, el);
  });
  $('#probeGrid').appendChild(el);
  T.probes.set(host, el);
  return el;
}

function dpiRow(bat, label, baseline) {
  let el = T.rows.get(bat);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'dpi-row' + (baseline ? ' baseline' : '');
  el.dataset.ok = '0'; el.dataset.avg = '99999'; el.dataset.baseline = baseline ? '1' : '0';
  el.innerHTML = `
    <div>
      <div class="dpi-name"></div>
      <div class="dpi-sub">проверяю…</div>
    </div>
    <div class="dpi-score">
      <div class="dpi-bar"><span></span></div>
      <div class="dpi-pct">—</div>
    </div>
    <button class="mini dpi-apply hidden">Применить</button>`;
  el.querySelector('.dpi-name').textContent = label.replace(/\.bat$/i, '');
  if (!baseline) {
    el.querySelector('.dpi-apply').addEventListener('click', async () => {
      try {
        await Z.installService(bat.endsWith('.bat') ? bat : bat + '.bat');
        selectedStrategy = bat.replace(/\.bat$/i, '');
        toast('Стратегия применена: ' + selectedStrategy, 'ok');
        refreshStatus();
      } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
    });
  }
  $('#dpiResults').prepend(el);      // свежий конфиг — сверху, готовые уезжают вниз
  T.rows.set(bat, el);
  return el;
}

/* Пересортировка с FLIP: сначала запоминаем, где строки были, потом переставляем
   узлы и «доводим» их трансформом от старой позиции к новой. */
function sortRows(best) {
  const cont = $('#dpiResults');
  const rows = [...cont.children];
  const before = new Map(rows.map(r => [r, r.getBoundingClientRect().top]));

  rows.slice().sort((a, b) => {
    if (a.dataset.baseline === '1') return 1;          // база сравнения — вниз
    if (b.dataset.baseline === '1') return -1;
    return (+b.dataset.ok - +a.dataset.ok) || (+a.dataset.avg - +b.dataset.avg);
  }).forEach(r => cont.appendChild(r));

  for (const r of rows) {
    const dy = before.get(r) - r.getBoundingClientRect().top;
    if (!dy) continue;
    r.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
      { duration: 560, easing: 'cubic-bezier(.2,.75,.25,1)' },
    );
  }
  if (best) T.rows.get(best)?.classList.add('best');
}

function testBusy(on) {
  T.running = on;
  $('#testCard').classList.toggle('busy', on);
  $('#testRunBtn').classList.toggle('hidden', on);
  $('#testStopBtn').classList.toggle('hidden', !on);
  $$('#testMode .seg-btn').forEach(b => b.disabled = on);
  $('#dpiTarget').disabled = on;
  $('#dpiBaseline').disabled = on;
}

Z.onTestEvent((ev) => {
  if (ev.type === 'saved') {
    const note = $('#testNote');
    note.classList.add('saved');
    $('#testResultsPath').textContent = ev.file;
    note.querySelector('.note-title').textContent = 'Результат дописан в файл';
    return;
  }

  if (ev.type === 'start') {
    T.steps = ev.total; T.step = 0;
    T.targets = ev.targets || [];
    $('#testBarFill').style.width = '0%';
    return;
  }

  if (ev.type === 'phase') { $('#testStatus').textContent = ev.text; return; }

  if (ev.type === 'probe') {
    const el = probeTile(ev.host);
    el.classList.remove('run', 'ok', 'fail');
    if (ev.state === 'run') el.classList.add('run');
    else {
      el.classList.add(ev.state);
      el.querySelector('.probe-ms').textContent = ev.state === 'ok' ? ev.ms + ' мс' : (ev.error || 'нет связи');
    }
    return;
  }

  if (ev.type === 'config') {
    const row = dpiRow(ev.bat, ev.label, ev.bat === '__baseline__');
    if (ev.state === 'run') {
      row.classList.add('running');
      $('#probeGrid').innerHTML = ''; T.probes.clear(); popClose();
      $('#testStatus').innerHTML =
        `Конфиг <b>${ev.label.replace(/\.bat$/i, '')}</b> — ${ev.index + 1} из ${ev.total}`;
    } else {
      row.classList.remove('running');
      row.dataset.ok = ev.okCount; row.dataset.avg = ev.avg || 99999;
      row.querySelector('.dpi-bar span').style.width = ev.score + '%';
      row.querySelector('.dpi-pct').textContent = ev.score + '%';
      row.querySelector('.dpi-sub').textContent =
        `${ev.okCount} из ${ev.total} проб${ev.avg ? ' · ' + ev.avg + ' мс' : ''}`;
      if (ev.bat !== '__baseline__' && ev.okCount > 0) row.querySelector('.dpi-apply').classList.remove('hidden');
      T.step = ev.index + 1;
      $('#testBarFill').style.width = Math.round(T.step / T.steps * 100) + '%';
    }
    return;
  }

  if (ev.type === 'done') {
    testBusy(false);
    $('#testBarFill').style.width = '100%';
    sortRows(ev.best);

    if (ev.aborted) {
      $('#testStatus').textContent = 'Тест остановлен. Проверенное записано в файл.';
      return;
    }
    if (ev.best) {
      if (T.simple) {
        // Упрощённый автоподбор: сразу включаем найденную лучшую стратегию.
        $('#testStatus').innerHTML = `Лучшая стратегия — <b>${ev.best.replace(/\.bat$/i, '')}</b>. Включаю…`;
        Z.installService(ev.best.endsWith('.bat') ? ev.best : ev.best + '.bat')
          .then(() => {
            selectedStrategy = ev.best.replace(/\.bat$/i, '');
            $('#testStatus').innerHTML = `Готово — включена стратегия <b>${selectedStrategy}</b>.`;
            toast('Подобрана и включена: ' + selectedStrategy, 'ok');
            refreshStatus();
          })
          .catch(e => toast('Не удалось включить: ' + e.message, 'err'));
      } else {
        $('#testStatus').innerHTML =
          `Лучший результат: <b>${ev.best.replace(/\.bat$/i, '')}</b> — он поднят наверх списка. Нажмите «Применить», чтобы включить его.`;
        toast('Тест завершён', 'ok');
      }
    } else {
      $('#testStatus').textContent = 'Ни одна стратегия не прошла проверки. Загляните в «Диагностику» — возможно, мешает другая программа.';
      toast('Рабочих стратегий не найдено', 'err');
    }
  }
});

$$('#testMode .seg-btn').forEach(b => b.addEventListener('click', () => {
  if (!T.running) testSetMode(b.dataset.mode);
}));

$('#openResultsBtn').addEventListener('click', () => Z.openTestResults());

$('#testStopBtn').addEventListener('click', async () => {
  $('#testStatus').textContent = 'Останавливаю, возвращаю прежние настройки…';
  await Z.testAbort();
});

$('#testRunBtn').addEventListener('click', async () => {
  if (!lastStatus || !lastStatus.ready) { toast('Сначала укажите папку Zapret', 'err'); return; }

  testReset();
  testBusy(true);
  $('#testStatus').textContent = 'Готовлю чистую проверку…';

  let list = [];
  try { list = await Z.strategies(); } catch {}
  if (!list.length) { toast('Стратегии не найдены', 'err'); testBusy(false); return; }

  if (T.simple) {
    // Автоподбор: всегда полный перебор всех стратегий по трём ключевым сервисам,
    // с базой без обхода. Режим здесь всегда 'standard' (базовый набор целей).
    await Z.testRun('standard', list, true);
    return;
  }

  const target = $('#dpiTarget').value;
  if (target !== '__all__') list = [target];
  await Z.testRun(T.mode, list, $('#dpiBaseline').checked);
});

// Переключение вкладки тестов между полным и упрощённым видом.
function applyTestMode(simple) {
  T.simple = simple;
  const view = document.querySelector('.view[data-view="tests"]');
  if (!view) return;
  view.querySelector('#simpleNote').classList.toggle('hidden', !simple);
  view.querySelectorAll('.adv-only').forEach(el => el.classList.toggle('hidden', simple));
  $('#testRunBtn').textContent = simple ? 'Подобрать автоматически' : 'Запустить тест';
}

testSetMode('standard');
testLoadStrategies();
testShowResultsPath();


// ========================================================= автозагрузка ======
/*
 * Состояние переключателя приходит из Планировщика задач, а не хранится в конфиге:
 * задачу могли удалить снаружи, и локальный флаг тогда врал бы.
 */
let autostartOn = false;
let autostartHidden = true;        // true = трей, false = окном

function autostartPaint(on, hidden = autostartHidden) {
  autostartOn = on;
  autostartHidden = hidden;
  const sw = $('#autoSwitch');
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
  $('.auto-card').classList.toggle('on', on);

  const sub = $('#autoSub');
  sub.classList.toggle('on', on);
  sub.textContent = on
    ? (hidden
        ? 'Включена: приложение стартует с Windows и сворачивается в трей.'
        : 'Включена: приложение стартует с Windows и открывается окном.')
    : 'Выключена: приложение придётся запускать вручную.';

  // последний шаг схемы и подпись меняются под выбранный режим
  $('#flowLast').textContent = hidden ? 'Прячется в трей' : 'Открывает окно';
  $('#flowLastSub').textContent = hidden
    ? 'окно не открывается, значок «ZH» рядом с часами'
    : 'главное окно появляется сразу при входе';

  // блок выбора режима активен только когда автозагрузка включена
  const modeRow = $('#autoModeRow');
  modeRow.classList.toggle('disabled', !on);
  $$('#autoModeSeg .seg-btn').forEach(b => {
    b.classList.toggle('active', (b.dataset.hidden === '1') === hidden);
    b.disabled = !on;
  });
}

async function autostartRefresh() {
  try {
    const r = await Z.autostartGet();
    autostartPaint(!!r.enabled, r.hidden !== false);
  } catch {
    $('#autoSub').textContent = 'Не удалось проверить состояние задачи.';
  }
}

$('#autoSwitch').addEventListener('click', async () => {
  const sw = $('#autoSwitch');
  const next = !autostartOn;
  sw.disabled = true;
  autostartPaint(next, autostartHidden);     // отвечаем мгновенно, не ждём Планировщик
  try {
    const r = await Z.autostartSet(next, autostartHidden);
    autostartPaint(!!r.enabled, r.hidden !== false);
    toast(r.enabled ? 'Автозагрузка включена' : 'Автозагрузка выключена', 'ok');
  } catch (e) {
    autostartPaint(!next);                    // откатываем, если задача не создалась
    toast('Ошибка: ' + e.message, 'err');
  } finally {
    sw.disabled = false;
  }
});

// переключение режима трей/окно — пересоздаёт задачу с новым аргументом
$$('#autoModeSeg .seg-btn').forEach(b => b.addEventListener('click', async () => {
  if (!autostartOn) return;
  const hidden = b.dataset.hidden === '1';
  if (hidden === autostartHidden) return;
  autostartPaint(true, hidden);
  try {
    await Z.autostartSet(true, hidden);
    toast(hidden ? 'Будет запускаться в трее' : 'Будет открываться окном', 'ok');
  } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
}));

autostartRefresh();

// ==================================================== индикаторы-лампочки =====
/*
 * Три лампы на стенде отражают доступность Discord / YouTube / Cloudflare.
 * Данные шлёт монитор из main раз в 12 секунд. Клик по лампе открывает справку
 * с расшифровкой цветов.
 */
let monitorInfo = [];
let lampPinned = null;

(async () => { try { monitorInfo = await Z.monitorInfo(); } catch {} })();

Z.onMonitor((ev) => {
  if (ev.type !== 'monitor') return;
  for (const [key, val] of Object.entries(ev.states)) {
    const lamp = document.querySelector(`.lamp[data-key="${key}"]`);
    if (!lamp) continue;
    lamp.classList.remove('ok', 'blocked', 'nonet');
    lamp.classList.add(val.state);
  }
});

function lampPopClose() {
  $('#lampPop').classList.remove('open');
  lampPinned = null;
}
function lampPopOpen(key) {
  const info = monitorInfo.find(m => m.key === key) || { label: key, host: '' };
  $('#lpTitle').textContent = info.label;
  $('#lpHost').textContent = info.host;
  $('#lampPop').classList.add('open');
  lampPinned = key;
}

$$('.lamp').forEach(l => l.addEventListener('click', (e) => {
  e.stopPropagation();
  const key = l.dataset.key;
  if (lampPinned === key) lampPopClose(); else lampPopOpen(key);
}));
document.addEventListener('click', (e) => {
  if (lampPinned && !e.target.closest('.lamp') && !e.target.closest('.lamp-pop')) lampPopClose();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lampPopClose(); });

// ==================================================== режим / темы ============
/*
 * Простой режим прячет продвинутые вкладки и показывает упрощённую вкладку тестов
 * (автоподбор). Расширенный открывает всё. Выбор хранится в конфиге, применяется
 * при запуске. Смена сопровождается анимацией: пункты меню нарастают/стакаются, а
 * вкладка «тесты» коротко подсвечивается, потому что её содержимое меняется.
 */
// В простом режиме видно: панель, стратегии, тесты, диагностика, обновления, настройки.
// Прячем: домены-и-списки, автозагрузка (тонкие настройки — для продвинутых).
// В простом режиме остаются: панель, тесты, диагностика, обновления, настройки.
// Прячем «стратегии» (ими рулит автоподбор), «домены-и-списки» и «автозагрузку».
const SIMPLE_HIDDEN = ['strategies', 'lists', 'autostart'];
let uiMode = 'simple';
let uiTheme = 'violet';

const THEMES = [
  { key: 'violet',  color: '#8b5cf6', label: 'Фиолетовый' },
  { key: 'black',   color: '#aab6cc', label: 'Графит' },
  { key: 'green',   color: '#22c55e', label: 'Изумрудный' },
  { key: 'pink',    color: '#ff4d8d', label: 'Розовый' },
  { key: 'crimson', color: '#ff5545', label: 'Бордовый' },
];

function applyTheme(key) {
  // Тема могла быть удалена (например, светлая) — откатываемся на дефолт.
  if (!THEMES.some(t => t.key === key)) key = 'violet';
  uiTheme = key;
  document.documentElement.setAttribute('data-theme', key);
  $$('#themeRow .theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === key));
}

function buildThemeRow() {
  const row = $('#themeRow');
  if (!row || row.childElementCount) return;
  for (const t of THEMES) {
    const dot = document.createElement('button');
    dot.className = 'theme-dot';
    dot.dataset.theme = t.key;
    dot.style.setProperty('--tw', t.color);
    dot.title = t.label;
    dot.setAttribute('aria-label', t.label);
    dot.addEventListener('click', () => { applyTheme(t.key); Z.setPref('theme', t.key); });
    row.appendChild(dot);
  }
}

function applyMode(mode, { animate = false } = {}) {
  uiMode = mode;
  $$('#modeSeg .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  const simple = mode === 'simple';
  // если активна вкладка, которую простой режим прячет — уводим на панель
  if (simple) {
    const active = $('.nav-item.active');
    if (active && SIMPLE_HIDDEN.includes(active.dataset.view)) {
      document.querySelector('.nav-item[data-view="dashboard"]').click();
    }
  }

  const hidden = $$('.nav-item').filter(b => SIMPLE_HIDDEN.includes(b.dataset.view));
  // Первое применение (при старте) — мгновенно, без transition, иначе скрытые
  // пункты на миг мелькнут и схлопнутся на глазах.
  if (!animate) {
    hidden.forEach(b => {
      b.style.transition = 'none';
      b.classList.toggle('mode-hidden', simple);
      b.classList.toggle('mode-show', !simple);
      void b.offsetWidth;
      b.style.transition = '';
    });
    applyTestMode(simple);
    const pb0 = $('#presetBlock');
    if (pb0) pb0.classList.toggle('hidden', simple);
    return;
  }

  // Волна света по вкладкам, затронутым сменой режима. Запускаем ДО схлопывания
  // (при уходе в простой вкладки ещё видны) и с задержкой при раскрытии (даём
  // появляющимся вкладкам набрать высоту, иначе блик рисуется в схлопнутом узле).
  const flashWave = () => {
    const affected = $$('.nav-item').filter(b =>
      SIMPLE_HIDDEN.includes(b.dataset.view) || b.dataset.view === 'tests');
    affected.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    affected.forEach((nav, i) => setTimeout(() => {
      nav.classList.remove('flash'); void nav.offsetWidth; nav.classList.add('flash');
      setTimeout(() => nav.classList.remove('flash'), 750);
    }, i * 90));
  };
  if (simple) flashWave();            // пункты ещё видны — блик успеет показаться
  else setTimeout(flashWave, 260);    // ждём, пока появляющиеся раскроются (stagger)

  hidden.forEach((b, i) => {
    if (simple) {
      b.classList.remove('mode-show');
      b.classList.add('mode-hidden');
    } else {
      // нарастание с задержкой (stagger) при раскрытии
      b.classList.remove('mode-hidden');
      if (animate) {
        b.style.transitionDelay = (i * 70) + 'ms';
        setTimeout(() => { b.style.transitionDelay = ''; }, 400 + i * 70);
      }
      b.classList.add('mode-show');
    }
  });

  // переключаем режим вкладки тестов и пресетов доменов
  applyTestMode(simple);
  const presetBlock = $('#presetBlock');
  if (presetBlock) presetBlock.classList.toggle('hidden', simple);
}

$$('#modeSeg .seg-btn').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.mode === uiMode) return;
  applyMode(b.dataset.mode, { animate: true });
  Z.setPref('mode', b.dataset.mode);
}));

// применяем сохранённые режим и тему при старте
(async () => {
  buildThemeRow();
  let cfg = {};
  try { cfg = await Z.config(); } catch {}
  applyTheme(cfg.theme || 'violet');
  applyMode(cfg.mode || 'simple');
})();
