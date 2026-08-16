//! Fetching a web page, on the student's explicit say-so.
//!
//! This is the first time NotaBene reaches a host nobody configured. Everything
//! else that leaves the machine goes to an AI provider the user typed in
//! themselves; here the address arrives from a pasted link, so the guards are
//! stricter than `ai.rs` needs and the reasons are written down.
//!
//! The fetch lives in Rust for the same reason provider traffic does: the
//! webview's `connect-src` names exactly three hosts, and a feature that could
//! reach any URL would have to dismantle that.

use std::net::IpAddr;
use std::time::Duration;

use serde::Serialize;

/// Long enough for a slow news site, short enough that a hung server does not
/// look like a hung app.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Articles are text. Anything larger is not what the reader view is for, and
/// an unbounded read is how a single link exhausts memory.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Enough for the usual http→https→www shuffle, few enough to stop a loop.
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    /// Where the response actually came from, after redirects. Relative links
    /// in the article resolve against this rather than what was typed.
    pub final_url: String,
    pub content_type: String,
    pub html: String,
}

/// Is this address one the student could not have meant?
///
/// A pasted link should reach the public web. `http://localhost:22600` reaches
/// NotaBene's own MCP server; `http://169.254.169.254` reaches a cloud metadata
/// service; `http://192.168.1.1` reaches the router. None of those is a page
/// anyone wants to read, and all of them are what an attacker asks for when the
/// app is the one making the request.
fn is_forbidden(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                // 100.64.0.0/10, carrier-grade NAT.
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // Unique local, fc00::/7.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // Link-local, fe80::/10.
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // An IPv4 address wearing an IPv6 hat still goes where it goes.
                || v6.to_ipv4_mapped().map(|v4| is_forbidden(&IpAddr::V4(v4))) == Some(true)
        }
    }
}

/// Refuse a URL before any connection is opened.
///
/// Resolution happens here rather than being left to reqwest so the answer can
/// be inspected. This is not airtight — a name that resolves twice can answer
/// differently the second time — but closing that properly means owning the
/// socket, and the gap left is much smaller than the one it replaces.
async fn check_destination(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("refused_scheme:{}", url.scheme()));
    }
    let host = url.host_str().ok_or_else(|| "invalid_url:no host".to_string())?;
    // `host_str` keeps the brackets on an IPv6 literal, and `[::1]` does not
    // parse as an address — which quietly sent loopback down the DNS path and
    // straight through the check this function exists to perform.
    let literal = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host);

    if let Ok(address) = literal.parse::<IpAddr>() {
        return if is_forbidden(&address) {
            Err("refused_host:that address is not on the public web".into())
        } else {
            Ok(())
        };
    }

    let port = url.port_or_known_default().unwrap_or(80);
    let resolved = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| format!("dns_failed:{error}"))?;
    let mut any = false;
    for candidate in resolved {
        any = true;
        if is_forbidden(&candidate.ip()) {
            return Err("refused_host:that address is not on the public web".into());
        }
    }
    if !any {
        return Err("dns_failed:the host did not resolve".into());
    }
    Ok(())
}

/// Follow redirects by hand, so every hop is checked rather than only the first.
///
/// reqwest's own redirect policy would happily follow a public URL to
/// `127.0.0.1`, which is exactly the trick the guard above exists to stop.
pub async fn fetch_page(url: &str) -> Result<FetchedPage, String> {
    crate::tls::ensure_provider();

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        // A real user agent: several large sites serve an error page to a
        // client that does not name itself, and a blank reader view reads as a
        // NotaBene bug rather than as the site's choice.
        .user_agent(concat!("NotaBene/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;

    let mut current = reqwest::Url::parse(url).map_err(|error| format!("invalid_url:{error}"))?;

    for _ in 0..=MAX_REDIRECTS {
        check_destination(&current).await?;

        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(|error| format!("fetch_failed:{error}"))?;

        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "fetch_failed:redirect without a location".to_string())?;
            current = current
                .join(location)
                .map_err(|error| format!("invalid_url:{error}"))?;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("http_error:{}", response.status().as_u16()));
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned();
        if !content_type.is_empty() && !content_type.contains("html") {
            return Err(format!("not_html:{content_type}"));
        }

        let final_url = response.url().to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("fetch_failed:{error}"))?;
        if bytes.len() > MAX_BYTES {
            return Err("too_large:that page is larger than NotaBene will read".into());
        }

        return Ok(FetchedPage {
            final_url,
            content_type,
            // Lossy on purpose: a mislabelled charset should cost a few
            // characters rather than the whole article.
            html: String::from_utf8_lossy(&bytes).into_owned(),
        });
    }

    Err("too_many_redirects:that link redirected too many times".into())
}

#[tauri::command]
pub async fn web_fetch_page(url: String) -> Result<FetchedPage, String> {
    fetch_page(&url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(url: &str) -> String {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build runtime")
            .block_on(async {
                let parsed = reqwest::Url::parse(url).expect("failed to parse url");
                check_destination(&parsed)
                    .await
                    .expect_err("this destination should have been refused")
            })
    }

    #[test]
    fn refuses_anything_that_is_not_http() {
        assert!(refused("file:///etc/passwd").starts_with("refused_scheme"));
        assert!(refused("ftp://example.com/x").starts_with("refused_scheme"));
    }

    /// The one that matters most: NotaBene's own MCP server listens on
    /// loopback, and a pasted link must not be able to drive it.
    #[test]
    fn refuses_loopback_and_the_private_ranges() {
        for url in [
            "http://127.0.0.1:22600/mcp",
            "http://[::1]:22600/",
            "http://192.168.1.1/",
            "http://10.0.0.5/",
            "http://172.16.4.4/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
        ] {
            assert!(
                refused(url).starts_with("refused_host"),
                "{url} should have been refused"
            );
        }
    }

    #[test]
    fn refuses_a_private_address_wearing_an_ipv6_hat() {
        assert!(refused("http://[::ffff:127.0.0.1]/").starts_with("refused_host"));
    }

    #[test]
    fn allows_an_ordinary_public_address() {
        let parsed = reqwest::Url::parse("http://93.184.216.34/").expect("failed to parse");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build runtime")
            .block_on(async {
                check_destination(&parsed)
                    .await
                    .expect("a public address should be allowed");
            });
    }
}
