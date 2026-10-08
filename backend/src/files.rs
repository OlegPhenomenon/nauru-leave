//! Attachment storage: content-addressed files under `files_dir/<uuid>`,
//! magic-byte sniffing and the EICAR demo "antivirus" (DESIGN §7).

use std::path::{Path, PathBuf};

use crate::Res;

/// Signature bytes → allowed content type. PDF/PNG/JPEG only.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        Some("application/pdf")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        Some("image/jpeg")
    } else {
        None
    }
}

/// EICAR test string — a file containing it is quarantined.
pub const EICAR: &str =
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

pub fn looks_infected(bytes: &[u8]) -> bool {
    bytes
        .windows(EICAR.len())
        .any(|w| w == EICAR.as_bytes())
}

pub struct FileStore {
    pub dir: PathBuf,
}

impl FileStore {
    pub fn new(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    /// Write bytes under a random key; returns the storage key.
    /// Callers must store the file BEFORE committing the DB row (§10).
    pub fn put(&self, bytes: &[u8]) -> Res<String> {
        let key = uuid::Uuid::new_v4().to_string();
        use std::io::Write;
        let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(self.dir.join(&key))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)] std::fs::File::open(&self.dir)?.sync_all()?;
        Ok(key)
    }

    pub fn get(&self, key: &str) -> Res<Vec<u8>> {
        if uuid::Uuid::parse_str(key).is_err(){return Err(crate::DomainError::validation("invalid storage key"));}
        Ok(std::fs::read(self.dir.join(key))?)
    }

    pub fn path(&self, key: &str) -> PathBuf {
        self.dir.join(key)
    }

    pub fn remove(&self, key: &str) -> Res<()> {
        let p = self.dir.join(key);
        if p.exists() {
            std::fs::remove_file(p)?;
        }
        Ok(())
    }
}
