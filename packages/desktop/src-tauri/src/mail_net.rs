//! Desktop mail sign-in, token refresh and mail reads (Email, phase R4).
//!
//! Design rules (decisions of 2026-11-13):
//! * Tokens live only in the OS keychain (R2), under a reserved key the page-facing keychain commands refuse to read.
//!   No command in this file returns a token, a code or a verifier to the page.
//! * Every request goes through `HostPolicy`: https only, an exact host allow-list (the known provider hosts plus mail
//!   servers the user configured for an account), no credentials in the URL. This is not a general fetch: the page can
//!   only ask for "sign in", "list folders" and "list this folder", each with a fixed request shape.
//! * The existing `http:default` permission (open to any address) is not widened and not used here.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

/// Prefix of the keychain entries Rust owns. The page-facing `mail_secret_*` commands refuse ids with this prefix.
pub const RESERVED_PREFIX: &str = "rust-oauth:";
const TOKEN_SKEW_MS: u64 = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Host policy

#[derive(Clone, Debug)]
pub struct HostPolicy {
  /// Exact hosts, any https port 443 only unless `ports` lists one.
  hosts: Vec<String>,
  /// Tests only: `host:port` pairs that may use plain http (a local fake server).
  loopback_http: Vec<(String, u16)>,
}

impl HostPolicy {
  /// The provider hosts the desktop app talks to. Nothing else.
  pub fn known() -> Self {
    HostPolicy {
      hosts: [
        "accounts.google.com",
        "oauth2.googleapis.com",
        "gmail.googleapis.com",
        "login.microsoftonline.com",
        "graph.microsoft.com",
      ]
      .iter()
      .map(|s| s.to_string())
      .collect(),
      loopback_http: vec![],
    }
  }

  /// Add a mail server the user configured for an account. Must be a plain host name.
  pub fn allow_user_host(&mut self, host: &str) -> Result<(), String> {
    let h = host.trim().to_ascii_lowercase();
    let ok = !h.is_empty()
      && h.len() <= 253
      && h.contains('.')
      && h.split('.').all(|l| !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
      && !h.chars().all(|c| c.is_ascii_digit() || c == '.');
    if !ok {
      return Err("host_rejected: not a valid mail server host name".into());
    }
    if !self.hosts.contains(&h) {
      self.hosts.push(h);
    }
    Ok(())
  }

  #[cfg(test)]
  pub fn allow_loopback_for_tests(&mut self, port: u16) {
    self.loopback_http.push(("127.0.0.1".to_string(), port));
  }

  /// Parse and check a URL. Returns the parsed URL when the policy allows it.
  pub fn check(&self, raw: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(raw).map_err(|_| "host_rejected: not a valid address".to_string())?;
    if !u.username().is_empty() || u.password().is_some() {
      return Err("host_rejected: credentials in the address".into());
    }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    match u.scheme() {
      "https" => {
        if u.port().is_some_and(|p| p != 443) {
          return Err("host_rejected: port not allowed".into());
        }
        if self.hosts.iter().any(|h| *h == host) {
          return Ok(u);
        }
      }
      "http" => {
        let port = u.port().unwrap_or(80);
        if self.loopback_http.iter().any(|(h, p)| *h == host && *p == port) {
          return Ok(u);
        }
      }
      _ => {}
    }
    Err(format!("host_rejected: {host} is not an allowed mail host"))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Providers

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
  Gmail,
  Graph,
}

#[derive(Clone, Debug)]
pub struct Endpoints {
  pub authorize: String,
  pub token: String,
  pub api_base: String,
  pub scopes: String,
  pub extra_auth: Vec<(&'static str, &'static str)>,
  /// Host used in the loopback redirect (Microsoft documents `localhost`, Google `127.0.0.1`).
  pub redirect_host: &'static str,
}

pub fn endpoints(p: Provider) -> Endpoints {
  match p {
    Provider::Gmail => Endpoints {
      authorize: "https://accounts.google.com/o/oauth2/v2/auth".into(),
      token: "https://oauth2.googleapis.com/token".into(),
      api_base: "https://gmail.googleapis.com/gmail/v1/users/me".into(),
      scopes: "https://www.googleapis.com/auth/gmail.modify".into(),
      extra_auth: vec![("access_type", "offline"), ("prompt", "consent")],
      redirect_host: "127.0.0.1",
    },
    Provider::Graph => Endpoints {
      authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
      token: "https://login.microsoftonline.com/common/oauth2/v2.0/token".into(),
      api_base: "https://graph.microsoft.com/v1.0/me".into(),
      scopes: "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send offline_access".into(),
      extra_auth: vec![("response_mode", "query"), ("prompt", "select_account")],
      redirect_host: "localhost",
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PKCE and the redirect

pub fn pkce_challenge(verifier: &str) -> String {
  URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn random_token(bytes: usize) -> Result<String, String> {
  let mut buf = vec![0u8; bytes];
  getrandom::getrandom(&mut buf).map_err(|e| format!("sign_in_failed: no randomness ({e})"))?;
  Ok(URL_SAFE_NO_PAD.encode(buf))
}

pub fn build_auth_url(ep: &Endpoints, client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> Result<String, String> {
  let mut u = url::Url::parse(&ep.authorize).map_err(|_| "sign_in_failed: bad endpoint".to_string())?;
  {
    let mut q = u.query_pairs_mut();
    q.append_pair("client_id", client_id)
      .append_pair("redirect_uri", redirect_uri)
      .append_pair("response_type", "code")
      .append_pair("scope", &ep.scopes)
      .append_pair("state", state)
      .append_pair("code_challenge", challenge)
      .append_pair("code_challenge_method", "S256");
    for (k, v) in &ep.extra_auth {
      q.append_pair(k, v);
    }
  }
  Ok(u.to_string())
}

/// Read the request line of the browser's redirect (`GET /?code=..&state=.. HTTP/1.1`) and return the code.
/// Errors never include the code or the state.
pub fn parse_redirect(request_line: &str, expected_state: &str) -> Result<String, String> {
  let target = request_line.split_whitespace().nth(1).ok_or("sign_in_failed: bad redirect")?;
  let u = url::Url::parse(&format!("http://localhost{target}")).map_err(|_| "sign_in_failed: bad redirect".to_string())?;
  let get = |k: &str| u.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
  if get("error").is_some() {
    return Err("sign_in_denied: the provider reported a denial".into());
  }
  if get("state").as_deref() != Some(expected_state) {
    return Err("sign_in_failed: state mismatch".into());
  }
  get("code").filter(|c| !c.is_empty()).ok_or_else(|| "sign_in_failed: no code in the redirect".to_string())
}

fn wait_for_redirect(listener: TcpListener, state: &str, timeout: Duration) -> Result<String, String> {
  listener.set_nonblocking(true).map_err(|e| format!("sign_in_failed: {e}"))?;
  let deadline = std::time::Instant::now() + timeout;
  loop {
    match listener.accept() {
      Ok((mut stream, _)) => {
        stream.set_nonblocking(false).ok();
        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).ok();
        // Ignore stray requests (favicon, probes): only a request carrying our state or an error counts.
        let result = parse_redirect(&line, state);
        let page = if result.is_ok() { "Signed in. You can close this tab." } else { "Sign-in did not complete. You can close this tab." };
        respond(&mut stream, page);
        if line.contains("code=") || line.contains("error=") {
          return result;
        }
      }
      Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
        if std::time::Instant::now() > deadline {
          return Err("sign_in_failed: timed out waiting for the browser".into());
        }
        std::thread::sleep(Duration::from_millis(50));
      }
      Err(e) => return Err(format!("sign_in_failed: {e}")),
    }
  }
}

fn respond(stream: &mut TcpStream, body: &str) {
  let msg = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
  let _ = stream.write_all(msg.as_bytes());
}

fn open_in_browser(url: &str) -> Result<(), String> {
  // Only ever an https address on an allowed provider host (checked by the caller).
  let mut cmd = if cfg!(target_os = "macos") {
    let mut c = std::process::Command::new("open");
    c.arg(url);
    c
  } else if cfg!(target_os = "windows") {
    let mut c = std::process::Command::new("rundll32");
    c.arg("url.dll,FileProtocolHandler").arg(url);
    c
  } else {
    let mut c = std::process::Command::new("xdg-open");
    c.arg(url);
    c
  };
  cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
  cmd.spawn().map(|_| ()).map_err(|_| "sign_in_failed: could not open the system browser".to_string())
}

// ---------------------------------------------------------------------------------------------------------------
// Token vault (the keychain in production, a map in tests) and the token endpoint

pub trait TokenVault {
  fn load(&self, account_id: &str) -> Result<Option<String>, String>;
  fn save(&self, account_id: &str, value: &str) -> Result<(), String>;
  fn remove(&self, account_id: &str) -> Result<(), String>;
}

pub struct KeychainVault;
fn reserved(account_id: &str) -> String {
  format!("{RESERVED_PREFIX}{account_id}")
}
impl TokenVault for KeychainVault {
  fn load(&self, a: &str) -> Result<Option<String>, String> {
    crate::mail_keychain::secret_get_impl(&reserved(a))
  }
  fn save(&self, a: &str, v: &str) -> Result<(), String> {
    crate::mail_keychain::secret_set_impl(&reserved(a), v)
  }
  fn remove(&self, a: &str) -> Result<(), String> {
    crate::mail_keychain::secret_delete_impl(&reserved(a))
  }
}

#[derive(Serialize, Deserialize, Clone)]
struct StoredTokens {
  access_token: String,
  refresh_token: Option<String>,
  /// Epoch milliseconds.
  expires_at: u64,
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn http() -> Result<reqwest::blocking::Client, String> {
  reqwest::blocking::Client::builder()
    .timeout(Duration::from_secs(30))
    .redirect(reqwest::redirect::Policy::none())
    .https_only(false)
    .build()
    .map_err(|_| "network_error: could not start the client".to_string())
}

fn token_request(policy: &HostPolicy, ep: &Endpoints, form: &[(&str, &str)]) -> Result<StoredTokens, String> {
  let url = policy.check(&ep.token)?;
  let resp = http()?.post(url).form(form).send().map_err(|_| "network_error: the token endpoint was unreachable".to_string())?;
  let status = resp.status();
  let body: Value = resp.json().unwrap_or(Value::Null);
  if !status.is_success() {
    // `invalid_grant` means the refresh token is gone: the page asks the user to sign in again.
    let code = body.get("error").and_then(Value::as_str).unwrap_or("");
    return Err(if code == "invalid_grant" { "sign_in_needed: the provider rejected the stored sign-in".into() } else { format!("token_error: status {}", status.as_u16()) });
  }
  let access = body.get("access_token").and_then(Value::as_str).ok_or("token_error: no access token in the response")?;
  let expires_in = body.get("expires_in").and_then(Value::as_u64).unwrap_or(3600);
  Ok(StoredTokens {
    access_token: access.to_string(),
    refresh_token: body.get("refresh_token").and_then(Value::as_str).map(str::to_string),
    expires_at: now_ms() + expires_in * 1000,
  })
}

pub fn exchange_code(policy: &HostPolicy, vault: &dyn TokenVault, account_id: &str, ep: &Endpoints, client_id: &str, redirect_uri: &str, code: &str, verifier: &str) -> Result<(), String> {
  let t = token_request(
    policy,
    ep,
    &[("grant_type", "authorization_code"), ("code", code), ("client_id", client_id), ("redirect_uri", redirect_uri), ("code_verifier", verifier)],
  )?;
  vault.save(account_id, &serde_json::to_string(&t).map_err(|_| "token_error: could not store")?)
}

/// A valid access token for an account, refreshing through the token endpoint when it is about to expire.
/// Internal only: nothing here is returned to the page.
pub(crate) fn access_token(policy: &HostPolicy, vault: &dyn TokenVault, account_id: &str, ep: &Endpoints, client_id: &str) -> Result<String, String> {
  let raw = vault.load(account_id)?.ok_or("sign_in_needed: no sign-in stored for this account")?;
  let t: StoredTokens = serde_json::from_str(&raw).map_err(|_| "sign_in_needed: the stored sign-in is unreadable".to_string())?;
  if now_ms() + TOKEN_SKEW_MS < t.expires_at {
    return Ok(t.access_token);
  }
  let refresh = t.refresh_token.clone().ok_or("sign_in_needed: the sign-in expired and has no refresh token")?;
  let mut fresh = token_request(policy, ep, &[("grant_type", "refresh_token"), ("refresh_token", &refresh), ("client_id", client_id)])?;
  if fresh.refresh_token.is_none() {
    fresh.refresh_token = Some(refresh); // Google keeps the old one; Microsoft rotates it.
  }
  vault.save(account_id, &serde_json::to_string(&fresh).map_err(|_| "token_error: could not store")?)?;
  Ok(fresh.access_token)
}

// ---------------------------------------------------------------------------------------------------------------
// Mail reads: fixed request shapes only

fn safe_id(id: &str) -> Result<&str, String> {
  if !id.is_empty() && id.len() <= 200 && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_=.".contains(c)) {
    Ok(id)
  } else {
    Err("bad_request: invalid folder id".into())
  }
}

fn api_get(policy: &HostPolicy, token: &str, url: &str, query: &[(&str, String)]) -> Result<Value, String> {
  let mut u = policy.check(url)?;
  {
    let mut q = u.query_pairs_mut();
    for (k, v) in query {
      q.append_pair(k, v);
    }
  }
  let resp = http()?.get(u).bearer_auth(token).send().map_err(|_| "network_error: the mail server was unreachable".to_string())?;
  let status = resp.status();
  if status.as_u16() == 401 {
    return Err("sign_in_needed: the provider rejected the access token".into());
  }
  if !status.is_success() {
    return Err(format!("provider_error: status {}", status.as_u16()));
  }
  resp.json::<Value>().map_err(|_| "provider_error: unreadable response".to_string())
}

pub fn list_folders(policy: &HostPolicy, vault: &dyn TokenVault, account_id: &str, p: Provider, ep: &Endpoints, client_id: &str) -> Result<Value, String> {
  let token = access_token(policy, vault, account_id, ep, client_id)?;
  match p {
    Provider::Gmail => api_get(policy, &token, &format!("{}/labels", ep.api_base), &[]),
    Provider::Graph => api_get(policy, &token, &format!("{}/mailFolders", ep.api_base), &[("$top", "100".into())]),
  }
}

pub fn list_messages(policy: &HostPolicy, vault: &dyn TokenVault, account_id: &str, p: Provider, ep: &Endpoints, client_id: &str, folder_id: &str, page_token: Option<&str>, limit: u32) -> Result<Value, String> {
  let folder = safe_id(folder_id)?;
  let limit = limit.clamp(1, 100).to_string();
  let token = access_token(policy, vault, account_id, ep, client_id)?;
  match p {
    Provider::Gmail => {
      let mut q = vec![("labelIds", folder.to_string()), ("maxResults", limit)];
      if let Some(t) = page_token {
        q.push(("pageToken", safe_id(t)?.to_string()));
      }
      api_get(policy, &token, &format!("{}/messages", ep.api_base), &q)
    }
    Provider::Graph => {
      let mut q = vec![("$top", limit), ("$select", "id,subject,from,receivedDateTime,isRead,conversationId,bodyPreview".to_string())];
      if let Some(t) = page_token {
        q.push(("$skiptoken", safe_id(t)?.to_string()));
      }
      api_get(policy, &token, &format!("{}/mailFolders/{}/messages", ep.api_base, folder), &q)
    }
  }
}

pub fn sign_in(policy: &HostPolicy, vault: &dyn TokenVault, account_id: &str, ep: &Endpoints, client_id: &str, open: &dyn Fn(&str) -> Result<(), String>, timeout: Duration) -> Result<(), String> {
  if client_id.is_empty() || client_id.len() > 300 {
    return Err("sign_in_failed: no client id configured".into());
  }
  let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "sign_in_failed: could not open the local redirect port".to_string())?;
  let port = listener.local_addr().map_err(|e| format!("sign_in_failed: {e}"))?.port();
  let redirect_uri = format!("http://{}:{port}", ep.redirect_host);
  let verifier = random_token(48)?;
  let state = random_token(24)?;
  let auth = build_auth_url(ep, client_id, &redirect_uri, &state, &pkce_challenge(&verifier))?;
  policy.check(&auth)?; // the consent page must be on an allowed provider host
  open(&auth)?;
  let code = wait_for_redirect(listener, &state, timeout)?;
  exchange_code(policy, vault, account_id, ep, client_id, &redirect_uri, &code, &verifier)
}

// ---------------------------------------------------------------------------------------------------------------
// Tauri commands

/// Mail servers the user configured, per account. Held in memory; the page re-registers them on start.
static USER_HOSTS: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

pub(crate) fn policy_for(account_id: &str) -> HostPolicy {
  let mut p = HostPolicy::known();
  if let Some(map) = USER_HOSTS.lock().unwrap().as_ref() {
    for h in map.get(account_id).into_iter().flatten() {
      let _ = p.allow_user_host(h);
    }
  }
  p
}

/// True when the user registered exactly this mail server host for the account (IMAP and SMTP use this, never the
/// provider API hosts that `HostPolicy::known` also lists).
pub(crate) fn user_host_registered(account_id: &str, host: &str) -> bool {
  let h = host.trim().to_ascii_lowercase();
  USER_HOSTS.lock().unwrap().as_ref().and_then(|m| m.get(account_id)).is_some_and(|l| l.contains(&h))
}

#[derive(Serialize)]
pub struct SignInResult {
  pub signed_in: bool,
}

/// Register a mail server host for an account (the user typed it in settings). Validated as a plain host name.
#[tauri::command]
pub fn mail_register_host(account_id: String, host: String) -> Result<(), String> {
  HostPolicy::known().allow_user_host(&host)?;
  let mut g = USER_HOSTS.lock().unwrap();
  let list = g.get_or_insert_with(HashMap::new).entry(account_id).or_default();
  let h = host.trim().to_ascii_lowercase();
  if !list.contains(&h) {
    list.push(h);
  }
  Ok(())
}

#[tauri::command]
pub async fn mail_oauth_sign_in(account_id: String, provider: Provider, client_id: String) -> Result<SignInResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let policy = policy_for(&account_id);
    sign_in(&policy, &KeychainVault, &account_id, &endpoints(provider), &client_id, &open_in_browser, Duration::from_secs(300))?;
    Ok(SignInResult { signed_in: true })
  })
  .await
  .map_err(|e| format!("sign_in_failed: {e}"))?
}

#[tauri::command]
pub async fn mail_sign_out(account_id: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || KeychainVault.remove(&account_id)).await.map_err(|e| format!("keychain error: {e}"))?
}

#[tauri::command]
pub async fn mail_list_folders(account_id: String, provider: Provider, client_id: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || list_folders(&policy_for(&account_id), &KeychainVault, &account_id, provider, &endpoints(provider), &client_id))
    .await
    .map_err(|e| format!("network_error: {e}"))?
}

#[tauri::command]
pub async fn mail_list_messages(account_id: String, provider: Provider, client_id: String, folder_id: String, page_token: Option<String>, limit: Option<u32>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    list_messages(&policy_for(&account_id), &KeychainVault, &account_id, provider, &endpoints(provider), &client_id, &folder_id, page_token.as_deref(), limit.unwrap_or(25))
  })
  .await
  .map_err(|e| format!("network_error: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;
  use std::io::Read;
  use std::sync::{Arc, Mutex as StdMutex};

  #[derive(Default)]
  struct MemVault(StdMutex<HashMap<String, String>>);
  impl TokenVault for MemVault {
    fn load(&self, a: &str) -> Result<Option<String>, String> {
      Ok(self.0.lock().unwrap().get(a).cloned())
    }
    fn save(&self, a: &str, v: &str) -> Result<(), String> {
      self.0.lock().unwrap().insert(a.into(), v.into());
      Ok(())
    }
    fn remove(&self, a: &str) -> Result<(), String> {
      self.0.lock().unwrap().remove(a);
      Ok(())
    }
  }

  /// A tiny fake server: records each request (head + body) and answers by path.
  struct Fake {
    port: u16,
    seen: Arc<StdMutex<Vec<String>>>,
  }
  fn fake_server() -> Fake {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let s2 = seen.clone();
    std::thread::spawn(move || {
      for stream in l.incoming() {
        let Ok(mut stream) = stream else { break };
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let first = req.lines().next().unwrap_or("").to_string();
        s2.lock().unwrap().push(req.clone());
        let body = if first.contains("/token") {
          if req.contains("grant_type=refresh_token") {
            json!({"access_token":"AT-refreshed","expires_in":3600})
          } else {
            json!({"access_token":"AT-first","refresh_token":"RT-secret","expires_in":3600})
          }
        } else if first.contains("/labels") {
          json!({"labels":[{"id":"INBOX","name":"INBOX"}]})
        } else {
          json!({"messages":[{"id":"m1"}]})
        }
        .to_string();
        let msg = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(msg.as_bytes());
      }
    });
    Fake { port, seen }
  }

  fn test_setup(f: &Fake) -> (HostPolicy, Endpoints) {
    let mut p = HostPolicy::known();
    p.allow_loopback_for_tests(f.port);
    let mut ep = endpoints(Provider::Gmail);
    ep.token = format!("http://127.0.0.1:{}/token", f.port);
    ep.api_base = format!("http://127.0.0.1:{}/gmail/v1/users/me", f.port);
    (p, ep)
  }

  #[test]
  fn pkce_matches_the_rfc_7636_vector() {
    assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  }

  #[test]
  fn policy_rejects_other_hosts_schemes_ports_and_credentials() {
    let p = HostPolicy::known();
    assert!(p.check("https://gmail.googleapis.com/gmail/v1/users/me/labels").is_ok());
    assert!(p.check("https://evil.example.com/x").unwrap_err().starts_with("host_rejected"));
    assert!(p.check("http://gmail.googleapis.com/x").is_err());
    assert!(p.check("https://gmail.googleapis.com:8443/x").is_err());
    assert!(p.check("https://user:pw@gmail.googleapis.com/x").is_err());
    assert!(p.check("https://gmail.googleapis.com.evil.com/x").is_err());
    assert!(p.check("http://127.0.0.1:9/x").is_err());
    let mut q = HostPolicy::known();
    assert!(q.allow_user_host("imap.fastmail.com").is_ok());
    assert!(q.check("https://imap.fastmail.com/x").is_ok());
    assert!(q.allow_user_host("127.0.0.1").is_err());
    assert!(q.allow_user_host("a/b.com").is_err());
  }

  #[test]
  fn redirect_parsing_checks_state_and_denial_without_echoing_secrets() {
    assert_eq!(parse_redirect("GET /?code=abc&state=S1 HTTP/1.1", "S1").unwrap(), "abc");
    let e = parse_redirect("GET /?code=abc&state=WRONG HTTP/1.1", "S1").unwrap_err();
    assert!(!e.contains("abc") && !e.contains("WRONG"));
    assert!(parse_redirect("GET /?error=access_denied&state=S1 HTTP/1.1", "S1").unwrap_err().starts_with("sign_in_denied"));
  }

  #[test]
  fn auth_url_carries_pkce_and_state_but_no_secret() {
    let ep = endpoints(Provider::Gmail);
    let u = build_auth_url(&ep, "cid", "http://127.0.0.1:5555", "ST", "CH").unwrap();
    assert!(u.contains("code_challenge=CH") && u.contains("code_challenge_method=S256") && u.contains("state=ST"));
    assert!(!u.contains("code_verifier"));
  }

  #[test]
  fn full_sign_in_against_a_local_fake_stores_tokens_in_the_vault_only() {
    let f = fake_server();
    let (policy, ep) = test_setup(&f);
    let vault = MemVault::default();
    // The "browser": read the consent address, then call the redirect port with the right state and a code.
    let open = |auth: &str| -> Result<(), String> {
      let u = url::Url::parse(auth).unwrap();
      let q: HashMap<_, _> = u.query_pairs().into_owned().collect();
      let redirect = q["redirect_uri"].clone();
      let state = q["state"].clone();
      let port: u16 = redirect.rsplit(':').next().unwrap().parse().unwrap();
      std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /?code=CODE-1&state={state} HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut sink = String::new();
        let _ = s.read_to_string(&mut sink);
      });
      Ok(())
    };
    sign_in(&policy, &vault, "acct", &ep, "cid", &open, Duration::from_secs(10)).unwrap();
    let stored = vault.load("acct").unwrap().unwrap();
    assert!(stored.contains("RT-secret"));
    let seen = f.seen.lock().unwrap().join("\n");
    assert!(seen.contains("code=CODE-1") && seen.contains("code_verifier="));
  }

  #[test]
  fn reads_use_a_bearer_token_and_never_return_it() {
    let f = fake_server();
    let (policy, ep) = test_setup(&f);
    let vault = MemVault::default();
    let fresh = StoredTokens { access_token: "AT-live".into(), refresh_token: Some("RT-secret".into()), expires_at: now_ms() + 3_600_000 };
    vault.save("acct", &serde_json::to_string(&fresh).unwrap()).unwrap();
    let folders = list_folders(&policy, &vault, "acct", Provider::Gmail, &ep, "cid").unwrap();
    let msgs = list_messages(&policy, &vault, "acct", Provider::Gmail, &ep, "cid", "INBOX", None, 10).unwrap();
    let out = format!("{folders}{msgs}");
    assert!(!out.contains("AT-live") && !out.contains("RT-secret"));
    assert!(f.seen.lock().unwrap().iter().any(|r| r.to_ascii_lowercase().contains("authorization: bearer at-live")));
  }

  #[test]
  fn an_expiring_token_is_refreshed_and_the_rotated_pair_is_stored() {
    let f = fake_server();
    let (policy, ep) = test_setup(&f);
    let vault = MemVault::default();
    let old = StoredTokens { access_token: "AT-old".into(), refresh_token: Some("RT-secret".into()), expires_at: now_ms() + 1000 };
    vault.save("acct", &serde_json::to_string(&old).unwrap()).unwrap();
    list_folders(&policy, &vault, "acct", Provider::Gmail, &ep, "cid").unwrap();
    let stored = vault.load("acct").unwrap().unwrap();
    assert!(stored.contains("AT-refreshed") && stored.contains("RT-secret"));
    assert!(f.seen.lock().unwrap().iter().any(|r| r.to_ascii_lowercase().contains("authorization: bearer at-refreshed")));
  }

  #[test]
  fn no_stored_sign_in_asks_the_page_to_sign_in() {
    let f = fake_server();
    let (policy, ep) = test_setup(&f);
    let e = list_folders(&policy, &MemVault::default(), "none", Provider::Gmail, &ep, "cid").unwrap_err();
    assert!(e.starts_with("sign_in_needed"));
  }

  #[test]
  fn the_allow_list_stops_a_request_to_another_address() {
    let f = fake_server();
    let (policy, mut ep) = test_setup(&f);
    ep.api_base = "https://evil.example.com/gmail".into();
    let vault = MemVault::default();
    let t = StoredTokens { access_token: "AT-live".into(), refresh_token: None, expires_at: now_ms() + 3_600_000 };
    vault.save("acct", &serde_json::to_string(&t).unwrap()).unwrap();
    let e = list_folders(&policy, &vault, "acct", Provider::Gmail, &ep, "cid").unwrap_err();
    assert!(e.starts_with("host_rejected"));
    assert!(!e.contains("AT-live"));
    // A different loopback port is not allowed either.
    ep.api_base = format!("http://127.0.0.1:{}/x", f.port.wrapping_add(1));
    assert!(list_folders(&policy, &vault, "acct", Provider::Gmail, &ep, "cid").unwrap_err().starts_with("host_rejected"));
  }

  #[test]
  fn folder_ids_cannot_inject_path_or_query() {
    assert!(safe_id("INBOX").is_ok());
    assert!(safe_id("a/b").is_err());
    assert!(safe_id("a?x=1").is_err());
    assert!(safe_id("").is_err());
  }

  #[test]
  fn the_page_facing_keychain_commands_cannot_read_the_reserved_entries() {
    assert!(crate::mail_keychain::secret_get_impl_for_page(&format!("{RESERVED_PREFIX}acct")).is_err());
    assert!(crate::mail_keychain::secret_set_impl_for_page(&format!("{RESERVED_PREFIX}acct"), "x").is_err());
  }
}
