//! `nauru-leave` CLI: migrate, seed-template, backup, restore, gen-backup-key.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "nauru-leave",
    version,
    about = "Nauru Leave Desk — domain core"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the HTTP server and background jobs (configuration: NLD_* environment).
    Serve,
    /// Initialize a production database without demo seed data.
    InitProduction {
        #[arg(long, env = "NLD_DATA_DIR", default_value = "data")]
        data_dir: PathBuf,
    },
    /// Trusted local operator account provisioning (requires OS access to the data directory).
    User {
        #[arg(long, env = "NLD_DATA_DIR", default_value = "data", global = true)]
        data_dir: PathBuf,
        #[command(subcommand)]
        command: UserCmd,
    },
    /// Process due notifications and expired sandboxes once.
    RunJobsOnce,
    /// Apply pending migrations to a database file.
    Migrate {
        /// SQLite database path.
        #[arg(long, default_value = "data/main.sqlite")]
        db: PathBuf,
    },
    /// Build the demo template database (and its files dir).
    SeedTemplate {
        /// Output path for the template database (e.g. data/template.sqlite).
        #[arg(long)]
        out: PathBuf,
        /// Attachment files directory (default: <out-dir>/files).
        #[arg(long)]
        files_dir: Option<PathBuf>,
    },
    /// Encrypted backup of the database + attachment files.
    Backup {
        #[arg(long)]
        db: Option<PathBuf>,
        #[arg(long)]
        files_dir: Option<PathBuf>,
        /// 32-byte key file (see gen-backup-key).
        #[arg(long, env = "NLD_BACKUP_KEY_FILE")]
        key_file: PathBuf,
        #[arg(long)]
        out: PathBuf,
    },
    /// Restore a backup into a data dir (main.sqlite + files/).
    Restore {
        #[arg(long = "in", alias = "input")]
        input: PathBuf,
        #[arg(long, env = "NLD_BACKUP_KEY_FILE")]
        key_file: PathBuf,
        #[arg(long, env = "NLD_DATA_DIR", default_value = "data")]
        data_dir: PathBuf,
    },
    /// Generate a new 32-byte backup key file.
    GenBackupKey {
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Subcommand)]
enum UserCmd {
    Create {
        #[arg(long)]
        email: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        employee_service_id: Option<String>,
        #[arg(long)]
        role: Vec<String>,
        #[arg(long)]
        password_stdin: bool,
    },
    ResetPassword {
        #[arg(long)]
        email: String,
        #[arg(long)]
        password_stdin: bool,
    },
    ResetTotp {
        #[arg(long)]
        email: String,
    },
    RevokeSessions {
        #[arg(long)]
        email: String,
    },
    List,
    GrantRole {
        #[arg(long)]
        email: String,
        #[arg(long)]
        role: String,
    },
    RevokeRole {
        #[arg(long)]
        email: String,
        #[arg(long)]
        role: String,
    },
}

fn read_password(from_stdin: bool) -> nauru_leave::Res<String> {
    use std::io::{BufRead, Write};
    fn line(reader: &mut impl BufRead) -> std::io::Result<String> {
        let mut password = String::new();
        reader.read_line(&mut password)?;
        Ok(password.trim_end_matches(['\r', '\n']).to_owned())
    }
    if from_stdin {
        return Ok(line(&mut std::io::stdin().lock())?);
    }
    let mut tty = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")?;
    let saved = std::process::Command::new("stty")
        .arg("-g")
        .stdin(tty.try_clone()?)
        .output()?;
    if !saved.status.success() {
        return Err(nauru_leave::DomainError::validation(
            "password entry requires a TTY; use --password-stdin",
        ));
    }
    struct Restore(std::fs::File, String);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Ok(input) = self.0.try_clone() {
                let _ = std::process::Command::new("stty")
                    .arg(self.1.trim())
                    .stdin(input)
                    .status();
            }
        }
    }
    let _restore = Restore(
        tty.try_clone()?,
        String::from_utf8_lossy(&saved.stdout).into_owned(),
    );
    let status = std::process::Command::new("stty")
        .arg("-echo")
        .stdin(tty.try_clone()?)
        .status()?;
    if !status.success() {
        return Err(nauru_leave::DomainError::validation(
            "cannot hide password input",
        ));
    }
    let mut reader = std::io::BufReader::new(tty.try_clone()?);
    write!(tty, "Password (minimum 12 characters): ")?;
    tty.flush()?;
    let first = line(&mut reader)?;
    write!(tty, "\nConfirm password: ")?;
    tty.flush()?;
    let second = line(&mut reader)?;
    writeln!(tty)?;
    if first != second {
        return Err(nauru_leave::DomainError::validation(
            "passwords do not match",
        ));
    }
    Ok(first)
}

fn print_enrollment(enrollment: nauru_leave::provisioning::Enrollment) {
    println!("TOTP secret: {}", enrollment.secret);
    println!("TOTP URI: {}", enrollment.uri);
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error[{}]: {}", e.code(), e.message());
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> nauru_leave::Res<()> {
    match cli.cmd {
        Cmd::InitProduction { data_dir } => {
            nauru_leave::provisioning::init_production(&data_dir)?;
            println!(
                "Production database ready: {}",
                data_dir.join("main.sqlite").display()
            );
        }
        Cmd::User { data_dir, command } => {
            use nauru_leave::provisioning as operator;
            let mut conn = operator::open_production(&data_dir)?;
            match command {
                UserCmd::Create {
                    email,
                    name,
                    employee_service_id,
                    role,
                    password_stdin,
                } => {
                    let password = read_password(password_stdin)?;
                    print_enrollment(operator::create_user(
                        &mut conn,
                        &email,
                        &name,
                        employee_service_id.as_deref(),
                        &role,
                        &password,
                    )?);
                }
                UserCmd::ResetPassword {
                    email,
                    password_stdin,
                } => operator::reset_password(&mut conn, &email, &read_password(password_stdin)?)?,
                UserCmd::ResetTotp { email } => {
                    print_enrollment(operator::reset_totp(&mut conn, &email)?)
                }
                UserCmd::RevokeSessions { email } => operator::revoke_sessions(&mut conn, &email)?,
                UserCmd::List => println!(
                    "{}",
                    serde_json::to_string_pretty(&operator::list_users(&conn)?)?
                ),
                UserCmd::GrantRole { email, role } => {
                    operator::change_role(&mut conn, &email, &role, true)?
                }
                UserCmd::RevokeRole { email, role } => {
                    operator::change_role(&mut conn, &email, &role, false)?
                }
            }
        }
        Cmd::Serve => {
            return nauru_leave::http::serve(nauru_leave::http::Config::from_env()?).await
        }
        Cmd::RunJobsOnce => {
            nauru_leave::http::AppState::new(nauru_leave::http::Config::from_env()?)
                .await?
                .jobs(true)
                .await?;
        }
        Cmd::Migrate { db } => {
            if let Some(dir) = db.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let conn = nauru_leave::db::open(&db)?;
            let n = nauru_leave::db::migrate(&conn)?;
            println!(
                "migrated {} (schema now at {})",
                n,
                nauru_leave::db::schema_version(&conn)?
            );
        }
        Cmd::SeedTemplate { out, files_dir } => {
            if let Some(dir) = out.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let files_dir = files_dir.unwrap_or_else(|| {
                out.parent()
                    .map(|p| p.join("files"))
                    .unwrap_or_else(|| PathBuf::from("files"))
            });
            nauru_leave::seed::build_template(&out, &files_dir)?;
            println!("seeded demo template: {}", out.display());
        }
        Cmd::Backup {
            db,
            files_dir,
            key_file,
            out,
        } => {
            let key = nauru_leave::backup::read_key(&key_file)?;
            let data = std::env::var_os("NLD_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("data"));
            nauru_leave::backup::backup(
                &db.unwrap_or_else(|| data.join("main.sqlite")),
                &files_dir.unwrap_or_else(|| data.join("files/main")),
                &key,
                &out,
            )?;
            println!("backup written: {}", out.display());
        }
        Cmd::Restore {
            input,
            key_file,
            data_dir,
        } => {
            let key = nauru_leave::backup::read_key(&key_file)?;
            nauru_leave::backup::restore_main(&input, &key, &data_dir)?;
            println!("restored into {}", data_dir.display());
        }
        Cmd::GenBackupKey { out } => {
            nauru_leave::backup::gen_key(&out)?;
            println!("backup key written: {}", out.display());
        }
    }
    Ok(())
}
