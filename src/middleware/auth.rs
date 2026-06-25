use axum::{
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};

pub async fn auth_middleware<B>(
    request: Request<B>,
    next: Next<B>,
) -> Result<Response, StatusCode> {
    let path = request.uri().path();
    let public_paths = [
        "/api/health",
        "/api/auth/login",
        "/api/auth/signup",
        "/api/webhooks/missed-call",
        "/api/webhooks/sms-reply",
    ];

    if public_paths.iter().any(|p| path.starts_with(p)) {
        return Ok(next.run(request).await);
    }

    let auth_header = request
        .headers()
        .get("Authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    match auth_header {
        Some(_token) => Ok(next.run(request).await),
        None => Err(StatusCode::UNAUTHORIZED),
    }
}
