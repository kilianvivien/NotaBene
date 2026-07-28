//! The process-wide rustls crypto provider.
//!
//! `reqwest` is compiled with `rustls-no-provider`, which leaves the choice of
//! backend to the application — and `Client::builder().build()` *panics* if
//! nothing installed one. That is a trap for any caller that happens to run
//! before the AI transport has made its first request, so the install happens
//! once at startup and every HTTPS caller re-asserts it cheaply.

/// Install the ring backend unless something already installed one. The updater
/// plugin installs one lazily too; whichever runs first wins and the rest are
/// no-ops.
pub fn ensure_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provider_is_available_after_install() {
        ensure_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
