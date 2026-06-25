use axum::{extract::State, Json};
use serde_json::Value;

use crate::{
    db::Database,
    error::Result,
};

pub async fn funnelswift_webhook(
    State(db): State<Database>,
    Json(payload): Json<Value>,
) -> Result<Json<Value>> {
    tracing::info!("FunnelSwift webhook received");
    Ok(Json(serde_json::json!({"status": "received"})))
}
