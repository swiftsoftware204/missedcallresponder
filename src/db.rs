use sqlx::{postgres::PgPoolOptions, Pool, Postgres};
use std::time::Duration;

use crate::error::Result;

#[derive(Clone)]
pub struct Database {
    pool: Pool<Postgres>,
}

impl Database {
    pub async fn new() -> Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL must be set");

        let pool = PgPoolOptions::new()
            .max_connections(20)
            .min_connections(5)
            .acquire_timeout(Duration::from_secs(30))
            .connect(&database_url)
            .await?;

        tracing::info!("Database connection pool established");

        Ok(Self { pool })
    }

    pub fn pool(&self) -> &Pool<Postgres> {
        &self.pool
    }

    pub async fn migrate(&self) -> Result<()> {
        tracing::info!("Running database migrations...");
        Ok(())
    }
}

impl axum::extract::FromRef<Database> for Database {
    fn from_ref(state: &Database) -> Self {
        state.clone()
    }
}
