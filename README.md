# Zapret Control

Графический интерфейс управления Zapret (обвязка над Flowseal `zapret-discord-youtube`)
для участников Discord-сообщества **Zapret HUB**.

## Структура

```
zapret-control/
├─ core/                      весь код приложения
│  ├─ main.js  preload.js     главный процесс и мост в интерфейс
│  ├─ src/                    интерфейс (index.html, styles.css, app.js)
│  ├─ assets/                 иконки
│  └─ tools/                  make-shortcut.ps1, pack-zip.js
├─ runtime/                   портативный Node.js (качается сам, в git не идёт)
├─ tools/ensure-node.bat      скачивает runtime при первом запуске
├─ Setup.bat                  DEV: поставить зависимости + ярлык
├─ Build.bat                  DEV: собрать portable exe
├─ Pack.bat                   DEV: собрать раздаточный zip
├─ Start Zapret Control.bat   запуск
└─ Create Desktop Shortcut.bat  ярлык на рабочий стол
```

Системный Node.js **не нужен**: `ensure-node.bat` один раз скачивает портативный
Node в `runtime/`, и все скрипты зовут его по абсолютному пути. Вызывать `npm`
коротким именем нельзя — npm разрешает свои модули через `%~dp0`, и cmd
подставляет туда текущую папку, из-за чего npm ищет сам себя в `core\node_modules`.

## Разработка

| Скрипт | Что делает |
|---|---|
| `Setup.bat` | ставит зависимости в `core/` и делает ярлык на рабочем столе |
| `Start Zapret Control.bat` | запускает `electron.exe` напрямую, с правами админа |
| `Build.bat` | `core/dist/ZapretControl-portable.exe` |
| `Pack.bat` | `release/ZapretControl-<версия>.zip` — то, что раздаётся |

## Что получают пользователи

В `Pack.bat` собирается zip, внутри которого уже лежит `core/node_modules` с
Electron. Людям не нужны ни Node.js, ни npm, ни интернет при установке: распаковал
папку, запустил `Create Desktop Shortcut.bat`, дальше — с ярлыка. `Setup.bat`,
`Build.bat`, `runtime/` и `electron-builder` в раздачу не попадают.

Ярлык создаётся с флагом «Запуск от имени администратора» (бит `0x20` в байте 21
файла `.lnk`) — приложение ставит службу Windows и без прав админа не заработает.
Путь к рабочему столу берётся через `[Environment]::GetFolderPath('Desktop')`,
поэтому перенаправление папки в OneDrive не ломает установку.

## Обновление Zapret

Во вкладке «Обновления» перетащите zip новой версии. Каждая версия распаковывается
в отдельную папку `%APPDATA%\zapret-control\installs\`, а пользовательские данные
переносятся автоматически:

- `lists/list-general-user.txt` — домены в обход
- `lists/list-exclude-user.txt` — домены-исключения
- `lists/ipset-exclude-user.txt` — IP-исключения
- `lists/ipset-all.txt` (+ `.backup`) — режим IPSet
- `utils/game_filter.enabled`, `utils/check_updates.enabled` — настройки

Файлы читаются в память **до** распаковки, поэтому даже переустановка той же версии
поверх себя не стирает списки. Старые установки не удаляются — можно откатиться,
указав нужную папку в «Настройки → Папка Zapret».

## Релиз

Пуш тега `v*` запускает GitHub Actions: собирается и portable exe, и раздаточный
zip, оба прикрепляются к релизу.

made by **_SAMOREZ_**
