/**
 * Собирает раздаточный архив: приложение вместе с node_modules, чтобы у людей
 * ничего не качалось и не ставилось — распаковал и запустил.
 *
 * Запуск:  node core/tools/pack-zip.js
 * Результат: release/ZapretControl-<версия>.zip
 *
 * Что внутри архива:
 *   Zapret Control/
 *     core/                       код + node_modules (только electron)
 *     Start Zapret Control.bat    запуск
 *     Create Desktop Shortcut.bat ярлык на рабочий стол
 *     README.txt
 *
 * Setup.bat и electron-builder в раздачу НЕ попадают: пользователю не нужен ни
 * npm, ни Node — Node уже внутри electron.exe.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.resolve(__dirname, '..');
const ROOT = path.resolve(CORE, '..');
const STAGE = path.join(ROOT, 'build-stage');
const RELEASE = path.join(ROOT, 'release');

const pkg = JSON.parse(fs.readFileSync(path.join(CORE, 'package.json'), 'utf8'));
const APP = path.join(STAGE, 'Zapret Control');
const DEST = path.join(APP, 'core');

console.log('> Готовлю staging…');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

for (const item of ['main.js', 'preload.js', 'src', 'assets', 'tools']) {
  fs.cpSync(path.join(CORE, item), path.join(DEST, item), { recursive: true });
}

// Манифест для раздачи: только electron. Скрипт pack и tools/ пользователю
// не нужны, поэтому в архив они не едут.
fs.writeFileSync(path.join(DEST, 'package.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main,
  author: pkg.author,
  license: pkg.license,
  scripts: { start: 'electron .' },
  dependencies: { electron: pkg.dependencies.electron },
}, null, 2) + '\n');

for (const bat of ['Start Zapret Control.bat', 'Create Desktop Shortcut.bat']) {
  fs.copyFileSync(path.join(ROOT, bat), path.join(APP, bat));
}

// README.txt с BOM — иначе «Блокнот» покажет кириллицу кракозябрами.
fs.writeFileSync(path.join(APP, 'README.txt'), '\uFEFF' + [
  'ZAPRET CONTROL',
  '',
  'Ничего устанавливать не нужно — ни Node.js, ни npm.',
  '',
  '1. Распакуйте папку целиком в любое место (не запускайте из архива).',
  '2. Запустите "Create Desktop Shortcut.bat" — появится ярлык на рабочем столе.',
  '3. Дальше запускайте с ярлыка или через "Start Zapret Control.bat".',
  '',
  'Приложению нужны права администратора: оно ставит службу Windows.',
  'В ярлыке этот флаг уже выставлен.',
  '',
  'Zapret HUB — made by _SAMOREZ_',
].join('\r\n'), 'utf8');

// npm-cli.js лежит рядом с node.exe — и у портативного Node из runtime/, и у
// системного. Зовём его через абсолютный путь: вызов короткого имени "npm.cmd"
// заставляет npm искать свои модули относительно текущей папки и падать.
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!fs.existsSync(npmCli)) throw new Error('npm-cli.js не найден рядом с node.exe: ' + npmCli);

console.log('> Ставлю electron в раздачу (только прод-зависимости)…');
execFileSync(process.execPath, [npmCli, 'install', '--omit=dev', '--no-fund', '--no-audit'],
  { cwd: DEST, stdio: 'inherit' });

const electronExe = path.join(DEST, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) throw new Error('electron.exe не распаковался: ' + electronExe);

fs.mkdirSync(RELEASE, { recursive: true });
const zip = path.join(RELEASE, `ZapretControl-${pkg.version}.zip`);
fs.rmSync(zip, { force: true });

console.log('> Пакую архив…');
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -Path '${APP}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`],
  { stdio: 'inherit' });

const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
fs.rmSync(STAGE, { recursive: true, force: true });
console.log(`\n> Готово: ${zip}  (${mb} МБ)`);
