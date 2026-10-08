//! Nauru Leave Desk — domain core library.
//!
//! Everything mutating goes through `db::write_tx` (BEGIN IMMEDIATE),
//! checks `authz`, writes audit + outbox notifications in the same tx.

pub mod admin;
pub mod audit;
pub mod authz;
pub mod backup;
pub mod calendar;
pub mod clock;
pub mod db;
pub mod error;
pub mod files;
pub mod http;
pub mod imports_exports;
pub mod ledger;
pub mod model;
pub mod notify;
pub mod people;
pub mod presentation;
pub mod queries;
pub mod requests;
pub mod seed;
pub mod sessions;

pub use error::DomainError;

/// Convenience result alias used across the crate.
pub type Res<T> = Result<T, DomainError>;
