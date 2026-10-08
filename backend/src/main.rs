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
