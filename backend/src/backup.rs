//! Encrypted backup/restore (DESIGN §10).
//!
//! `backup`: VACUUM INTO a scratch file → tar { db.sqlite, files/* } →
//! XChaCha20-Poly1305 (24-byte random nonce prepended) → `out`.
//! The key is 32 raw bytes kept in a separate key file.
//! `restore` reverses it into `target_dir/main.sqlite` + `target_dir/files/`.

use std::io::Cursor;
use std::path::Path;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use crate::error::DomainError;
use crate::Res;

/// Generate a fresh 32-byte key file.
pub fn gen_key(out: &Path) -> Res<()> {
    let key: [u8; 32] = rand::random();
    std::fs::write(out, key)?;
    Ok(())
}

pub fn read_key(path: &Path) -> Res<[u8; 32]> {
    let raw = std::fs::read(path)?;
    <[u8; 32]>::try_from(raw.as_slice()).map_err(|_| {
        DomainError::validation(format!(
            "backup key file {} must be exactly 32 bytes",
            path.display()
        ))
    })
}

fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Res<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce_bytes: [u8; 24] = rand::random();
    let nonce: &XNonce = (&nonce_bytes).into();
    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| DomainError::Internal(anyhow::anyhow!("encrypt: {e}")))?;
    let mut out = Vec::with_capacity(24 + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn decrypt(key: &[u8; 32], blob: &[u8]) -> Res<Vec<u8>> {
    if blob.len() < 24 {
        return Err(DomainError::validation("backup file too short"));
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce: &XNonce = blob[..24].try_into().map_err(|_| DomainError::validation("bad nonce"))?;
    cipher
        .decrypt(nonce, &blob[24..])
        .map_err(|_| DomainError::validation("backup decryption failed (bad key or file)"))
}

/// Consistent encrypted snapshot of `db_path` + `files_dir` written to `out`.
/// Attachment files are written to disk before their DB rows commit, so a
/// VACUUM snapshot can only ever reference files that already exist (§10).
pub fn backup(db_path: &Path, files_dir: &Path, key: &[u8; 32], out: &Path) -> Res<()> {
    let scratch = out.with_extension("vacuum-tmp");
    let _ = std::fs::remove_file(&scratch);
    let result = (|| -> Res<()> {
        {
            let conn = crate::db::open(db_path)?;
            conn.execute(
                "VACUUM INTO ?1",
                [scratch.to_string_lossy().to_string()],
            )?;
        }
        // tar in memory: demo datasets are small; keeps the format trivial
        let mut tar_buf: Vec<u8> = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_buf);
            builder.append_path_with_name(&scratch, "db.sqlite")?;
            if files_dir.is_dir() {
                builder.append_dir_all("files", files_dir)?;
            }
            builder.finish()?;
        }
        let blob = encrypt(key, &tar_buf)?;
        std::fs::write(out, blob)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&scratch);
    result
}

/// Restore a backup into `target_dir`: produces `target_dir/main.sqlite` and
/// `target_dir/files/<key>` entries. `target_dir` must not contain an
/// existing `main.sqlite`.
pub fn restore(archive: &Path, key: &[u8; 32], target_dir: &Path) -> Res<()> {
    let blob = std::fs::read(archive)?;
    let tar_buf = decrypt(key, &blob)?;
    std::fs::create_dir_all(target_dir)?;
    if target_dir.join("main.sqlite").exists() {
        return Err(DomainError::validation(format!(
            "{} already contains main.sqlite — restore needs a clean directory",
            target_dir.display()
        )));
    }
    let mut ar = tar::Archive::new(Cursor::new(tar_buf));
    ar.unpack(target_dir)?;
    let db = target_dir.join("db.sqlite");
    if db.exists() {
        std::fs::rename(&db, target_dir.join("main.sqlite"))?;
    }
    Ok(())
}
