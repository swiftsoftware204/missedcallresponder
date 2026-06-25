use axum::{
    http::{header, Request, StatusCode},
    middleware::Next,
    response::Response,
};

pub async fn security_headers<B>(
    request: Request<B>,
    next: Next<B>,
) -> Result<Response, StatusCode> {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::HeaderName::from_static("x-frame-options"),
        header::HeaderValue::from_static("DENY"),
    );
    headers.remove(header::SERVER);

    Ok(response)
}
