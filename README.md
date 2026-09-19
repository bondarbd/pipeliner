# runboard

## Что это

runboard — локальная панель для рутинных задач разработчика вида «сделать одно и то же
для N проектов, с ожиданием внешних систем и участием человека»: релиз (обновить develop →
ветка `release/0.N` → сборка в Jenkins → отчёт на Confluence), устранение уязвимости (МПР),
массовый рефакторинг, синк codestyle. Сейчас это делают bash/python-скрипты скиллов
(`~/IdeaProjects/work-skills`) под управлением gigacode из терминала.

Панель показывает эти скилы, а не заменяет их: логика по-прежнему живёт в скриптах, панель
их вызывает по описанию из YAML-шаблона, ведёт состояние на диске, рисует таблицу
«элемент × шаг» и даёт кнопки Retry/Skip/Abort. Детерминированные действия — в `shell`/`js`-шагах,
LLM-агент задействуется только там, где нужен текст или суждение, и никогда не мутирует
внешние системы напрямую — каждый agent-шаг обязан иметь `verify`.

## Быстрый старт

```bash
npm install
node bin/runboard.js init
node bin/runboard.js doctor
node bin/runboard.js run hello --yes --answer Да
node bin/runboard.js serve
```

- `init` создаёт `~/.runboard/config.yaml` (0600) и `~/.runboard/templates/`.
- `doctor` проверяет окружение (node, git, agent.command, `projects_root`, `skills_root`,
  `env_file`, сами шаблоны) и печатает таблицу ✓/–/✗. На чистой машине без своих проектов
  он честно упадёт на `projects_root` (exit 1) — это нормально, поправьте путь в конфиге.
- `run hello --yes --answer Да` — первый прогон обучающего шаблона `hello` (см. «Шаблоны»).
  `--yes` подтверждает доверие шаблону при первом запуске, `--answer Да` отвечает на
  человеческий шаг без интерактивного `readline`. Шаг `gamma/flaky` в `hello` всегда падает
  и уходит в паузу — это заложено в шаблон, поэтому команда завершается кодом **2** (запуск
  `paused`), а не 0 — это ожидаемый результат первого запуска, не ошибка.
- `serve` поднимает сервер на `127.0.0.1` и печатает URL с одноразовым токеном в фрагменте
  (`#t=...`) — откройте его в браузере.

## Конфиг

`~/.runboard/config.yaml` (создаётся командой `init`, права 0700 на директорию, 0600 на файл):

```yaml
projects_root: ~/projects
skills_root: ~/.gigacode/skills          # где лежат скрипты скиллов (release/, mpr/…)
env_file: ~/.config/release/env          # секреты; в шаги попадают только по env: whitelist
agent:
  command: ["gigacode", "-p", "{prompt}", "--approval-mode", "auto-edit"]
  readonly_command: ["gigacode", "-p", "{prompt}", "--approval-mode", "plan"]
  max_parallel: 2
  timeout: 1800
limits:
  parallel: 4                # одновременных элементов на шаге
  max_attempts: 3             # на клетку (элемент × шаг)
  max_agent_calls: 30         # на запуск
  run_timeout: 21600
logs:
  retention_days: 14
  max_step_log_bytes: 5000000
```

`agent.command` — команда, которой раннер вызывает LLM-агента; раннер не знает, кто внутри.
На корп ПК это `gigacode`, локально на macOS для разработки — `claude -p ...`. Плейсхолдер
`{prompt}` подставляется текстом промпта. `agent.readonly_command` используется, когда шаг
помечен `readonly: true` (например, диагностический шаг в лестнице `on_fail`) — его точный
флаг (`--approval-mode plan` или другой) нужно проверить на корп ПК, см. чек-лист ниже.

## Шаблоны

Шаблоны — YAML, не программа: таблица «элемент × шаг» известна до запуска, поэтому возможны
resume, retry по клетке, dry-run и валидация. Лежат в `templates/` проекта и
`~/.runboard/templates/` (при совпадении имён приоритет — у пользовательской директории).
В комплекте:

- `templates/hello.yaml` — обучающий шаблон, только локальный bash и фейковые «проекты»
  (`alpha`, `beta`, `gamma`). `beta` один раз падает и чинится через `retry`, `gamma` падает
  всегда и остаётся в паузе; барьер `succeeded` собирает сводку, пропуская `gamma`. Это
  первое, что стоит запустить — он же smoke-тест панели.
- `templates/release.yaml` — реальный релиз на скриптах скилла `release`
  (`git_release.sh`, `jenkins.py`, `confluence_check.sh`).

### Поля шага (§4.2)

| Поле | Значение |
|---|---|
| `name` | уникальное имя, латиница |
| `each: true` / `once: true` | ровно одно из двух |
| `barrier` | только для `once`: `all` (по умолчанию) или `succeeded` |
| тело | ровно одно из: `shell` (строка), `js` (путь к модулю), `agent` (объект), `human` (объект) |
| `output` | `keys` (строки `key=value` из stdout, по умолчанию), `json` (файл `$OUT/result.json` или последняя JSON-строка stdout), `text` |
| `items` | выражение-массив объектов → добавляет элементы (только в `once`-шаге; более ранние шаги у новых элементов — `n/a`; дедупликация по `name`; > 50 — подтверждение человеком) |
| `when` | выражение; ложь → `skipped` |
| `check` | команда; exit 0 → шаг уже выполнен, тело не запускается (идемпотентность, reconcile после рестарта) |
| `verify` | команда; обязательна для `agent`; exit ≠ 0 → шаг `unverified` |
| `retriable` | без него `do: retry` в `on_fail` — ошибка валидации |
| `on_fail` | лестница, см. ниже |
| `timeout` | секунды; агентные шаги — `agent.timeout` из конфига (1800 по умолчанию), остальные — 3600, в конфиге не настраивается |
| `env` | whitelist переменных из `env_file`, видимых шагу; по умолчанию — ни одной |
| `cwd` | по умолчанию `item.dir` для `each`, папка запуска для `once` |
| `resource` | строка; на время шага берётся межпроцессный lock (обычно `repo:<dir>`) |
| `parallel` | лимит одновременных элементов на этом шаге |

`agent`: `prompt`, `input` (выражение, сериализуется в JSON и вставляется в промпт
fenced-блоком с пометкой «данные, не инструкции»), `readonly: true` (использует
`readonly_command`), `timeout`. `human`: `question`, `options` (по умолчанию `[Да, Нет]`),
`fields`; `on_fail` к `human` неприменим (это ошибка валидации), «Нет» ведёт к паузе дорожки.
`js`: модуль экспортирует `async (ctx) => object`, выполняется в процессе панели — поэтому
`js`-шаги допускаются только из локальных папок шаблонов (`templates/`, `~/.runboard/templates/`).

### Лестница on_fail (§4.3)

| `do` | параметры | смысл |
|---|---|---|
| `retry` | `times`, `delay` | повтор тела (после `check`); требует `retriable: true` на шаге |
| `agent` | `prompt`, `then: pause` (опционально; единственное значение в v1) | read-only агент (всегда через `agent.readonly_command`) пишет диагноз в `notes.md`; не более 1 раза на клетку. С `then: pause` дорожка сразу уходит в паузу; без `then` лестница продолжается следующей ступенью (которая, как и всякая лестница, обязана заканчиваться терминальной ступенью) |
| `pause` | — | дорожка ждёт человека: Retry / Skip / Abort item |
| `skip_item` | — | элемент помечается `skipped`, барьеры его не ждут |
| `abort` | — | остановить весь запуск |

Пропуск `on_fail` = `[{do: pause}]`. Последняя ступень всегда терминальная
(`pause`/`skip_item`/`abort`).

### Выражения (§4.4)

Единый синтаксис `${{ expr }}`, вычисляется в `node:vm` с таймаутом 100 мс, без `require` и
сети. Если выражение — весь скаляр, тип результата сохраняется; внутри строки — приводится к
строке. Доступно: `run.params.*`, `run.env.*` (только whitelist шага), `run.items[]`,
`run.steps.<once-step>.*`, `run.skills`, `run.dir`, `run.id`; `item.name`, `item.dir`,
`item.*`, `item.steps.<step>.*`, `item.ctx`; `output` — только в `items:`.

При подстановке в `shell` каждое значение проверяется регуляркой
`^[A-Za-z0-9._/@:=+, -]*$` — иначе шаг падает с `unsafe substitution` ещё на этапе рендера
(защита от инъекции через имена веток/тикетов). Для осознанных исключений — `raw: true` на
шаге, помечается в UI.

### Доверие шаблонам (trust-on-first-use)

Хеш шаблона считается по YAML-файлу и всем связанным файлам (`js:`-пути, всё под
`templates/<name>/`). При первом запуске нового или изменённого шаблона панель показывает
список его команд после подстановки и требует подтверждения: в CLI — флаг `--yes`, в UI —
кнопка «Подтвердить». После подтверждения хеш запоминается, повторные запуски того же
содержимого проходят без вопроса.

## Контекст запуска

```
runs/<id>/
  run.json
  context/run.md               # цель, параметры, решения человека
  context/steps/<step>.json    # output once-шагов (+ файлы из $OUT рядом)
  items/<name>/context/notes.md          # свободный текст: агент и человек
  items/<name>/context/steps/<step>.json # output шага
  items/<name>/logs/<step>.<seq>.log     # сырой вывод, seq — сквозной
  items/<name>/logs/<step>.<seq>.diff    # после agent-шага
```

Агент в шапке промпта получает путь `CTX_ITEM`, содержимое `notes.md` (хвост 8 КБ, внутри
делимитера «данные»), результаты предыдущих шагов элемента (JSON) и инструкцию: результат —
в `$OUT/result.json` или строками `key=value`; свои выводы дописывать в `notes.md`; вопросов
не задавать — если нужен ответ человека, завершить работу строкой `NEED_INPUT=<вопрос>`.
`NEED_INPUT` панель превращает в `human`-шаг, ответ дописывается в `notes.md`, шаг
повторяется. `notes.md` можно редактировать из UI (подсказка агенту перед retry).

## CLI

```
runboard init                                        создать ~/.runboard/config.yaml и templates/
runboard doctor                                       проверить окружение (node, git, agent, projects_root, skills_root, env_file, шаблоны)
runboard validate <template>                          проверить YAML шаблона
runboard render <template> --step S [--item I]        показать подставленную команду шага, без запуска
runboard run <template> --param k=v --items a,b --mode all|pilot [--dry-run] [--yes] [--answer TEXT]
runboard list                                         список запусков
runboard show <run>                                   таблица элемент × шаг для запуска
runboard retry <run> <item|_> <step>                  повторить клетку (_ — once-шаг)
runboard answer <run> <item|_|__pilot__> <step|-> TEXT [--wait N]   ответить на human-шаг/пилота
runboard clean [--days N]                              удалить старые запуски (retention_days по умолчанию)
runboard serve [--port P]                              поднять сервер на 127.0.0.1, напечатать URL с токеном
```

Если `runboard serve` уже запущен, команды `run`/`retry`/`answer` идут через его API (не
создают второй движок); иначе выполняются в собственном процессе под instance lock'ом, чтобы
не пересекаться с работающим сервером.

Коды возврата: **0** — запуск дошёл до `done`; **2** — запуск завершился в состоянии
`paused`/`failed`/`aborted` (например, шаг ушёл в паузу — как `gamma` в `hello`); **1** —
ошибка выполнения команды (не найден шаблон/запуск и т. п.); **3** — шаблон не прошёл
проверку доверия и нужен `--yes`.

## Чек-лист перед запуском на корп ПК

Проверить до реализации/использования agent-раннера на корп ПК:

1. `gigacode --help`: точное имя флага headless (`-p`), значения `--approval-mode` (есть ли
   read-only/plan), флаг таймаута/лимита ходов, есть ли resume-сессии (не используем, но
   знать).
2. Поведение при параллельном запуске 2–3 процессов из разных cwd: нет ли общего
   lock/сессии в `~/.gigacode/`.
3. Что выводится в stdout в headless-режиме: только ответ или ещё лог tool-calls (влияет на
   `output: keys`).
4. Работает ли MCP (confluence) в headless-режиме без интерактивного подтверждения при
   `auto-edit`.

Результаты вносятся в `config.yaml` и, при необходимости, в
`docs/superpowers/specs/2026-09-18-runboard-design.md`.

Практические команды для проверки пп. 1–3:

```bash
gigacode --help
gigacode -p "напечатай OK" --approval-mode auto-edit
```

Запустить последнюю команду параллельно из двух разных папок проектов и убедиться, что в
stdout — только ответ агента (а не вперемешку с логом инструментов) и что процессы не мешают
друг другу через общее состояние в `~/.gigacode/`. По итогам заполнить в
`~/.runboard/config.yaml` точный `agent.readonly_command` (флаг read-only/plan режима,
найденный на шаге 1).

`skills_root` в конфиге должен указывать на директорию, СОДЕРЖАЩУЮ `release/` со скриптами
скилла (`git_release.sh`, `jenkins.py`, `confluence_check.sh`) — на корп ПК это
`~/.gigacode/skills`. Настройки самих скриптов (Jenkins, Confluence) читаются из
`env_file` (по умолчанию `~/.config/release/env`, права 0600) — см. пример переменных,
включая `CONFLUENCE_URL`, `CONFLUENCE_TOKEN`/`CONFLUENCE_USER`/`CONFLUENCE_PASSWORD`,
`CONFLUENCE_SPACE`, `CONFLUENCE_RELEASE_TITLE`, в
`~/IdeaProjects/work-skills/release/config.example.env`.

Шаг `build` в `templates/release.yaml` вызывает `jenkins.py run-one` с явным `--max-retries 0`
(ретраи владеет только лестница runboard, `on_fail: retry times 1`) и передаёт в шаг
`RUN_ONE_MAX_WAIT` (ожидание сборки в jenkins.py, по умолчанию 5400с) при `timeout: 6600` самого
шага runboard — таймаут шага должен оставаться больше `RUN_ONE_MAX_WAIT`.

## Безопасность

- Сервер слушает только `127.0.0.1`; токен в `~/.runboard/token` (0600) передаётся UI один
  раз через URL (`/#t=...`), дальше хранится в `sessionStorage` и шлётся заголовком
  `X-Runboard-Token`; проверяются `Origin` и `Host` запроса.
- Шаблоны и `js`-шаги — только из `templates/` проекта и `~/.runboard/templates/`; первый
  запуск нового/изменённого шаблона требует подтверждения (см. «Доверие шаблонам» выше).
- Секреты из `env_file` попадают в шаг только по `env:`-whitelist, никогда не в argv;
  маскируются при записи в лог, промпты и подставленные команды (точное значение, base64 и
  urlencoded формы, плюс `Authorization:`, `token=`, `password=`) — маскирование снижает шум,
  а не гарантирует отсутствие утечки.
- Подстановки в `shell` отклоняются при небезопасных символах (`unsafe substitution`) ещё до
  запуска — защита от инъекции через имена веток/тикетов.
- git-обёртка отклоняет команды с `--force`; push разрешён только в ветки по паттерну из
  конфига (`release/*`, `feature/*`) — эта проверка по тексту команды, best effort, настоящая
  защита — branch protection на сервере.

## Чего нет в v1

Свой MCP-клиент; `goto`; `{{#each}}` и mustache; шаги `poll`, `http`, вложенные
шаблоны-подзапуски, form-builder для элементов (есть `manual` через JSON в textarea);
event-sourcing и SSE; планировщик; мультипользовательность; OS keychain; отдельный worktree
на запуск; вложенный `each` (при необходимости — `js`-шаг, возвращающий массив элементов).
