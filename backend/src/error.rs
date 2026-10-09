use serde_json::json;
use thiserror::Error;

/// Domain error mapping 1:1 to API error codes (DESIGN §12).
#[derive(Debug, Error)]
pub enum DomainError {
    #[error("not authenticated")]
    Unauthenticated,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("a user may not decide their own request")]
    SelfApprovalForbidden,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("the record was modified; reload and retry")]
    StaleVersion,
    #[error("another change is already pending for this request")]
    ChangePending,
    #[error("overlaps an existing absence: {0}")]
    Overlap(String),
    #[error("{0}")]
    Validation(String),
    #[error("insufficient balance: {0}")]
    InsufficientBalance(String),
    #[error("no work schedule for employee {employee_id} on {date}")]
    NoSchedule { employee_id: i64, date: String },
    #[error("no policy in force for {0}")]
    NoPolicy(String),
    #[error("past dates need an HR correction, not a cancellation")]
    PastDatesNeedHrCorrection,
    #[error("rate limited")]
    RateLimited,
    #[error("idempotency key was reused with a different request body")]
    IdempotencyKeyReused,
    /// Import commit refused: any invalid row aborts the whole batch
    /// (all-or-nothing, DESIGN §9).
    #[error("{0}")]
    ImportInvalid(String),
    #[error("production uploads require a configured antivirus scanner")]
    ScannerUnavailable,
    #[error("demo is full, try later")]
    DemoFull,
    #[error("internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl DomainError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unauthenticated => "unauthenticated",
            Self::Forbidden(_) => "forbidden",
            Self::SelfApprovalForbidden => "self_approval_forbidden",
            Self::NotFound(_) => "not_found",
            Self::StaleVersion => "stale_version",
            Self::ChangePending => "change_pending",
            Self::Overlap(_) => "overlap",
            Self::Validation(_) => "validation",
            Self::InsufficientBalance(_) => "insufficient_balance",
            Self::NoSchedule { .. } => "no_schedule",
            Self::NoPolicy(_) => "no_policy",
            Self::PastDatesNeedHrCorrection => "past_dates_need_hr_correction",
            Self::RateLimited => "rate_limited",
            Self::IdempotencyKeyReused => "idempotency_key_reused",
            Self::ImportInvalid(_) => "import_invalid",
            Self::ScannerUnavailable => "scanner_unavailable",
            Self::DemoFull => "demo_full",
            Self::Internal(_) => "internal",
        }
    }

    pub fn http_status(&self) -> u16 {
        match self {
            Self::Unauthenticated => 401,
            Self::Forbidden(_) | Self::SelfApprovalForbidden => 403,
            Self::NotFound(_) => 404,
            Self::StaleVersion
            | Self::ChangePending
            | Self::Overlap(_)
            | Self::ImportInvalid(_) => 409,
            Self::Validation(_)
            | Self::InsufficientBalance(_)
            | Self::NoSchedule { .. }
            | Self::NoPolicy(_)
            | Self::PastDatesNeedHrCorrection
            | Self::IdempotencyKeyReused => 422,
            Self::RateLimited => 429,
            Self::DemoFull | Self::ScannerUnavailable => 503,
            Self::Internal(_) => 500,
        }
    }

    pub fn message(&self) -> String {
        self.to_string()
    }

    pub fn details(&self) -> serde_json::Value {
        match self {
            Self::Overlap(d) | Self::InsufficientBalance(d) => json!({ "detail": d }),
            Self::NoSchedule { employee_id, date } => {
                json!({ "employee_id": employee_id, "date": date })
            }
            _ => json!({}),
        }
    }

    pub fn validation(msg: impl Into<String>) -> Self {
        Self::Validation(msg.into())
    }

    pub fn forbidden(msg: impl Into<String>) -> Self {
        Self::Forbidden(msg.into())
    }

    pub fn not_found(what: impl Into<String>) -> Self {
        Self::NotFound(what.into())
    }
}

impl From<rusqlite::Error> for DomainError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Internal(anyhow::Error::new(e))
    }
}

impl From<std::io::Error> for DomainError {
    fn from(e: std::io::Error) -> Self {
        Self::Internal(anyhow::Error::new(e))
    }
}

impl From<time::error::Parse> for DomainError {
    fn from(e: time::error::Parse) -> Self {
        Self::Validation(format!("bad date: {e}"))
    }
}

impl From<serde_json::Error> for DomainError {
    fn from(e: serde_json::Error) -> Self {
        Self::Internal(anyhow::Error::new(e))
    }
}

impl From<csv::Error> for DomainError {
    fn from(e: csv::Error) -> Self {
        Self::Internal(anyhow::Error::new(e))
    }
}
