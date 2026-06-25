use axum::{extract::State, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    db::Database,
    error::Result,
};

#[derive(Debug, Deserialize)]
pub struct TrackConversionRequest {
    pub affiliate_id: String,
    pub phone_number: String,
}

pub async fn track_conversion(
    State(db): State<Database>,
    Json(req): Json<TrackConversionRequest>,
) -> Result<Json<Value>> {
    tracing::info!("Affiliate conversion: {} for {}", req.affiliate_id, req.phone_number);
    Ok(Json(json!({"status": "conversion_tracked"})))
}
