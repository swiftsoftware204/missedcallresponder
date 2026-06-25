use axum::{extract::State, Json};
use serde_json::json;

use crate::{
    db::Database,
    error::{AppError, Result},
};

pub async fn login(
    State(db): State<Database>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    Err(AppError::NotImplemented("Auth via Supabase".to_string()))
}

pub async fn signup(
    State(db): State<Database>,
    Json(req): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    Err(AppError::NotImplemented("Signup via Supabase".to_string()))
}
