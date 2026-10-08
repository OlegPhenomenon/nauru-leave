# Проверка готовности

Каждый пункт → автоматический тест (имя теста в скобках, `cargo test` в `backend/`) и/или ручной сценарий в
`TEST_RESULTS.md` с реальным выводом. Невыполненный пункт помечается невыполненным.

## A. Обязательный показ (раздел 14 ТЗ)
- [ ] A1 Alexei: 20 → submit 9–13.11.2026 → 20/5/15 → Olga recommend → Maria checked → Elena approve → 15/0/15
      → amend до 9–11.11 → 15/0/15 → approve → 17/0/17 → time travel 12.11 → 17, «period ended» (`main_scenario`).
- [ ] A2 Полный журнал заявления: все решения с автором/временем/редакцией; выгрузка transfer CSV содержит номер и
      редакцию (`main_scenario_export`).
- [ ] A3 Второй пользователь (Tom) не видит заявление Alexei: 403 на GET, отсутствие в списках, поиске, отчётах,
      вложениях (`isolation_other_employee`).
- [ ] A4 backup → restore на чистый каталог → те же заявления, остатки и файлы (sha256) (`backup_restore_roundtrip`).

## B. Учёт (раздел 7)
- [ ] B1 Повторная отправка/решение с тем же Idempotency-Key не создаёт второй резерв/движение (`idempotent_submit`, `idempotent_decide`).
- [ ] B2 Параллельно два заявления на последние дни: одно проходит, второе `insufficient_balance` (`concurrent_last_days`).
- [ ] B3 Граница года: дни распределяются по счетам своих лет (`year_boundary_allocation`).
- [ ] B4 Недостаточный остаток блокируется (`insufficient_blocks`).
- [ ] B5 Половина дня = 240 из 480; нерабочий день и праздник внутри диапазона = 0 (`half_day_and_holidays`); part-time график 360 (`part_time_schedule`).
- [ ] B6 Отмена до решения освобождает резерв (`withdraw_releases`); частичная отмена после решения возвращает только отменённые дни (`partial_cancel`).
- [ ] B7 Повтор начисления/закрытия периода/импорта не дублирует (`accrual_idempotent`, `import_idempotent`).
- [ ] B8 Ledger и audit нельзя UPDATE/DELETE (`ledger_immutable`).
- [ ] B9 Amendment с переносом дней между годами резервирует положительную дельту по счёту (`amendment_per_account_delta`).

## C. Маршрут и права
- [ ] C1 Самосогласование запрещено при любых ролях и при делегации (`no_self_approval`).
- [ ] C2 Делегация действует только в свои даты, решение хранит реального автора и acting_for (`delegation_window`).
- [ ] C3 Изменение дат при needs_information → новая редакция, шаги superseded, резерв пересчитан (`revise_restarts_route`).
- [ ] C4 stale `expected_version` → 409 (`stale_version`).
- [ ] C5 Нет руководителя → шаг unassigned в проблемах HR, не пропускается (`unassigned_step_visible`).
- [ ] C6 Перевод: старый руководитель не видит новые заявления (`transfer_access`).
- [ ] C7 Медицинский файл: Nia и Maria скачивают; Olga, Elena, Pavel — 403; в календаре коллег «Away» (`medical_access`).
- [ ] C8 tech_admin не меняет остатки и не видит файлы (`tech_admin_limits`).
- [ ] C9 Корректировка: proposer ≠ approver (`adjustment_two_person`).
- [ ] C10 Пересекающиеся отсутствия одного сотрудника блокируются; am+pm в один день разрешены (`overlap_rules`).

## D. Импорт, отчёты, уведомления, файлы
- [ ] D1 Preview CSV показывает неизвестные ID, дубли, неверные даты, отрицательные значения, конфликт opening (`import_preview_errors`).
- [ ] D2 CSV-экспорт экранирует `= + - @` (`csv_formula_safe`).
- [ ] D3 Сбой отправки письма не откатывает действие; retry/backoff/ручной повтор (`notification_retry`).
- [ ] D4 Загрузка: неверная сигнатура отклоняется, EICAR → quarantined и не скачивается (`upload_checks`).
- [ ] D5 Письмо не содержит типа отпуска и причин (`email_minimal`).

## E. Демо и эксплуатация
- [ ] E1 Две песочницы не видят изменений друг друга (`sandbox_isolation`).
- [ ] E2 Демо-эндпоинты отсутствуют в production (`production_has_no_demo_routes`).
- [ ] E3 Docker-образ собирается, `docker compose up` отдаёт UI; размер образа и RSS при простое записаны в TEST_RESULTS.
- [ ] E4 CSRF: мутация без токена → 403 (`csrf_required`).
