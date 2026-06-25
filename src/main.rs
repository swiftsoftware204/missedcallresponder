use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use tower_http::{
    compression::CompressionLayer,
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod db;
mod error;
mod middleware as app_middleware;
mod models;
mod routes;

use crate::db::Database;
use crate::error::Result;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "missedcall_responder=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    dotenvy::dotenv().ok();

    let database = Database::new().await?;
    database.migrate().await?;

    let app = create_router(database);

    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "8082".to_string())
        .parse::<u16>()
        .expect("PORT must be a valid u16");

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("MissedCall Responder starting on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

fn create_router(database: Database) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
        .max_age(std::time::Duration::from_secs(86400));

    let api_routes = Router::new()
        .route("/health", get(routes::health::handler))
        .route("/auth/login", post(routes::auth::login))
        .route("/auth/signup", post(routes::auth::signup))
        .route("/webhooks/missed-call", post(routes::webhooks::missed_call))
        .route("/webhooks/sms-reply", post(routes::webhooks::sms_reply))
        .route("/dashboard/stats", get(routes::dashboard::stats))
        .route("/dashboard/calls", get(routes::dashboard::list_calls))
        .route("/affiliate/track", post(routes::affiliate::track_conversion))
        .route("/integrations/funnelswift", post(routes::integrations::funnelswift_webhook));

    let api_routes = api_routes
        .layer(middleware::from_fn(app_middleware::auth::auth_middleware))
        .layer(middleware::from_fn(app_middleware::security::security_headers));

    Router::new()
        .nest("/api", api_routes)
        .layer(cors)
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(database)
}
