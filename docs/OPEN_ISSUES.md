# Открытые вопросы

## Версии ресурсов вне заявлений

AGENTS.md требует `expected_version` для каждой мутации, однако авторитетная схема и HTTP-контракт определяют
версии только для заявлений; формы настроек, directory, imports/exports, adjustments и sessions не передают
версию; comment/upload также не передают expected_version по API. Для этих операций сохранён существующий
контракт: серверная авторизация, BEGIN IMMEDIATE, аудит и outbox
атомарны, но отдельного optimistic version check нет. Расширение требует миграции схемы и изменения frontend.

## Размер предписанного Docker-образа

DESIGN §0 ставит цель ≤ 40 МБ. Предписанный задачей runtime `debian:bookworm-slim` с ca-certificates и curl для
healthcheck превышает эту цель. Сохранён требуемый Debian runtime, uid 10001 и рабочий healthcheck; фактический
размер записан в TEST_RESULTS.md. Уменьшение требует согласовать другой runtime/base либо изменить бюджет.

## Границы проверки внешних систем и доменного ядра

SMTP реализован через lettre/rustls, проверен локальным SMTP-сервером с реальной передачей письма вне write
transaction. Доставка через конкретного внешнего SMTP-провайдера и его TLS/credentials не проверялась: реальные
учётные данные не предоставлены. Демонстрационные email/antivirus используют mailbox и EICAR по DESIGN.
