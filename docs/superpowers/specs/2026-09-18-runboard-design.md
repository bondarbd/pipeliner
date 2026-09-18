# runboard — панель запуска рутинных задач разработчика

Дата: 2026-09-18. Статус: дизайн v1, согласован после разбора пятью критиками (YAGNI, надёжность, слабые LLM, безопасность, DSL/UX).

## 1. Задача

Разработчик ведёт ~10 Java/Maven-проектов (папки с git-репо) в корпоративной среде. Рутинные задачи вида «сделать одно и то же для N проектов, с ожиданием внешних систем и участием человека»:

- релиз: обновить develop → ветка `release/0.N` → Jenkins-сборка → результат (коммит, ссылка на образ) на страницу Confluence;
- МПР (устранение уязвимости): поднять версию либы в одном проекте, проверить, повторить на остальных;
- массовый рефакторинг, синк codestyle, release notes, триаж сборок.

Сейчас это делает gigacode (CLI-агент на модели класса Qwen) по скилам `release` и `mpr` из `~/IdeaProjects/work-skills`: SKILL.md — пошаговая процедура, логика — bash/python-скрипты с фиксированными выходами (`OK ... commit=...`, `RESULT=...`, exit-коды).

Нужна панель, в которой такие задачи описываются шаблонами, запускаются на выбранных проектах, видны по статусам, и в которую можно вмешаться при проблеме.

## 2. Принципы (зафиксированы, менять только осознанно)

1. **Панель показывает скилы, а не заменяет их.** Логика живёт в скриптах, которыми продолжает пользоваться и gigacode из терминала. Панель их вызывает, ведёт состояние, рисует таблицу и даёт кнопки.
2. **Детерминированное — в shell/js-шагах, агент — только там, где нужен текст или суждение.** Агент не мутирует внешние системы (Jenkins, Jira, Confluence, git push). Каждый agent-шаг обязан иметь `verify`.
3. **Шаблон — данные (YAML), а не программа.** Поэтому таблица «элемент × шаг» известна до запуска, возможны resume, retry по клетке, dry-run и валидация. Выражения — один готовый язык (JS в `node:vm`), сложная логика — `js:`-шаг.
4. **Контекст — в файлах.** Память между шагами и агентами — папка контекста запуска/элемента на диске, видимая человеку.
5. **Ошибка элемента изолирована.** Падение одной дорожки паузит её, остальные идут.
6. **Никакого слепого retry побочных эффектов.** Retry только у `retriable`-шагов; шаг может объявить `check` («уже сделано?»); после рестарта панели — только ручное решение.
7. **localhost — не граница доверия.** Токен, bind 127.0.0.1, проверка Origin.

## 3. Стек и структура

Node ≥ 18. Зависимости: `express`, `yaml`, `vue` (файл `vue.global.prod.js`, без сборки), `@picocss/pico`. Тесты — `node:test`. Все четыре пакета доступны в корп Nexus (проверено: 5.2.1 / 2.9.1 / 3.5.43 / 2.1.1).

```
runboard/
  package.json
  bin/runboard.js          # CLI: serve | run | validate | render | doctor | init | list | retry
  src/
    template/load.js       # чтение YAML из templates/ и ~/.runboard/templates/, JSON Schema, проверка ссылок
    template/schema.json   # публикуемая схема (для IDE и validate)
    expr.js                # ${{ }} — вычисление в node:vm
    engine/run.js          # создание запуска, дорожки, барьеры, лестница on_fail, бюджеты
    engine/store.js        # run.json (атомарная запись), логи, контекст
    engine/proc.js         # запуск процессов в своей process group, kill, таймауты
    engine/locks.js        # lock на ресурс (папку репо) и single-instance lock панели
    runners/shell.js
    runners/agent.js       # команда агента из config.yaml (gigacode на корп ПК, claude локально)
    runners/human.js
    runners/js.js
    api.js                 # express-роуты, токен, Origin/Host
    secrets.js             # маскирование при записи
  public/index.html, app.js, vendor/ (vue, pico — копируются из node_modules при установке)
  templates/hello.yaml     # обучающий, только локальный bash, фейковые проекты
  templates/release.yaml   # релиз на скриптах скилла release
  docs/superpowers/specs/
```

Данные: `~/.runboard/` (права 0700): `config.yaml`, `token` (0600), `templates/`, `runs/<id>/`, `locks/`.

`config.yaml`:

```yaml
projects_root: ~/projects
skills_root: ~/.gigacode/skills          # где лежат скрипты скиллов
env_file: ~/.config/release/env          # секреты; в шаги попадают только по whitelist
agent:
  command: ["gigacode", "-p", "{prompt}", "--approval-mode", "auto-edit"]
  readonly_command: ["gigacode", "-p", "{prompt}", "--approval-mode", "plan"]   # проверить флаг на корп ПК
  max_parallel: 2
  timeout: 1800
limits:
  parallel: 4                # одновременных элементов на шаге
  max_attempts: 3            # на клетку (элемент × шаг)
  max_agent_calls: 30        # на запуск
  run_timeout: 21600
logs:
  retention_days: 14
  max_step_log_bytes: 5000000
```

На Mac для разработки `agent.command` указывает на `claude -p ...`; на корп ПК — на gigacode. Раннер не знает, кто внутри.

## 4. Шаблон

### 4.1 Пример: `templates/release.yaml`

```yaml
# yaml-language-server: $schema=../src/template/schema.json
name: release
title: Релиз проектов
params:
  release: { type: string, required: true, label: "Номер релиза N (ветка release/0.N)" }
items:
  source: dirs                  # чекбоксы по подпапкам projects_root
modes: [all, pilot]             # pilot: первый выбранный элемент до конца → human → остальные

steps:
  - name: branch
    each: true
    resource: "repo:${{ item.dir }}"
    check: bash ${{ run.skills }}/release/scripts/git_release.sh exists "${{ item.dir }}" release/0.${{ run.params.release }}
    shell: bash ${{ run.skills }}/release/scripts/git_release.sh create "${{ item.dir }}" release/0.${{ run.params.release }}
    output: keys                # commit=<sha> → item.steps.branch.commit
    env: [PROJECTS_ROOT]
    on_fail:
      - do: pause

  - name: build
    each: true
    shell: >
      python3 ${{ run.skills }}/release/scripts/jenkins.py run-one
      --project ${{ item.name }} --branch release/0.${{ run.params.release }}
      --commit ${{ item.steps.branch.commit }} --out $OUT
    output: keys                # build_url, result, dist
    env: [JENKINS_URL, JENKINS_USER, JENKINS_TOKEN]
    timeout: 5400
    retriable: true
    on_fail:
      - do: retry
        times: 2
        delay: 60
      - do: pause

  - name: report
    once: true
    barrier: succeeded          # ждём всех, кто не paused/skipped; paused не блокируют
    js: ./steps/release-report.js      # рендерит markdown-таблицу из run.items → $OUT/report.md
    output: json

  - name: publish
    once: true
    agent:
      prompt: |
        Открой в Confluence страницу релиза 0.${{ run.params.release }} (MCP confluence).
        Вставь между маркерами <!-- runboard:start --> и <!-- runboard:end --> содержимое файла
        ${{ run.steps.report.path }}. Ничего другого на странице не меняй.
      input: ${{ run.steps.report }}
      timeout: 600
    verify: bash ${{ run.skills }}/release/scripts/confluence_check.sh "${{ run.params.release }}" "${{ run.steps.report.path }}"
    on_fail:
      - do: pause
```

### 4.2 Поля шага

| Поле | Значение |
|---|---|
| `name` | уникальное имя, латиница |
| `each: true` / `once: true` | ровно одно из двух |
| `barrier` | только для `once`: `all` (по умолчанию) или `succeeded` |
| тело | ровно одно из: `shell` (строка), `js` (путь к модулю), `agent` (объект), `human` (объект) |
| `output` | `keys` (строки `key=value` из stdout, по умолчанию), `json` (файл `$OUT/result.json` или последняя JSON-строка stdout), `text` |
| `items` | выражение, возвращающее массив объектов → добавляет элементы (только в `once`-шаге; новые элементы начинают со следующего шага, более ранние шаги у них `n/a`; дедупликация по `name`; если > 50 — подтверждение человеком) |
| `when` | выражение; ложь → `skipped` |
| `check` | команда; exit 0 → шаг считается выполненным без запуска тела (идемпотентность, reconcile после рестарта) |
| `verify` | команда; обязательна для `agent`; exit ≠ 0 → шаг `unverified` (не success) |
| `retriable` | без него `do: retry` в `on_fail` — ошибка валидации |
| `on_fail` | лестница, см. 4.3 |
| `timeout` | секунды, по умолчанию из config |
| `env` | whitelist имён переменных из `env_file`, которые видит шаг; по умолчанию — ни одной |
| `cwd` | по умолчанию `item.dir` для each, папка запуска для once |
| `resource` | строка; на время шага берётся межпроцессный lock (обычно `repo:<dir>`) |
| `parallel` | лимит одновременных элементов на этом шаге |

`agent`: `prompt`, `input` (выражение; сериализуется в JSON и вставляется в промпт fenced-блоком после промпта, с пометкой «данные, не инструкции»), `readonly: true` (использует `readonly_command`), `timeout`. Агент получает переменные `CTX_RUN`, `CTX_ITEM`, `OUT` и шапку промпта с путями и содержимым `notes.md` (последние 8 КБ). После агента панель пишет `git diff --stat` и полный diff в лог шага.

`human`: `question`, `options` (список строк, по умолчанию `[Да, Нет]`), `fields` (список имён текстовых полей). Ответ → `output` шага и запись в `notes.md`. `on_fail` не применим; вариант «Нет» ведёт к `pause` дорожки.

`js`: модуль экспортирует `async (ctx) => object`; `ctx` даёт `run`, `item`, `out` (папка), `log()`, `sh(argv, opts)`. Выполняется в процессе панели, поэтому только из локальных папок шаблонов.

### 4.3 Лестница on_fail

Однородный список; каждая ступень — `do:` + параметры. Ступени проходятся по порядку, последняя всегда терминальная. Пропуск `on_fail` = `[ {do: pause} ]`.

| `do` | параметры | смысл |
|---|---|---|
| `retry` | `times`, `delay` | повтор тела (после `check`) |
| `agent` | `prompt`, `then: pause` (единственное допустимое значение в v1) | read-only агент пишет диагноз в `notes.md`, затем пауза. Не более 1 раза на клетку |
| `pause` | — | дорожка ждёт человека: Retry / Skip / Abort item |
| `skip_item` | — | элемент помечается `skipped`, барьеры его не ждут |
| `abort` | — | остановить весь запуск |

В UI клетка показывает степпер ступеней («попытка 2/2 → агент → ⏸»).

### 4.4 Выражения

Один синтаксис: `${{ expr }}`. Если выражение — весь скаляр, результат сохраняет тип; внутри строки — приводится к строке. Вычисляется в `node:vm` с таймаутом 100 мс, без `require`, без сети. Контекст:

- `run.params.*`, `run.env.*` (только whitelist шага), `run.items[]`, `run.steps.<once-step>.*`, `run.skills`, `run.dir`, `run.id`;
- `item.name`, `item.dir`, `item.*` (поля элемента), `item.steps.<step>.*`, `item.ctx` (путь);
- `output` — только в `items:`.

Подстановка в `shell`: каждое значение проверяется регуляркой `^[A-Za-z0-9._/@:=+, -]*$`; иначе шаг падает с `unsafe substitution` ещё на этапе render (защита от инъекции через имена веток/тикетов). Для исключений — `raw: true` на шаге, помечается в UI.

## 5. Движок

**Запуск** = шаблон + параметры + элементы + режим (`all`/`pilot`). В `pilot` первый элемент проходит все `each`-шаги, затем автоматический `human` «Пилот ок, продолжать на остальных?»; при «Да» остальные элементы стартуют, пилотный `notes.md` подкладывается им как `input` каждого agent-шага.

**Дорожки.** Каждый элемент идёт по `each`-шагам независимо (лимит `parallel`). `once`-шаг — барьер: ждёт всех элементов согласно `barrier`; паузнутые и пропущенные не блокируют `succeeded`; при `all` — блокируют, UI показывает «кого ждём» с кнопкой исключить.

**Статусы клетки:** `pending, running, success, failed, unverified, paused, skipped, interrupted, n/a`. Запуска: `running, waiting_for_human, paused, done, failed, aborted`.

**Бюджеты:** `max_attempts` на клетку, `max_agent_calls` на запуск, `run_timeout`. Исчерпание → пауза с причиной, не fail.

**Состояние:** `runs/<id>/run.json` — единственный источник, перезапись `tmp + rename` после каждого события. Пишет только процесс панели; CLI-команды идут через API. Структура записи события (в `run.json` → `history[]`): время, элемент, шаг, попытка, статус, развёрнутая команда (с маскированием), pid/pgid, exit code, длительность, кто инициировал (`ui`/`cli`, OS-пользователь), хеш шаблона.

**Побочные эффекты:** перед стартом тела в `run.json` фиксируется `started` (write-ahead). После рестарта панели все `running` → `interrupted`; для них выполняется `check` (если есть) → `success`, иначе клетка ждёт человека. Авто-retry после рестарта нет. Живые дочерние процессы прошлого экземпляра добиваются по сохранённым pgid.

**Процессы:** каждый шаг — `spawn` с `detached: true` (своя группа), stdout/stderr → фильтр маскирования → лог-файл. Таймаут: SIGTERM группе → 10 с → SIGKILL. После убийства агента — `git status --porcelain`; грязное дерево → статус `dirty_after_kill`, retry заблокирован.

**Locks:** `~/.runboard/locks/<sha(resource)>` с pid и run id; ожидание до 10 мин, потом пауза «занято запуском X». `~/.runboard/instance.lock` — вторая панель не стартует.

## 6. Контекст запуска

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

Агент в шапке промпта получает: путь `CTX_ITEM`, содержимое `notes.md` (хвост 8 КБ, внутри делимитера «данные»), результаты предыдущих шагов элемента (JSON), инструкцию: «результат — в `$OUT/result.json` или строками `key=value`; свои выводы — допиши в notes.md; не задавай вопросов: если нужен ответ человека, заверши работу строкой `NEED_INPUT=<вопрос>`». `NEED_INPUT` панель превращает в `human`-шаг, ответ дописывается в `notes.md`, шаг повторяется.

`notes.md` редактируется из UI (подсказка агенту перед retry).

## 7. Безопасность

- Сервер слушает только `127.0.0.1`; при запуске генерируется токен в `~/.runboard/token` (0600); UI получает его из URL при открытии (`/#t=...`) и шлёт в заголовке `X-Runboard-Token`; все мутирующие запросы — POST с токеном; проверка `Origin` (только свой) и `Host` (только `127.0.0.1:<port>`).
- Шаблоны и `js`-шаги — только из `templates/` проекта и `~/.runboard/templates/`; при первом запуске нового/изменённого шаблона UI показывает список его команд и просит подтверждение (хеш запоминается).
- Секреты: `env_file` читается в память, в шаг попадают только по `env:`; никогда не в argv; маскирование на записи лога (точное значение, base64 и urlencoded формы, плюс `Authorization:`, `token=`, `password=`). В дизайне явно: маскирование снижает шум, не гарантирует.
- Агент: перед agent-шагом проверка чистого дерева (`git status --porcelain`, иначе пауза); `cwd` — папка элемента; после шага diff в лог; параллельно не более `agent.max_parallel`.
- git: обёртка `shell`-раннера отклоняет команды с `--force`, `push` только в ветки по паттерну из config (`release/*`, `feature/*`) — проверка по тексту команды, best effort; настоящая защита — branch protection на сервере.
- Логи: 0700, ретенция 14 дней, лимит размера лога на шаг (усечение середины), команда `runboard clean`.
- Планировщика нет: неинтерактивный запуск без человека умножает риски; когда понадобится — отдельный whitelist шаблонов.

## 8. API и UI

API (JSON, все под токеном):

```
GET  /api/templates                      список + params + items.source
POST /api/templates/:name/validate
GET  /api/projects                       подпапки projects_root
POST /api/runs                           {template, params, items, mode} → {id}
GET  /api/runs, GET /api/runs/:id        run.json (фронт поллит раз в 3 с)
GET  /api/runs/:id/log?item=&step=&seq=  хвост лога
GET  /api/runs/:id/context?item=         notes.md + steps
PUT  /api/runs/:id/context?item=         правка notes.md
POST /api/runs/:id/cells/:item/:step/{retry|skip|abort}
POST /api/runs/:id/answer                ответ на human-шаг
POST /api/runs/:id/{pause|resume|abort}
```

UI (Vue, три экрана):

1. **Шаблоны** — карточки; клик → форма запуска: параметры, чекбоксы проектов (или textarea JSON для `items.source: manual`), режим all/pilot, кнопка «Проверить» (dry-run: список команд после подстановки) и «Запустить».
2. **Запуск** — таблица элемент × шаг с цветными статусами и степпером on_fail в клетке; клик по клетке → лог, команда, diff, кнопки Retry/Skip/Abort; баннер human-вопроса сверху; вкладка «Контекст» элемента (notes.md с редактором, результаты шагов); панель «переменные элемента» с вычисленными значениями.
3. **Запуски** — список с фильтром по шаблону и статусу.

CLI: `runboard serve [--port]`, `runboard run <template> --param k=v --items a,b --mode pilot`, `runboard validate <tpl>`, `runboard render <tpl> --step --item`, `runboard run --dry-run`, `runboard doctor` (node, git, gigacode, jenkins ping, env_file — таблица ✓/✗ с подсказкой), `runboard init` (создаёт `~/.runboard/config.yaml` из примера), `runboard list`, `runboard retry <run> <item> <step>`.

## 9. Ошибки и поведение по умолчанию

- Ошибка валидации шаблона → строка/поле/подсказка («неизвестный шаг `buld`, возможно `build`»). Запуск невозможен.
- `unsafe substitution` — до запуска, в dry-run тоже.
- Неизвестный exit code shell-шага = fail. Шаги скиллов уже печатают причины, они видны в логе.
- Ошибка агента: exit code не считается успехом; успех = `verify` прошёл. Формат результата нарушен → один ремонтный повтор («верни только key=value»), затем пауза.
- Рестарт панели: см. раздел 5. Никаких автоматических повторов.
- Барьер при «вечно paused»: `succeeded` идёт дальше без него; `all` — показывает ожидание и кнопку исключить.

## 10. Тестирование

- Движок тестируется с фейковыми раннерами (`runners/fake.js`, результаты задаются таблицей) — дорожки, барьеры, лестница on_fail, бюджеты, pilot, items из `once`-шага, interrupted после «рестарта» (пересоздание движка из `run.json`).
- `expr.js`: типы, изоляция, таймаут, unsafe substitution.
- `proc.js`: реальные процессы `sleep`, kill группы, таймаут.
- `secrets.js`: маскирование форм секрета.
- API: supertest не тянем — `node:test` + `fetch` к поднятому серверу; проверка токена, Origin, Host.
- Шаблон `hello.yaml` — интеграционный прогон целиком на локальном bash (3 фейковых «проекта», один падает и уходит в pause, human-шаг, barrier succeeded) — используется и как smoke-тест, и как первый опыт пользователя.
- `release.yaml` тестируется dry-run'ом и против моков скриптов (`skills_root` указывает на папку с фейковыми `git_release.sh` / `jenkins.py`).

## 11. Изменения в скиллах (в work-skills, отдельная задача)

- `git_release.sh exists <dir> <branch>` — exit 0, если ветка на origin есть; `create` при существующей ветке на том же коммите, что develop → `OK existing=true`.
- `jenkins.py run-one --project --branch --commit --out $OUT` — триггер + ожидание + retry внутри, пишет `build_url= result= dist=` в stdout; reconcile по параметру `RUNBOARD_KEY=<run>:<item>:<attempt>` перед триггером, чтобы не плодить сборки.
- `confluence_check.sh` — проверка, что на странице есть блок между маркерами с нужными коммитами (через REST или MCP-скрипт).
- Скрипты остаются совместимыми с SKILL.md для gigacode.

## 12. Проверить на корп ПК до реализации agent-раннера

1. `gigacode --help`: точное имя флага headless (`-p`), значения `--approval-mode` (есть ли read-only/plan), флаг таймаута/лимита ходов, есть ли resume-сессии (не используем, но знать).
2. Поведение при параллельном запуске 2–3 процессов из разных cwd: нет ли общего lock/сессии в `~/.gigacode/`.
3. Что выводится в stdout в headless: только ответ или лог tool-calls (влияет на `output: keys`).
4. Работает ли MCP (confluence) в headless-режиме без интерактивного подтверждения при `auto-edit`.

Результаты вносятся в `config.yaml` и, при необходимости, в этот документ.

## 13. Не делаем в v1

Свой MCP-клиент; `goto`; `{{#each}}` и mustache; `poll`, `http`, `template`-подзапуски, form-builder для элементов (есть `manual` через JSON в textarea); event-sourcing и SSE; планировщик; мультипользовательность; OS keychain; worktree на запуск; вложенный each (при необходимости — `js`-шаг, возвращающий массив).

Критерий пересмотра: если в реальных шаблонах доля `js`-шагов превысит треть или появятся эмуляции ветвлений — переносить такие задачи на JS-модули, YAML оставить как план исполнения.
