//! Attachment storage under random keys, format filtering, and external ClamAV
//! INSTREAM scanning (demo uses the built-in EICAR check; DESIGN §7).

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
pub const EICAR: &str = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

pub fn looks_infected(bytes: &[u8]) -> bool {
    bytes.windows(EICAR.len()).any(|w| w == EICAR.as_bytes())
}

pub struct FileStore {
    pub dir: PathBuf,
    scanner: Box<dyn Scanner>,
}

pub struct ScanResult {
    pub status: &'static str,
    pub note: Option<String>,
}
/// Only external antivirus integration is substituted in tests.
pub trait Scanner: Send + Sync {
    fn scan(&self, bytes: &[u8]) -> Res<ScanResult>;
}
pub struct DemoScanner;
impl Scanner for DemoScanner {
    fn scan(&self, bytes: &[u8]) -> Res<ScanResult> {
        Ok(ScanResult {
            status: if looks_infected(bytes) {
                "quarantined"
            } else {
                "clean"
            },
            note: None,
        })
    }
}
pub struct ClamdScanner {
    pub addr: Option<String>,
    pub timeout: std::time::Duration,
}
impl ClamdScanner {
    fn instream(&self, addr: &str, bytes: &[u8]) -> std::io::Result<bool> {
        use std::io::{Read, Write};
        use std::net::{TcpStream, ToSocketAddrs};
        use std::time::Instant;
        // Resolution is done once; the deadline covers connection and the complete stream.
        let endpoint = addr
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| std::io::Error::other("empty scanner address"))?;
        let deadline = Instant::now() + self.timeout;
        let mut stream = TcpStream::connect_timeout(&endpoint, self.timeout)?;
        let remaining = || {
            deadline
                .checked_duration_since(Instant::now())
                .filter(|d| !d.is_zero())
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::TimedOut, "scanner deadline exceeded")
                })
        };
        stream.set_write_timeout(Some(remaining()?))?;
        stream.write_all(b"zINSTREAM\0")?;
        for chunk in bytes.chunks(65536) {
            stream.set_write_timeout(Some(remaining()?))?;
            stream.write_all(&(chunk.len() as u32).to_be_bytes())?;
            stream.write_all(chunk)?;
        }
        stream.write_all(&0u32.to_be_bytes())?;
        let mut reply = Vec::new();
        loop {
            stream.set_read_timeout(Some(remaining()?))?;
            let mut byte = [0];
            stream.read_exact(&mut byte)?;
            if byte[0] == 0 {
                break;
            }
            if reply.len() >= 4096 {
                return Err(std::io::Error::other("scanner reply too long"));
            }
            reply.push(byte[0]);
        }
        let reply = std::str::from_utf8(&reply).map_err(std::io::Error::other)?;
        if reply == "stream: OK" {
            Ok(false)
        } else if reply.starts_with("stream: ") && reply.ends_with(" FOUND") {
            Ok(true)
        } else {
            Err(std::io::Error::other("scanner did not return a verdict"))
        }
    }
}
impl Scanner for ClamdScanner {
    fn scan(&self, bytes: &[u8]) -> Res<ScanResult> {
        let addr = self
            .addr
            .as_deref()
            .filter(|a| !a.is_empty())
            .ok_or(crate::DomainError::ScannerUnavailable)?;
        Ok(match self.instream(addr, bytes) {
            Ok(infected) => ScanResult {
                status: if infected { "quarantined" } else { "clean" },
                note: None,
            },
            Err(_) => ScanResult {
                status: "scan_failed",
                note: Some("Scanner failed or timed out; file is blocked".into()),
            },
        })
    }
}

impl FileStore {
    pub fn new(dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            scanner: Box::new(DemoScanner),
        })
    }

    pub fn with_scanner(
        dir: impl AsRef<Path>,
        scanner: impl Scanner + 'static,
    ) -> std::io::Result<Self> {
        let mut store = Self::new(dir)?;
        store.scanner = Box::new(scanner);
        Ok(store)
    }
    pub fn scan(&self, bytes: &[u8]) -> Res<ScanResult> {
        self.scanner.scan(bytes)
    }

    /// Write bytes under a random key; returns the storage key.
    /// Callers must store the file BEFORE committing the DB row (§10).
    pub fn put(&self, bytes: &[u8]) -> Res<String> {
        let key = uuid::Uuid::new_v4().to_string();
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.dir.join(&key))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        std::fs::File::open(&self.dir)?.sync_all()?;
        Ok(key)
    }

    pub fn get(&self, key: &str) -> Res<Vec<u8>> {
        if uuid::Uuid::parse_str(key).is_err() {
            return Err(crate::DomainError::validation("invalid storage key"));
        }
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
