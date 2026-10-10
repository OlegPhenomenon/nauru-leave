# Открытые вопросы

## Версии ресурсов вне заявлений

Версии и `expected_version` реализованы для редактируемых карточек типов, подразделений, сотрудников,
пользователей и графиков. Imports/exports, adjustments, sessions и comment/upload не имеют отдельной
версии ресурса по контракту; авторизация, BEGIN IMMEDIATE, аудит и outbox остаются атомарными.

## Границы проверки внешних систем и доменного ядра

SMTP реализован через lettre/rustls, проверен локальным SMTP-сервером с реальной передачей письма вне write
transaction. Доставка через конкретного внешнего SMTP-провайдера и его TLS/credentials не проверялась: реальные
учётные данные не предоставлены. Демонстрационные email/antivirus используют mailbox и EICAR по DESIGN.

## Данные до появления снимков

Старые резервы не сохраняли бизнес-даты, редакции — исторические признаки политики, а выгрузки — полную область
сотрудников. Миграция сохраняет минуты и CSV, восстанавливает даты из timestamps, условия из прежних настроек,
область из строк файла и сохранившихся датированных HR-прав. Если демо-часы отличались от timestamps, условия
были перезаписаны или старые права удалены, точное прежнее состояние восстановить из БД невозможно; такие
исторические сведения требуют проверки HR по исходным документам. Новые записи сохраняют эти данные явно.

## Frontend review limitations

- Admin A2: the import API only accepts its existing CSV headers, leave-type/unit codes, and whole minutes. The dialog uploads the chosen CSV unchanged; its template keeps those headers and the adjacent help explains each value. Direct days entry requires a backend contract or a separate CSV-building form.
- Admin A5: an authoritative per-person year-close preview and the last unclosed year are unavailable in the API. The dialog defaults to the last finished year and explains carry-over rules; the commit response reports whether any balance entries were posted. Zero entries can also mean a first close with no deductions, so it cannot truthfully be labelled “already closed”.
- Admin A11: notification responses mask HR recipient addresses and remove recipient identity and request links. The frontend cannot identify the affected person without guessing; the API must return an authorized display name or recipient reference.
- Staff U22 / Admin B8: event timestamps intentionally use the real clock in Pacific/Nauru while the demo business date controls leave rules. This behavior follows the product decision; changing timestamps would conceal the audit time.
- Admin B4: sick-leave masking in the calendar, absence CSV and payroll files is intentional privacy and remains in place.
