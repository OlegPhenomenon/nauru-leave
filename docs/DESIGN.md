# Nauru Leave Desk — проектное описание для разработки

Источник требований: `docs/spec/SPEC_RU.txt` (L01–L14, разделы 7–12). Схема БД — `backend/migrations/0001_init.sql`
(авторитетна). API — `docs/API.md`. Этот документ фиксирует **правила**, которые код обязан реализовать точно.

## 0. Стек и структура

| Часть | Решение |
|---|---|
| Backend | Rust stable, один crate `backend/` → бинарь `nauru-leave`. axum 0.8, tokio, rusqlite (feature `bundled`), serde, time/chrono, argon2, totp-rs, sha2, rand, csv, rust-embed, tracing. Без ORM. |
| БД | SQLite, WAL, `foreign_keys=ON`, `busy_timeout=5000`. Все изменяющие операции — `BEGIN IMMEDIATE` (одна писательская блокировка на файл) → два параллельных запроса не потратят одни и те же минуты. |
| Frontend | `frontend/`: Vite + React + TypeScript + react-router. Без UI-китов, свой CSS. Сборка в `frontend/dist`, встраивается в бинарь через rust-embed. |
| Запуск | `nauru-leave serve`, `init-production`, `user …`, `migrate`, `seed-template`, `backup`, `restore`, `run-jobs-once`. Docker multi-stage на `debian:bookworm-slim` (≈115 МБ образ, из них ≈75 МБ — базовый слой; бинарь ≈7 МБ, RSS в простое ≈7 МБ). |

Экономия ресурсов: один процесс, фоновые задания — одна tokio-задача на весь процесс (общий планировщик, не по
песочнице). Соединение SQLite открывается на одну операцию внутри `spawn_blocking` и закрывается; вся транзакция —
в одной задаче. Глобальный семафор (`NLD_MAX_DB_TASKS`, по умолчанию 16) берётся **до** spawn_blocking. Никаких
сетевых вызовов, сканирования и архивации внутри транзакции. `profile.release`: `lto = "thin"`, `strip = true`,
`codegen-units = 1`, `opt-level = "s"`. `profile.dev`: `debug = "line-tables-only"` (экономия диска).

## 1. Режимы

`NLD_MODE=demo|production`.

- **demo**: каждому посетителю — своя песочница = копия шаблонной БД `data/template.sqlite` (закрытый,
  checkpoint-нутый, неизменяемый файл; генерируется `seed-template` при старте, если отсутствует) в
  `data/sandboxes/<id>-g<generation>.sqlite` + файлы `data/files/<id>-g<generation>/`. Создаётся **только** по явной
  кнопке «Start demo» (`POST /api/demo/start`), не при открытии страницы. Cookie `nld_sbx` (HttpOnly, Secure,
  SameSite=Lax, host-only), id — 128 бит случайности. Реестр песочниц — `data/sandboxes.sqlite`
  (id, generation, created_at, last_seen_at, bytes) — переживает перезапуск; уборщик каждые 10 мин удаляет песочницы
  без активности > 24 ч. Лимиты: `NLD_MAX_SANDBOXES` (300; при переполнении — 503 «demo is full, try later», чужие не
  вытесняются), создание/сброс ≤ 5 в час с одного IP, ≤ 10 МБ файлов на песочницу. «Reset demo» = новая generation;
  старый файл удаляется уборщиком, сессии старой generation недействительны (сессии живут в файле песочницы).
  Вход — выбор персонажа (`/api/demo/login`), письма — только в таблицу `mailbox` (просмотрщик в UI), отправки наружу нет.
  **Демо-часы** (бизнес-дата песочницы): настройка `demo_today` (начально `2026-10-08`), меняется кнопкой
  «Time travel» — чтобы показать шаг 8 «период закончился». Все бизнес-проверки берут «сегодня» из `Clock`;
  сроки сессий, rate-limit и TTL — всегда по реальному времени. UI постоянно показывает плашку
  «Demo · business date 2026-10-08 · fictional data & rules».
- **production**: одна БД `data/main.sqlite`, нет персонажей, нет mailbox-просмотрщика, нет time travel,
  вход пароль + TOTP (обязателен для ролей hr/hr_medical/final_approver/adjustment_approver/tech_admin/auditor и для
  менеджеров), SMTP через настройки (`NLD_SMTP_URL`), блокировка после 5 неудачных попыток на 15 мин.

## 2. Расчёт дней (L03)

`compute_days(employee, leave_type, start, end, start_part, end_part)`:

1. Для каждой даты d ∈ [start, end]: график сотрудника на d (`employee_schedules` → `schedule_versions`, действующие на d).
   Нет графика → ошибка `no_schedule` (не ноль молча).
2. `scheduled = minutes по дню недели`; если есть `calendar_exceptions` на d (для этого графика или общий) →
   `scheduled = exception.minutes`.
3. `scheduled == 0` → строка `part='none', minutes=0`, пояснение «Saturday — non-working» / «Holiday: X».
4. Часть дня: если start == end и start_part ∈ {am,pm} → половина; иначе первый день `pm` → половина, последний день
   `am` → половина. Половина = `scheduled / 2` (целочисленно; для 480 → 240). Если `leave_type.allow_half_day = 0`
   и часть ≠ full → ошибка.
5. `period_year = year(d)`.

Каждая строка хранит `schedule_version_id`, `exception_id` и текст пояснения — снимок на момент отправки.
Изменение графика/праздника **не** меняет отправленные редакции; HR видит отчёт «затронутые будущие записи»
(`GET /api/reports/schedule-drift`) и может инициировать пересмотр через изменение заявления.

Пересечения (L05): у сотрудника не может быть двух действующих отсутствий в одно и то же время. Действующие =
заявления `kind='leave'` в статусах submitted/needs_information/under_review (их current revision) и approved
(их effective revision), плюс открытые amendment (их revision). Конфликт, если даты совпадают и части пересекаются
(`full` пересекается со всем; `am` и `pm` — нет). При изменении/отмене исходное заявление (parent) исключается из
проверки, чтобы не конфликтовать с собой.

## 3. Счета и книга движений (раздел 7)

- Счёт = (employee, leave_type, period_year). Создаётся лениво.
- `ledger_balance(account, date) = SUM(minutes) WHERE effective_date <= date`.
- `reserved(account) = SUM(reservations.minutes WHERE active=1)`.
- `available(account, today) = ledger_balance(account, today) − reserved(account)`.
- Расход утверждённого отпуска записывается с `effective_date = дата решения` (не даты отпуска) — поэтому прошедший
  отпуск не списывается второй раз; «прошедшие дни» — отдельный отчётный показатель из `request_days`.
- Будущие начисления не увеличивают доступное. Демо-правило (вымышленное, `status='demo_fictional'`):
  annual leave, `accrual_mode='annual_upfront'`, 20 дней в год, право следующего года публикуется за 3 месяца
  (`advance_publish_months=3`, т.е. начисление за 2027 можно провести с 2026-10-01, effective_date = дата запуска),
  перенос разрешён, без сгорания.
- **Распределение дня по счетам** (`allocate`): минуты дня d сначала идут на счёт `year(d)`; если не хватает и
  политика разрешает перенос — остаток на более ранние счета (от старых к новым), с непросроченным переносом. Если
  всё равно не хватает и `allow_negative=0` → ошибка `insufficient_balance` с разбивкой. Распределение хранится в
  `revision_allocations`; резерв = сумма распределений по счёту.
- `leave_types.uses_balance=0` (например unpaid) → дни считаются, счета/резервы не создаются.
- `op_key` (уникальный) формируется детерминированно: `consume:{revision_id}:{account_id}`,
  `return:{amendment_revision_id}:{account_id}`, `adjust:{adjustment_id}`, `accrual:{policy_id}:{employee}:{year}`,
  `opening:{employee}:{type}:{year}` (бизнес-уникальность: изменённый/переупорядоченный CSV не задвоит начальный
  остаток), `expiry:{account}:{date}`. Повтор = no-op.
- Записи неизменяемы (триггеры). Исправление — только новая запись.

### Проверяемый пример (обязан проходить как интеграционный тест)

| Событие | Учётный | Резерв | Доступно |
|---|---|---|---|
| opening 20 дней (9600 мин) | 20 | 0 | 20 |
| submit 9–13.11.2026 (5×480) | 20 | 5 | 15 |
| approve | 15 | 0 | 15 |
| amendment → 9–11.11 (submitted) | 15 | 0 | 15 |
| approve amendment: return 2 дня | 17 | 0 | 17 |
| time travel на 2026-11-12 | 17 | 0 | 17 |

## 4. Заявление, редакции, маршрут (L05–L07)

Статусы — как в таблице раздела 8 ТЗ. Переходы:

| Из | Действие | В | Учёт |
|---|---|---|---|
| — | create draft | draft | ничего |
| draft | edit / delete | draft / (удаление черновика разрешено, аудит остаётся) | ничего |
| draft | submit | submitted | редакция фиксируется (`submitted_at`), дни+распределение сохраняются, резервы создаются, создаются шаги |
| submitted/under_review | step decide (positive, не последний) | under_review | — |
| submitted/under_review | needs_information (любой шаг) | needs_information | резерв сохраняется; шаг остаётся pending |
| needs_information | respond (только текст) | предыдущий статус | — |
| needs_information/submitted/under_review | revise (даты/тип/части меняются) | submitted | новая редакция; старые резервы `superseded`, новые созданы — в одной транзакции; все шаги старой редакции `superseded`, маршрут заново |
| любой открытый | recommend_reject / reject final | rejected | резервы освобождаются (`rejected`) |
| любой открытый | withdraw (сотрудник/HR за него) | withdrawn | резервы освобождаются |
| under_review | final approve | approved | резерв → consumption одной транзакцией; `effective_revision_id = current` |

Решения руководителя `recommend_reject` **не** отклоняет автоматически — шаг завершается с отрицательной рекомендацией,
маршрут идёт дальше, окончательное решение принимает final_decision (руководитель лишь рекомендует, ТЗ шаг 4).
HR `checked_problem` также передаётся дальше с комментарием. Отклонить может только final_decision (`reject`, причина
обязательна).

Маршрут (L06): при отправке создаются 3 шага:
1. `manager_recommendation` — assignee = user руководителя из действующего назначения сотрудника на дату отправки.
   Нет руководителя или у руководителя нет учётной записи → `assignee_user_id = NULL`, шаг всё равно `pending`, в
   очереди HR появляется как проблема «Unassigned step» (не пропускается).
2. `hr_check` — assignee NULL = любой пользователь с ролью `hr`, чей scope покрывает подразделение сотрудника.
3. `final_decision` — любой пользователь с ролью `final_approver` в scope.
HR может назначить/переназначить конкретного исполнителя шага (`reassign`), это аудитируется.

Кто может выполнить шаг: прямой исполнитель (assignee или подходящая роль) **или** получатель действующей делегации от
него (scope совпадает или `all_approvals`, today ∈ [valid_from, valid_to], не отозвана). Решение пишет
`actor_user_id` (реальный) и `acting_for_user_id`. **Запрет самосогласования**: если employee заявления связан с
actor_user_id или с acting_for_user_id → 403 `self_approval_forbidden`, при любых ролях.

Проверка редакции: все действия по заявлению принимают `expected_version`; несовпадение → 409 `stale_version`
(UI предлагает перезагрузить). Создание заявления, отправка/решение, изменение/отмена, ответ, факт, вложение, корректировка/её решение,
начисление, закрытие периода, импорт (commit) и экспорт принимают `Idempotency-Key`; таблица хранит также
`request_hash` (sha256 метода+пути+тела): повтор с тем же телом возвращает сохранённый ответ, второй резерв не
создаётся; повтор ключа с другим телом → 422 `idempotency_key_reused`. Права повторно проверяются при выдаче receipt;
receipt и результат пишутся одной транзакцией. Для multipart хешируются поля, имя и содержимое файла без boundary. Все проверки (права, статус, версия,
пересечения, остаток) повторяются внутри `BEGIN IMMEDIATE`; резервы, движения, решение, аудит и outbox пишутся
одной транзакцией.

Бумажное заявление: HR создаёт от имени сотрудника `source='paper'`, `paper_received_date`, `entered_by_user_id=HR`,
может приложить скан. Дальше маршрут тот же. HR не может согласовывать заявление, которое сам ввёл? — может (ввод ≠
решение), но не может согласовать своё собственное.

Срок предварительной подачи (`min_notice_days`) → предупреждение `late_notice`, не отказ.

Предупреждение о нескольких отсутствиях команды: при preview и в очереди руководителя — `team_overlap` со списком
(имя + даты, без типа чувствительного отпуска).

## 5. Изменение и отмена после одобрения (L08)

- `amend`: создаётся `leave_requests(kind='amendment', parent_request_id=approved)`, сразу `submitted`, своя редакция
  с новыми датами/типом. Дельта по счёту = новое распределение − текущее действующее распределение parent.
  Резерв создаётся только на положительную дельту. Маршрут — тот же из 3 шагов. Исходное решение продолжает действовать.
- При одобрении amendment в одной транзакции: по каждому счёту с отрицательной дельтой — запись `return`
  (+минуты, `reverses_entry_id` → исходная consumption этого счёта), с положительной — `consumption`;
  резервы закрываются; `parent.effective_revision_id = amendment.current_revision_id`; parent.version++.
- `cancel`: `kind='cancellation'`, указывается отменяемый диапазон (полностью или часть). Даты до «сегодня»
  отменить нельзя (`past_dates_need_hr_correction`). Новое распределение = действующее минус отменяемые дни; при
  одобрении возвращаются только они; если не осталось дней → parent `cancelled`.
- Одновременно не более одной открытой amendment/cancellation на parent (уникальный индекс → 409 `change_pending`).
- Отклонение/отзыв amendment — освобождает её резерв, parent не меняется.
- После окончания периода: HR `actual-period confirm` (фиксирует факт) или `actual-period adjust` → создаёт
  `adjustments(status='proposed')`, применяет другой пользователь с ролью `adjustment_approver` (L11, двое разных людей).

## 6. Права (L14, раздел 10) — проверяются на сервере в каждом обработчике

Функция `authz::can(ctx, Action, &Resource) -> Result<(), Forbidden>`; единый модуль, покрыт тестами.

| Кто | Видит | Может |
|---|---|---|
| Сотрудник | свои заявления, остатки, решения, свои вложения | черновик, отправка, отзыв, ответ, изменение/отмена своего |
| Руководитель (по назначению на сегодня) | заявления своей команды без медицинских вложений; чувствительный тип «Leave (details restricted)» | шаг manager_recommendation, командный календарь |
| Делегат | карточка и обычные вложения только заявления с доступным ему сейчас pending-шагом; чувствительные сведения скрыты | делегированный шаг; доступ заканчивается после его завершения, отзыва или окончания делегации |
| hr (scope) | сотрудники и заявления в scope, учёт | hr_check, бумажное заявление, переназначение, предложить корректировку, импорт, отчёты, выгрузка, подтверждение факта, настройки видов/графиков/праздников |
| hr_medical | + медицинские вложения в scope | — |
| final_approver | заявления в scope (без медицинских файлов, если нет hr_medical) | final_decision |
| adjustment_approver | очередь корректировок | применить/отклонить корректировку (не свою) |
| tech_admin | пользователи, роли, операции (без содержимого писем с персональными данными и без чужих файлов) | учётные записи, роль tech_admin другому пользователю, повтор уведомлений; свои отпуска как сотрудник |
| auditor | чтение в scope + журнал | ничего не меняет |

Автор бумажного ввода и загрузивший файл остаются в истории, но не дают права доступа. Деловые роли
(hr/hr_medical/final_approver/adjustment_approver/auditor) выдаёт/отзывает только HR всей службы другому
пользователю либо CLI-оператор. Для выдачи hr_medical требуется также hr_medical у выдающего. Привязка
учётной записи к сотруднику — HR в области обоих затронутых сотрудников; собственную привязку менять нельзя.
PUT пользователя требует expected_version; GET пользователей возвращает version и allowed.grant_roles/link_employee.
Делегацию создаёт/отзывает её отправитель либо HR всей службы; tech_admin не может назначить заместителя
чужого делового исполнителя. Если решение делегата завершило его доступ, ответ содержит только id/status/version.

Медицинские вложения (`sensitivity='medical'`) отдаются только владельцу-сотруднику и `hr_medical` в scope.
Скачивание: `GET /api/attachments/:id` с проверкой прав **в момент запроса** (никаких долгоживущих ссылок),
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Командный календарь
коллегам: имя + даты + «Away», без типа для sensitive. Письма: «Your leave request NLD-… has a new decision. Open:
<link>» — без типа и причин.

Перевод сотрудника: доступ руководителя определяется назначением **на сегодня**; старый руководитель теряет доступ к
новым заявлениям. Открытые шаги старых заявлений HR переназначает явно.

## 7. Вложения

Разрешены PDF/PNG/JPEG по сигнатуре; ≤ 2 МБ (demo 1 МБ), ≤ 5 файлов на заявление, в демо ≤ 20 загрузок на песочницу.
В demo встроенная проверка EICAR: совпадение → quarantined; Operations показывает «demo scanner».
В production сканер ClamAV clamd по TCP INSTREAM: NLD_CLAMD_ADDR=host:port,
NLD_CLAMD_TIMEOUT_MS (по умолчанию 10000, >0). Без адреса загрузка → 503 scanner_unavailable.
FOUND → quarantined; ошибка, разрыв соединения или таймаут → scan_failed с пояснением, видимым в карточке
при текущем праве доступа, и счётчиком в Operations. Скачать можно только clean. Проверка сигнатуры не
является полной валидацией PDF/изображения; антивирус не гарантирует безвредность активного содержимого.
Сеть сканера и запись файла выполняются до BEGIN IMMEDIATE; авторизация повторяется при записи строки.
Хранение: `data/files/<sandbox|main>/<uuid>` (имя без пользовательского ввода).

## 8. Уведомления (L13)

В той же транзакции, что и действие, — `INSERT notifications` с `dedupe_key` (`{event}:{request}:{revision}:{recipient}`).
Воркер (каждые 5 с) берёт `queued` с `next_attempt_at <= now`, «отправляет» (demo → `mailbox`; production → SMTP),
при ошибке `attempts++`, backoff 1, 5, 25 мин, после 5 попыток `gave_up`. Ручной повтор в Operations. Демонстрация
сбоя: адреса на домене `@unreachable.demo` всегда падают. Сбой письма никогда не откатывает действие.

## 9. Импорт / экспорт (L12)

CSV UTF-8 с заголовком. `preview` парсит, валидирует, сохраняет `import_batches(status='previewed')` и возвращает строки
с ошибками: неизвестный service_id, дубль в файле, неверная дата, отрицательное значение, конфликт с уже внесённым
opening для того же счёта. `commit` применяет только валидные строки (или всё/ничего — выбрано всё/ничего), опираясь на
`op_key` — повтор не дублирует. `historical_leave` требует `mode`: `already_in_opening` → записи `historical` с 0 минут
(история без списания), `post_movements` → `consumption`. В одной строке смешивать нельзя (колонка mode в файле
запрещена; режим один на файл).

Экспорт «transfer»: `employee_service_id, request_number, revision_no, leave_type_code, date, minutes, period_year,
decision_at` за период. Защита от формул: значение, начинающееся с `= + - @ \t \r`, префиксуется `'`. Сохраняется в
`export_batches`, отметка «transferred/accepted» — отдельным действием. Отчёт «изменения после выгрузки».

Полный экспорт для переноса на другой сервер = `nauru-leave backup` (БД + файлы, зашифровано).

## 10. Backup / restore

`nauru-leave backup --out FILE` → `VACUUM INTO` временный файл, затем копия `data/files/main/` → tar → шифрование
XChaCha20-Poly1305 ключом из `NLD_BACKUP_KEY_FILE` (32 байта, хранится отдельно). Согласованность без окна
обслуживания: файлы вложений неизменяемы и записываются на диск **до** коммита строки в БД, поэтому всё, на что
ссылается снимок, уже существует к моменту копирования; лишние (более новые) файлы безвредны и удаляются при restore,
если на них нет ссылок. `restore --in FILE --data-dir DIR` на чистой установке → те же данные и файлы.
Проверяется интеграционным тестом.

## 11. Аудит

Каждое значимое действие → `audit_events` (append-only триггеры). Ограничение честно описано в SECURITY.md:
администратор файла БД технически может его изменить.

## 12. Ошибки API

JSON `{ "error": { "code": "insufficient_balance", "message": "human readable", "details": {...} } }`.
Коды: `unauthenticated` 401, `forbidden` / `self_approval_forbidden` 403, `not_found` 404, `stale_version` /
`change_pending` / `overlap` 409, `validation` / `insufficient_balance` / `no_schedule` /
`past_dates_need_hr_correction` 422, `rate_limited` 429.

## 13. Сеансы и CSRF

Cookie `nld_session` (HttpOnly, Secure в production, SameSite=Lax, host-only, без Domain=). Мутирующие запросы
требуют заголовок `X-CSRF-Token` = `csrf_token` сессии **и** проверку `Origin`/`Referer` против `NLD_PUBLIC_URL`.
Ответы `/api/*` — `Cache-Control: no-store`. Заголовки безопасности: CSP `default-src 'self'`, `frame-ancestors 'none'`,
`Referrer-Policy: same-origin`. Демо-обходы (выбор персонажа, time travel, mailbox) регистрируются в роутере только
при `NLD_MODE=demo`.
