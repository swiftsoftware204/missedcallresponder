use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CallStatus {
    Missed,
    Replied,
    Converted,
    Expired,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Call {
    pub id: Uuid,
    pub from_number: String,
    pub to_number: String,
    pub call_sid: String,
    pub status: CallStatus,
    pub sms_reply: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
