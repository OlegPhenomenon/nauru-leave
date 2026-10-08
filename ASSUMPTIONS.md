# Assumptions

Nauru Leave Desk is an **independent prototype**. It has not been commissioned, reviewed or adopted by the
Government of Nauru. Everything below is a working assumption chosen so the demonstration runs end-to-end; each item
must be confirmed or replaced by the responsible people before any real use.

## Rules and numbers
| Topic | What the demo assumes | Who must confirm |
|---|---|---|
| Leave entitlements | Annual 20 days/year, Sick 10 days/year, Family 5 days/year, Unpaid without balance. **Fictional numbers**, labelled "Fictional demo rule" in the app. | Chief Secretary – HR / Public Service Commission |
| Approval route | Manager recommendation → HR check → final decision by a person holding delegated authority. A manager's recommendation is never the final decision. | Chief Secretary / delegation instruments |
| Final authority | One demo user ("Elena") holds the final-decision role. This does not describe any real delegation. | Chief Secretary |
| Working time | Standard Mon–Fri 8 h (480 min); one part-time Mon–Thu 6 h schedule to show that schedules differ. | HR |
| Public holidays | A demo calendar including New Year, Independence Day, Constitution Day, Angam Day and Christmas dates. Must be replaced by the official gazetted calendar. | HR |
| Next-year entitlement | Not credited in advance; HR may run the next-year accrual from 1 October (fictional rule) to demonstrate year-boundary requests. | HR |
| Carry-over | Unused annual leave carries over without automatic expiry (demo rule). No automatic forfeiture is ever applied without a confirmed rule. | HR |
| Negative balances | Blocked. A policy flag can allow them only with an authorised reason. | HR |
| Notice period | Late notice produces a warning only; the system never invents an automatic legal refusal. | HR |
| Half days | Morning or afternoon halves. Hour-level partial days are not modelled. | HR |

## Integrations (simulated in the demo)
- **Email**: messages go to an in-app demo mailbox; addresses on `@unreachable.demo` always fail to show retry
  handling. Production mode uses SMTP configured by the installation owner.
- **Antivirus**: a built-in check quarantines files containing the EICAR test string. Production installations
  should connect a real scanner; until then uploads are checked by type and size only.
- **Second factor**: TOTP (authenticator app). In the demo, persona login skips passwords and codes.
- **Finance/HR systems**: the export is a generic CSV (employee ID, period, type, dates, minutes, request number,
  revision). It is **not** a TechnologyOne import format. Producing a CSV does not mean payroll processed it.

## Legal standing
- A printed decision card is a record from this application, not a government electronic signature.
- The audit log is protected against change by ordinary users; a database administrator technically can alter it.
- Historical rules (e.g. the 2017 amendment) are not encoded as current law.

## Hosting
- The public demo gives every visitor a private, temporary copy of the demo data (deleted after 24 h of inactivity).
  Visitors must not upload real personnel documents.
