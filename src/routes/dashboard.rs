use axum::{extract::{Query, State}, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::AuthUser,
    db::Database,
    error::Result,
};

#[derive(Debug, Deserialize)]
pub struct ListCallsQuery {
    pub page: Option<i32>,
    pub per_page: Option<i32>,
}

pub async fn stats(
    State(db): State<Database>,
    user: AuthUser,
) -> Result<Json<Value>> {
    Ok(Json(json!({
        "total_calls": 0,
        "missed": 0,
        "replied": 0,
        "converted": 0
    })))
}

pub async fn list_calls(
    State(db): State<Database>,
    user: AuthUser,
    Query(query): Query<ListCallsQuery>,
) -> Result<Json<Value>> {
    Ok(Json(json!({"calls": [], "page": 1, "per_page": 20})))
}
