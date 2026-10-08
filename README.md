## Production installation

Build the pinned backend with `cd backend && cargo build --locked --release`, or use the supplied deployment image. Run provisioning commands as the trusted OS operator who owns the application's data directory. These commands operate locally; account secrets have no public HTTP endpoint.

```sh
export NLD_MODE=production
export NLD_DATA_DIR=/var/lib/nauru-leave
export NLD_PUBLIC_URL=https://leave.example.org
export NLD_SMTP_URL=smtps://username:password@smtp.example.org:465

nauru-leave init-production --data-dir "$NLD_DATA_DIR"
nauru-leave user create --email admin@example.org --name "Technical administrator" --role tech_admin
nauru-leave user create --email hr@example.org --name "HR officer" --role hr --role hr_medical
nauru-leave user create --email approver@example.org --name "Final approver" --role final_approver
nauru-leave serve
```

`init-production` applies migrations to `main.sqlite` without loading demo data and can be repeated. It refuses demo mode, demo artifacts in the target directory, and a database marked as demo. Use a separate directory for production. Serve behind HTTPS at `NLD_PUBLIC_URL`; production session cookies require HTTPS. Configure SMTP before running the server.

Password creation and reset prompt twice on the controlling TTY with input hidden and require at least 12 characters. For automation, `--password-stdin` reads one password line from standard input; use your secret manager's output as the input. Passwords are stored as Argon2id hashes. Creation and TOTP reset print a new base32 secret and an `otpauth://` URI once. Enroll that URI in an authenticator before logging in. Privileged accounts and managers must complete the password and TOTP steps.

Create the real directory, schedules, leave types, and confirmed policies through the application before importing employees and opening balances. `--employee-service-id ID` links a new account to an existing, unlinked employee. Repeat `--role` to assign several roles. A bare role covers the service; `--role hr:IU` limits it to an existing org unit code. Supported roles are `hr`, `hr_medical`, `final_approver`, `adjustment_approver`, `tech_admin`, and `auditor`.

```sh
nauru-leave user list
nauru-leave user create --email employee@example.org --name "Employee" --employee-service-id NPS-1001
nauru-leave user grant-role --email hr@example.org --role hr:IU
nauru-leave user revoke-role --email hr@example.org --role hr
nauru-leave user reset-password --email employee@example.org
nauru-leave user reset-totp --email employee@example.org
nauru-leave user revoke-sessions --email employee@example.org
```

`user list` shows account metadata and role scopes without password hashes or TOTP secrets. Password/TOTP resets and role changes revoke existing sessions; resets also clear login lockout. Operator mutations write an audit event identifying the actor as `cli` and queue a notification atomically. Existing employees, org units, and balances are preserved.

Use `nauru-leave gen-backup-key --out /secure/nauru-backup.key`, set `NLD_BACKUP_KEY_FILE` to that file, and keep the key separately from encrypted backups. Back up the initialized database and attachments using `nauru-leave backup --out snapshot.enc`; restore into a clean directory with `nauru-leave restore --in snapshot.enc --data-dir DIR`.
