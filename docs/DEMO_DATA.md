# Демо-данные (все вымышленные)

Шаблон песочницы строится командой `nauru-leave seed-template --out data/template.sqlite`. Сид **обязан** создавать
заявления через доменные функции (submit/decide/amend/cancel) с подменой бизнес-даты `Clock`, а не вставлять строки
напрямую — тогда книга движений, резервы, аудит и уведомления согласованы по построению. В конце `demo_today =
2026-10-08`. Пароли в демо не используются (вход выбором персонажа); в production сид не запускается.

Все политики `status='demo_fictional'`, пояснение: "Fictional demo rule — not Nauru law. Must be confirmed by the
responsible HR officer before real use."

## Подразделения
| code | name |
|---|---|
| CHR | Central HR Office (demo) |
| IU | Infrastructure Unit (demo) |
| CSU | Community Services Unit (demo) |

## Графики
- `Standard Mon–Fri 8h` — 480 × пн–пт, с 2025-01-01.
- `Part-time Mon–Thu 6h` — 360 × пн–чт, с 2025-01-01.

Календарь (демо, требует подтверждения): 2025-12-25, 2025-12-26, 2026-01-01, 2026-01-31 (Independence Day),
2026-05-17 (Constitution Day), 2026-10-26 (Angam Day), 2026-12-25, 2026-12-28 (Christmas substitute, fictional),
2027-01-01. На неделе 9–13.11.2026 праздников нет.

## Виды отпусков
| code | name | sensitive | uses_balance | half-day | attachment | notice | политика |
|---|---|---|---|---|---|---|---|
| ANNUAL | Annual leave | 0 | 1 | 1 | 0 | 5 дней (warning) | annual_upfront 9600 мин/год, advance_publish 3 мес., перенос да, без сгорания |
| SICK | Sick leave | 1 | 1 | 1 | 0 | 0 | annual_upfront 4800 мин/год, перенос нет |
| FAMILY | Family responsibility leave | 0 | 1 | 1 | 0 | 0 | annual_upfront 2400 мин/год, перенос нет |
| UNPAID | Unpaid leave | 0 | 0 | 0 | 0 | 10 | none |

## Люди (user = есть вход; имена вымышленные)
| service_id | Имя | Подразделение | Руководитель | График | Роли / история |
|---|---|---|---|---|---|
| NPS-1001 | Alexei Novak | IU | Olga Berg | Standard | Employee. Главный сценарий. Opening 2026 ANNUAL = 20 дней, без заявлений. |
| NPS-1002 | Olga Berg | IU | Elena Ward | Standard | Manager IU. Её FAMILY-заявление в `needs_information` (вопрос Maria: "Please confirm whether the school event date is fixed."). Делегация manager_recommendation → Tom Reed на 2026-12-14…2026-12-31 (будущая). |
| NPS-1003 | Tom Reed | IU | Olga Berg | Standard | Approved ANNUAL 2025-12-29…2026-01-07 (граница года: 2025-дни → счёт 2025, 2026-дни → счёт 2026; факт подтверждён Maria). Withdrawn заявление 2026-09-14. |
| NPS-1004 | Lina Cole | IU | Olga Berg | Part-time | `submitted` ANNUAL 2026-11-10…2026-11-12 (ждёт Olga) → предупреждение team_overlap для заявления Alexei. |
| NPS-1005 | Sam Oduya | IU | Olga Berg | Standard | **Без входа**, email sam.oduya@unreachable.demo (уведомление падает → видно в Operations). Бумажное заявление, введено Maria, получено 2026-10-05, ANNUAL 2026-10-20…2026-10-21, `under_review` (Olga рекомендовала, ждёт HR). Предложенная Maria корректировка +480 мин ("Paper record correction", basis "HR file NPS-1005/2026-114"), ждёт David. |
| NPS-2001 | Rita Moss | CSU | Elena Ward | Standard | Manager CSU. Approved ANNUAL 2026-10-16 am (полдня). Истёкшая делегация → Ben Carter 2026-09-01…2026-09-15. |
| NPS-2002 | Ben Carter | CSU | Rita Moss | Standard | Rejected ANNUAL 2026-10-26…2026-10-30 (Elena: "Community programme week — please choose other dates"). Approved, затем полностью отменённый ANNUAL 2026-09-21…2026-09-22 (cancelled). |
| NPS-2003 | Nia Fox | CSU | Rita Moss | Standard | Approved SICK 2026-10-01…2026-10-02 с медицинским вложением `medical-certificate-demo.pdf` (искусственное содержимое "DEMO MEDICAL CERTIFICATE — ARTIFICIAL CONTENT"). |
| NPS-0001 | Maria Santos | CHR | Elena Ward | Standard | hr (scope all) + hr_medical. |
| NPS-0002 | Elena Ward | CHR | — | Standard | final_approver (scope all). |
| NPS-0003 | David Hale | CHR | Elena Ward | Standard | hr (scope all) + adjustment_approver. |
| NPS-0004 | Pavel Grant | CHR | Elena Ward | Standard | tech_admin. Не видит медицинские файлы, не меняет остатки. |
| NPS-0005 | Grace Lin | CHR | Elena Ward | Standard | auditor (scope all). |

Opening balances: ANNUAL 2026 = 9600 для всех (effective 2026-01-01), Tom дополнительно ANNUAL 2025 = 9600
(effective 2025-01-01); SICK 2026 = 4800 и FAMILY 2026 = 2400 для всех. Начисление 2027 **не** проведено — HR может
провести его в демо (Balances → Run accrual 2027), чтобы показать разбиение заявления на границе 2026/2027.

## Персонажи на экране входа
Порядок и подписи: Alexei (Employee — start here), Olga (Manager), Maria (HR officer), Elena (Final approver),
David (HR · second approver for adjustments), Pavel (Technical admin), Grace (Auditor), Nia (Employee with a
medical file), Tom (Employee, acting manager in December). У каждого одна строка "story" о том, что попробовать.
