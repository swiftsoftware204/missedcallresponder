use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    db::Database,
    error::Result,
};

#[derive(Debug, Deserialize)]
pub struct MissedCallWebhook {
    pub from_number: String,
    pub to_number: String,
    pub call_sid: String,
}

#[derive(Debug, Deserialize)]
pub struct SmsReplyWebhook {
    pub from_number: String,
    pub message_body: String,
}

pub async fn missed_call(
    State(db): State<Database>,
    Json(payload): Json<MissedCallWebhook>,
) -> Result<Json<Value>> {
    tracing::info!("Missed call from: {}", payload.from_number);
    Ok(Json(json!({"status": "received", "action": "sms_queued"})))
}

pub async fn sms_reply(
    State(db): State<Database>,
    Json(payload): Json<SmsReplyWebhook>,
) -> Result<Json<Value>> {
    tracing::info!("SMS reply from: {}", payload.from_number);
    Ok(Json(json!({"status": "processed"})))
}
