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

/// A Wikipedia search result, straight from the REST listing.
///
/// Deliberately not a page: the article itself is fetched afterwards by
/// `fetch_page` like any other link, so a saved Wikipedia article travels the
/// same extraction, storage and re-fetch path as everything else. This command
/// exists only to turn "hatvp" into a list of titles worth choosing between.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikipediaHit {
    pub title: String,
    /// The article address, assembled from a validated host so the webview
    /// never builds a Wikipedia URL of its own — it only ever hands one back.
    pub url: String,
    /// Wikidata's one-line gloss ("French jurist"), when there is one.
    pub description: Option<String>,
    /// The matching sentence, with `<span class="searchmatch">` around the hit.
    pub excerpt: Option<String>,
}

/// Wikipedia language editions are named by code, and the code becomes a
/// hostname. Anything that is not a short alphanumeric tag is refused here
/// rather than being concatenated into a URL and hoped about — `fr.wikipedia.org`
/// is a destination, `evil.com#.wikipedia.org` is an attack.
fn wikipedia_host(language: &str) -> Result<String, String> {
    let ok = !language.is_empty()
        && language.len() <= 12
        && language
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err("invalid_language:that is not a Wikipedia language code".into());
    }
    Ok(format!("{language}.wikipedia.org"))
}

/// The article address for a slug.
///
/// Built through `Url` rather than by formatting a string, because the slug
/// arrives in a response body: `set_path` percent-encodes the characters that
/// would otherwise end the path and start something else, so a key cannot bolt
/// a query or a fragment onto the address. A literal slash it leaves alone, and
/// that is correct — `AC/DC` really does live at `/wiki/AC/DC`, as do "2019/20
/// season" and every other title with one in it.
///
/// It does *not* pin the path to `/wiki/`, because a slug carrying `..` can
/// normalise its way out. That is deliberate rather than overlooked: the host
/// is what matters, and it cannot move. Whatever address comes out of here is
/// still fetched by `fetch_page`, which checks the destination again, refuses
/// anything that is not HTML, caps the size, and hands the result to
/// Readability — so the worst a strange key can do is save a Wikipedia page
/// nobody wanted.
fn wikipedia_article_url(host: &str, key: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(&format!("https://{host}/"))
        .map_err(|error| format!("invalid_url:{error}"))?;
    url.set_path(&format!("/wiki/{key}"));
    Ok(url.to_string())
}

/// Ask a Wikipedia edition what it has on a phrase.
///
/// The host is built from a validated language code rather than accepted from
/// the webview, so this is a narrower door than `fetch_page`: there is exactly
/// one shape of address it can ever reach. `check_destination` still runs, for
/// the same reason it runs everywhere else — a DNS answer is not ours to trust
/// just because we wrote the name.
#[tauri::command]
pub async fn wikipedia_search(
    language: String,
    query: String,
    limit: Option<u8>,
) -> Result<Vec<WikipediaHit>, String> {
    crate::tls::ensure_provider();

    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let host = wikipedia_host(&language)?;
    let mut url = reqwest::Url::parse(&format!("https://{host}/w/rest.php/v1/search/page"))
        .map_err(|error| format!("invalid_url:{error}"))?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("limit", &limit.unwrap_or(8).clamp(1, 20).to_string());

    check_destination(&url).await?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // No redirects at all: the search endpoint answers directly, and a
        // redirect here would be a hop this function never checked.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("NotaBene/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;

    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("fetch_failed:{error}"))?;

    if !response.status().is_success() {
        return Err(format!("http_error:{}", response.status().as_u16()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("fetch_failed:{error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("too_large:that search returned more than NotaBene will read".into());
    }

    // Only the fields the dialog draws. Wikipedia adds keys between releases,
    // and a search that failed because of a new one would be a poor trade.
    #[derive(serde::Deserialize)]
    struct Listing {
        pages: Vec<Page>,
    }
    #[derive(serde::Deserialize)]
    struct Page {
        key: String,
        title: String,
        description: Option<String>,
        excerpt: Option<String>,
    }

    let listing: Listing =
        serde_json::from_slice(&bytes).map_err(|error| format!("bad_response:{error}"))?;

    listing
        .pages
        .into_iter()
        .map(|page| {
            Ok(WikipediaHit {
                url: wikipedia_article_url(&host, &page.key)?,
                title: page.title,
                description: page.description,
                excerpt: page.excerpt,
            })
        })
        .collect()
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

    /// The language code becomes a hostname, so it is the one field an attacker
    /// would reach for.
    #[test]
    fn refuses_a_language_code_that_is_really_a_hostname() {
        for code in ["evil.com#", "fr/../..", "FR", "", "fr.evil.com", "fr:8080"] {
            assert!(
                wikipedia_host(code).is_err(),
                "{code:?} should not have become a host"
            );
        }
        assert_eq!(wikipedia_host("fr").unwrap(), "fr.wikipedia.org");
        assert_eq!(wikipedia_host("zh-yue").unwrap(), "zh-yue.wikipedia.org");
    }

    /// The slug comes out of a response body, so what it must never be able to
    /// change is the host — nor bolt a query or a fragment onto the address.
    #[test]
    fn keeps_a_slug_from_reshaping_the_url() {
        // Wikipedia's own canonical form: a slash in a title stays a slash.
        assert_eq!(
            wikipedia_article_url("en.wikipedia.org", "AC/DC").unwrap(),
            "https://en.wikipedia.org/wiki/AC/DC"
        );

        for slug in ["x?action=delete", "x#/../../y", "x y"] {
            let raw = wikipedia_article_url("fr.wikipedia.org", slug).unwrap();
            let url = reqwest::Url::parse(&raw).expect("failed to reparse");
            assert_eq!(url.host_str(), Some("fr.wikipedia.org"), "{slug:?}");
            assert_eq!(url.query(), None, "{slug:?} should not have added a query");
            assert_eq!(
                url.fragment(),
                None,
                "{slug:?} should not have added a fragment"
            );
        }
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
