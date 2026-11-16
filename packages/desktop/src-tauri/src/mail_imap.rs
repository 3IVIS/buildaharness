//! IMAP and SMTP transport for the desktop app (Email, phase H6a).
//!
//! Rust owns the connection, the TLS, the credential and the sign-in; the page owns the protocol meaning (which folder,
//! which flags, how a thread is built) and sends a short list of IMAP commands that this module checks against a fixed
//! allow-list before they leave. Rules, all enforced here and never in the page:
//! - Implicit TLS only (ports 993 and 465 in the app). No STARTTLS, no plaintext fallback: a server that does not
//!   speak TLS fails the handshake and the call fails.
//! - The server host must be one the user registered for that account (`mail_register_host`). Exact match, plain DNS
//!   names only (no IP literals), so a page cannot aim these commands at another machine.
//! - The password (an app password) or OAuth token is read from the keychain here and used only to log in. It is never
//!   returned, logged or put in an error. `LOGIN`, `AUTHENTICATE` and `STARTTLS` are not accepted from the page.
//! - Commands are one line, no CR, LF or NUL; APPEND is the only command that takes a literal.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;

use crate::mail_net::{self, endpoints, KeychainVault, Provider};

/// Keychain key prefix for app passwords. Reserved: the page-facing `mail_secret_*` commands refuse it.
pub const PASSWORD_PREFIX: &str = "rust-imap:";
const IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LINE: u64 = 1 << 20;
const MAX_RESPONSE: usize = 32 << 20;
const IMAP_PORT: u16 = 993;
const SMTP_PORT: u16 = 465;

pub trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}

// ---------------------------------------------------------------------------------------------------------------
// TLS

/// Implicit TLS with the public web roots. A server that does not speak TLS never gets a byte of the login.
pub fn tls_connect(host: &str, port: u16) -> Result<Box<dyn Stream>, String> {
  let addr = (host, port).to_socket_addrs().map_err(|_| "network_error: could not find the mail server".to_string())?.next().ok_or("network_error: could not find the mail server")?;
  let tcp = TcpStream::connect_timeout(&addr, IO_TIMEOUT).map_err(|_| "network_error: could not reach the mail server".to_string())?;
  tcp.set_read_timeout(Some(IO_TIMEOUT)).ok();
  tcp.set_write_timeout(Some(IO_TIMEOUT)).ok();
  let mut roots = rustls::RootCertStore::empty();
  roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
  let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
    .with_safe_default_protocol_versions()
    .map_err(|_| "network_error: TLS is not available".to_string())?
    .with_root_certificates(roots)
    .with_no_client_auth();
  let name = rustls::pki_types::ServerName::try_from(host.to_string()).map_err(|_| "host_rejected: not a valid mail server host name".to_string())?;
  let conn = rustls::ClientConnection::new(Arc::new(cfg), name).map_err(|_| "network_error: TLS is not available".to_string())?;
  Ok(Box::new(rustls::StreamOwned::new(conn, tcp)))
}

// ---------------------------------------------------------------------------------------------------------------
// Credentials

pub enum Secret {
  Password(String),
  Token(String),
}
pub struct Cred {
  pub user: String,
  pub secret: Secret,
}

fn no_ctl(s: &str) -> bool {
  !s.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
}

fn quote(s: &str) -> Result<String, String> {
  if !no_ctl(s) {
    return Err("bad_request: control characters in a login field".into());
  }
  Ok(format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
}

fn xoauth2(user: &str, token: &str) -> String {
  B64.encode(format!("user={user}\u{1}auth=Bearer {token}\u{1}\u{1}"))
}

// ---------------------------------------------------------------------------------------------------------------
// Line reading shared by IMAP and SMTP

struct Io {
  r: BufReader<Box<dyn Stream>>,
}
impl Io {
  fn new(s: Box<dyn Stream>) -> Self {
    Io { r: BufReader::new(s) }
  }
  fn line(&mut self) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let n = Read::by_ref(&mut self.r).take(MAX_LINE).read_until(b'\n', &mut buf).map_err(|_| "network_error: the mail server stopped answering".to_string())?;
    if n == 0 {
      return Err("network_error: the mail server closed the connection".into());
    }
    if buf.last() != Some(&b'\n') {
      return Err("network_error: the mail server sent a line that is too long".into());
    }
    Ok(buf)
  }
  fn send(&mut self, bytes: &[u8]) -> Result<(), String> {
    let w = self.r.get_mut();
    w.write_all(bytes).and_then(|_| w.flush()).map_err(|_| "network_error: could not send to the mail server".to_string())
  }
}

// ---------------------------------------------------------------------------------------------------------------
// IMAP

pub struct Imap {
  io: Io,
  n: u32,
}

/// The `{N}` or `{N+}` at the end of a response line, if any.
fn literal_len(line: &[u8]) -> Option<usize> {
  let t = std::str::from_utf8(line).ok()?.trim_end_matches(['\r', '\n']);
  let t = t.strip_suffix('}')?;
  let open = t.rfind('{')?;
  t[open + 1..].trim_end_matches('+').parse().ok()
}

impl Imap {
  pub fn open(conn: Box<dyn Stream>) -> Result<Self, String> {
    let mut io = Io::new(conn);
    let g = io.line()?;
    if !(g.starts_with(b"* OK") || g.starts_with(b"* PREAUTH")) {
      return Err("network_error: not an IMAP server".into());
    }
    Ok(Imap { io, n: 0 })
  }

  /// Send one command (and an optional literal) and collect everything up to its tagged status line.
  pub fn run(&mut self, command: &str, literal: Option<&str>) -> Result<String, String> {
    self.n += 1;
    let tag = format!("A{}", self.n);
    let head = match literal {
      Some(l) => format!("{tag} {command} {{{}}}\r\n", l.len()),
      None => format!("{tag} {command}\r\n"),
    };
    self.io.send(head.as_bytes())?;
    if let Some(l) = literal {
      let cont = self.io.line()?;
      if !cont.starts_with(b"+") {
        return Err("provider_error: the server refused the message data".into());
      }
      self.io.send(l.as_bytes())?;
      self.io.send(b"\r\n")?;
    }
    let mut out: Vec<u8> = Vec::new();
    let prefix = format!("{tag} ");
    let mut continuation = false;
    loop {
      let line = self.io.line()?;
      let tagged = !continuation && line.starts_with(prefix.as_bytes());
      out.extend_from_slice(&line);
      if out.len() > MAX_RESPONSE {
        return Err("provider_error: the response was too large".into());
      }
      if tagged {
        let text = String::from_utf8_lossy(&line[prefix.len()..]).trim().to_string();
        let status = text.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
        return if status == "OK" { Ok(String::from_utf8_lossy(&out).into_owned()) } else { Err(format!("provider_error: {text}")) };
      }
      continuation = false;
      if let Some(n) = literal_len(&line) {
        if out.len() + n > MAX_RESPONSE {
          return Err("provider_error: the response was too large".into());
        }
        let mut chunk = vec![0u8; n];
        self.io.r.read_exact(&mut chunk).map_err(|_| "network_error: the mail server stopped answering".to_string())?;
        out.extend_from_slice(&chunk);
        continuation = true;
      }
    }
  }

  pub fn login(&mut self, cred: &Cred) -> Result<(), String> {
    match &cred.secret {
      Secret::Password(p) => self.run(&format!("LOGIN {} {}", quote(&cred.user)?, quote(p)?), None).map(|_| ()).map_err(|e| {
        if e.starts_with("network_error") { e } else { "sign_in_failed: the mail server refused the user name or password".to_string() }
      }),
      Secret::Token(t) => {
        if !no_ctl(&cred.user) || !no_ctl(t) {
          return Err("bad_request: control characters in a login field".into());
        }
        self.n += 1;
        let tag = format!("A{}", self.n);
        self.io.send(format!("{tag} AUTHENTICATE XOAUTH2 {}\r\n", xoauth2(&cred.user, t)).as_bytes())?;
        loop {
          let line = self.io.line()?;
          if line.starts_with(b"+") {
            self.io.send(b"\r\n")?; // the server sent an error blob; an empty line lets it finish with a tagged NO
          } else if line.starts_with(format!("{tag} OK").as_bytes()) {
            return Ok(());
          } else if line.starts_with(format!("{tag} ").as_bytes()) {
            return Err("sign_in_needed: the mail server refused the sign-in".into());
          }
        }
      }
    }
  }
}

#[derive(Deserialize, Clone, Debug)]
pub struct ImapCmd {
  pub command: String,
  pub literal: Option<String>,
}

const TOP_VERBS: &[&str] = &["CAPABILITY", "NOOP", "NAMESPACE", "LIST", "LSUB", "STATUS", "SELECT", "EXAMINE", "CREATE", "FETCH", "STORE", "SEARCH", "COPY", "MOVE", "EXPUNGE", "APPEND", "CLOSE", "UID"];
const UID_VERBS: &[&str] = &["FETCH", "STORE", "SEARCH", "COPY", "MOVE", "EXPUNGE"];

/// The page may send only these verbs. LOGIN, AUTHENTICATE, STARTTLS, LOGOUT, DELETE and RENAME are not in the list.
pub fn check_command(c: &ImapCmd) -> Result<(), String> {
  if c.command.is_empty() || c.command.len() > 4096 || !no_ctl(&c.command) {
    return Err("bad_request: not a single-line command".into());
  }
  let mut words = c.command.split_whitespace();
  let first = words.next().unwrap_or("").to_ascii_uppercase();
  if !TOP_VERBS.contains(&first.as_str()) {
    return Err(format!("bad_request: {first} is not an allowed command"));
  }
  if first == "UID" {
    let second = words.next().unwrap_or("").to_ascii_uppercase();
    if !UID_VERBS.contains(&second.as_str()) {
      return Err("bad_request: not an allowed UID command".into());
    }
  }
  if c.literal.is_some() && first != "APPEND" {
    return Err("bad_request: only APPEND takes message data".into());
  }
  if c.literal.as_deref().is_some_and(|l| l.contains('\0')) {
    return Err("bad_request: message data holds a NUL".into());
  }
  Ok(())
}

/// Connect, log in, run each command in order on the one connection (so SELECT carries over), return the raw responses.
pub fn imap_session(conn: Box<dyn Stream>, cred: &Cred, commands: &[ImapCmd]) -> Result<Vec<String>, String> {
  for c in commands {
    check_command(c)?;
  }
  let mut imap = Imap::open(conn)?;
  imap.login(cred)?;
  let mut out = Vec::with_capacity(commands.len());
  for c in commands {
    out.push(imap.run(&c.command, c.literal.as_deref())?);
  }
  let _ = imap.run("LOGOUT", None);
  Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// SMTP

fn smtp_reply(io: &mut Io) -> Result<(u16, String), String> {
  let mut text = String::new();
  loop {
    let l = io.line()?;
    let s = String::from_utf8_lossy(&l).to_string();
    let code: u16 = s.get(0..3).and_then(|c| c.parse().ok()).ok_or("network_error: not an SMTP server")?;
    text.push_str(s.get(4..).unwrap_or("").trim_end());
    text.push('\n');
    if s.as_bytes().get(3) != Some(&b'-') {
      return Ok((code, text));
    }
  }
}

fn smtp_expect(io: &mut Io, ok: &[u16], what: &str) -> Result<String, String> {
  let (code, text) = smtp_reply(io)?;
  if ok.contains(&code) {
    Ok(text)
  } else if what == "auth" {
    Err("sign_in_failed: the mail server refused the sign-in".into())
  } else {
    Err(format!("provider_error: SMTP {code} at {what}"))
  }
}

fn smtp_addr(a: &str) -> Result<&str, String> {
  if a.is_empty() || a.len() > 320 || a.chars().any(|c| c.is_whitespace() || c.is_control() || c == '<' || c == '>') || !a.contains('@') {
    return Err("bad_request: not a plain mail address".into());
  }
  Ok(a)
}

/// CRLF line ends, leading dots doubled, ending CRLF.
pub fn dot_stuff(data: &str) -> String {
  let norm = data.replace("\r\n", "\n").replace('\r', "\n");
  let mut out = String::with_capacity(norm.len() + 16);
  for line in norm.trim_end_matches('\n').split('\n') {
    if line.starts_with('.') {
      out.push('.');
    }
    out.push_str(line);
    out.push_str("\r\n");
  }
  out
}

pub fn smtp_session(conn: Box<dyn Stream>, cred: &Cred, from: &str, rcpts: &[String], data: &str) -> Result<(), String> {
  smtp_addr(from)?;
  if rcpts.is_empty() || rcpts.len() > 200 {
    return Err("bad_request: no recipients".into());
  }
  for r in rcpts {
    smtp_addr(r)?;
  }
  if data.contains('\0') || !no_ctl(&cred.user) {
    return Err("bad_request: control characters".into());
  }
  let mut io = Io::new(conn);
  smtp_expect(&mut io, &[220], "greeting")?;
  io.send(b"EHLO aielia.invalid\r\n")?;
  smtp_expect(&mut io, &[250], "EHLO")?;
  match &cred.secret {
    Secret::Password(p) => {
      if !no_ctl(p) {
        return Err("bad_request: control characters".into());
      }
      io.send(format!("AUTH PLAIN {}\r\n", B64.encode(format!("\0{}\0{}", cred.user, p))).as_bytes())?;
      smtp_expect(&mut io, &[235], "auth")?;
    }
    Secret::Token(t) => {
      if !no_ctl(t) {
        return Err("bad_request: control characters".into());
      }
      io.send(format!("AUTH XOAUTH2 {}\r\n", xoauth2(&cred.user, t)).as_bytes())?;
      let (code, _) = smtp_reply(&mut io)?;
      if code == 334 {
        io.send(b"\r\n")?;
        let _ = smtp_reply(&mut io);
        return Err("sign_in_needed: the mail server refused the sign-in".into());
      }
      if code != 235 {
        return Err("sign_in_needed: the mail server refused the sign-in".into());
      }
    }
  }
  io.send(format!("MAIL FROM:<{from}>\r\n").as_bytes())?;
  smtp_expect(&mut io, &[250], "MAIL FROM")?;
  for r in rcpts {
    io.send(format!("RCPT TO:<{r}>\r\n").as_bytes())?;
    smtp_expect(&mut io, &[250, 251], "RCPT TO")?;
  }
  io.send(b"DATA\r\n")?;
  smtp_expect(&mut io, &[354], "DATA")?;
  io.send(dot_stuff(data).as_bytes())?;
  io.send(b".\r\n")?;
  smtp_expect(&mut io, &[250], "message")?;
  let _ = io.send(b"QUIT\r\n");
  Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Tauri commands

#[derive(Deserialize, Clone, Debug)]
pub struct ServerCfg {
  pub host: String,
  pub port: u16,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthCfg {
  Password { user: String },
  Oauth { user: String, provider: Provider, #[serde(rename = "clientId")] client_id: String },
}

/// The server must be one the user registered for this account, on the implicit-TLS port for the protocol.
pub fn check_server(account_id: &str, s: &ServerCfg, port: u16) -> Result<(), String> {
  if s.port != port {
    return Err(format!("host_rejected: port {} is not allowed (use {port}, TLS)", s.port));
  }
  if !mail_net::user_host_registered(account_id, &s.host) {
    return Err(format!("host_rejected: {} is not a mail server registered for this account", s.host.to_ascii_lowercase()));
  }
  Ok(())
}

fn credential(account_id: &str, auth: &AuthCfg) -> Result<Cred, String> {
  match auth {
    AuthCfg::Password { user } => {
      let p = crate::mail_keychain::secret_get_impl(&format!("{PASSWORD_PREFIX}{account_id}"))?.ok_or("sign_in_needed: no app password stored for this account")?;
      Ok(Cred { user: user.clone(), secret: Secret::Password(p) })
    }
    AuthCfg::Oauth { user, provider, client_id } => {
      let t = mail_net::access_token(&mail_net::policy_for(account_id), &KeychainVault, account_id, &endpoints(*provider), client_id)?;
      Ok(Cred { user: user.clone(), secret: Secret::Token(t) })
    }
  }
}

/// Store an app password in the keychain. The page can write it; nothing can read it back out to the page.
#[tauri::command]
pub async fn mail_imap_set_password(account_id: String, password: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || crate::mail_keychain::secret_set_impl(&format!("{PASSWORD_PREFIX}{account_id}"), &password))
    .await
    .map_err(|e| format!("keychain error: {e}"))?
}

#[tauri::command]
pub async fn mail_imap_clear_password(account_id: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || crate::mail_keychain::secret_delete_impl(&format!("{PASSWORD_PREFIX}{account_id}")))
    .await
    .map_err(|e| format!("keychain error: {e}"))?
}

#[derive(Serialize)]
pub struct ImapResult {
  pub responses: Vec<String>,
}

#[tauri::command]
pub async fn mail_imap_run(account_id: String, server: ServerCfg, auth: AuthCfg, commands: Vec<ImapCmd>) -> Result<ImapResult, String> {
  tauri::async_runtime::spawn_blocking(move || {
    check_server(&account_id, &server, IMAP_PORT)?;
    for c in &commands {
      check_command(c)?;
    }
    let cred = credential(&account_id, &auth)?;
    let responses = imap_session(tls_connect(&server.host, server.port)?, &cred, &commands)?;
    Ok(ImapResult { responses })
  })
  .await
  .map_err(|e| format!("network_error: {e}"))?
}

#[tauri::command]
pub async fn mail_smtp_send(account_id: String, server: ServerCfg, auth: AuthCfg, from: String, recipients: Vec<String>, data: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    check_server(&account_id, &server, SMTP_PORT)?;
    let cred = credential(&account_id, &auth)?;
    smtp_session(tls_connect(&server.host, server.port)?, &cred, &from, &recipients, &data)
  })
  .await
  .map_err(|e| format!("network_error: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;
  use std::sync::Mutex;

  /// A one-connection fake server on the loopback; the handler gets the accepted stream.
  fn serve(handler: impl FnOnce(TcpStream) + Send + 'static) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
      if let Ok((s, _)) = l.accept() {
        s.set_read_timeout(Some(Duration::from_secs(10))).ok();
        handler(s);
      }
    });
    port
  }
  fn plain(port: u16) -> Box<dyn Stream> {
    let s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).ok();
    Box::new(s)
  }
  fn read_line(r: &mut BufReader<TcpStream>) -> String {
    let mut s = String::new();
    r.read_line(&mut s).unwrap();
    s
  }
  fn pw(user: &str, p: &str) -> Cred {
    Cred { user: user.into(), secret: Secret::Password(p.into()) }
  }

  /// Fake IMAP: LOGIN checks the password, SELECT/UID FETCH/APPEND/LOGOUT answer. Every received line is recorded.
  fn imap_server(log: Arc<Mutex<Vec<String>>>) -> u16 {
    serve(move |s| {
      let mut w = s.try_clone().unwrap();
      let mut r = BufReader::new(s);
      w.write_all(b"* OK fake imap ready\r\n").unwrap();
      loop {
        let line = read_line(&mut r);
        if line.is_empty() {
          return;
        }
        log.lock().unwrap().push(line.trim_end().to_string());
        let mut it = line.trim_end().splitn(3, ' ');
        let tag = it.next().unwrap().to_string();
        let verb = it.next().unwrap_or("").to_ascii_uppercase();
        let rest = it.next().unwrap_or("").to_string();
        match verb.as_str() {
          "LOGIN" if rest == "\"me@example.org\" \"app-pass-1\"" => write!(w, "{tag} OK logged in\r\n").unwrap(),
          "LOGIN" => write!(w, "{tag} NO [AUTHENTICATIONFAILED] bad login\r\n").unwrap(),
          "AUTHENTICATE" if rest.starts_with("XOAUTH2 ") => write!(w, "{tag} OK ok\r\n").unwrap(),
          "SELECT" => write!(w, "* 2 EXISTS\r\n* OK [UIDVALIDITY 77] ok\r\n{tag} OK [READ-WRITE] done\r\n").unwrap(),
          "UID" => write!(w, "* 1 FETCH (UID 5 BODY[] {{12}}\r\nhello\r\nworld)\r\n{tag} OK done\r\n").unwrap(),
          "APPEND" => {
            let n: usize = rest.rsplit('{').next().unwrap().trim_end_matches('}').parse().unwrap();
            w.write_all(b"+ go ahead\r\n").unwrap();
            let mut buf = vec![0u8; n + 2];
            r.read_exact(&mut buf).unwrap();
            log.lock().unwrap().push(format!("LITERAL:{}", String::from_utf8_lossy(&buf[..n])));
            write!(w, "{tag} OK appended\r\n").unwrap();
          }
          "LOGOUT" => {
            write!(w, "* BYE\r\n{tag} OK bye\r\n").unwrap();
            return;
          }
          _ => write!(w, "{tag} BAD unknown\r\n").unwrap(),
        }
      }
    })
  }

  fn cmd(c: &str) -> ImapCmd {
    ImapCmd { command: c.into(), literal: None }
  }

  #[test]
  fn imap_logs_in_runs_commands_on_one_connection_and_reads_literals() {
    let log = Arc::new(Mutex::new(vec![]));
    let port = imap_server(log.clone());
    let out = imap_session(plain(port), &pw("me@example.org", "app-pass-1"), &[cmd("SELECT \"INBOX\""), cmd("UID FETCH 5 (BODY.PEEK[])")]).unwrap();
    assert!(out[0].contains("UIDVALIDITY 77") && out[0].contains("A2 OK"));
    assert!(out[1].contains("hello\r\nworld") && out[1].contains("A3 OK"), "literal bytes are kept: {:?}", out[1]);
    let l = log.lock().unwrap();
    assert!(l[0].starts_with("A1 LOGIN"));
    assert!(l.iter().any(|x| x.starts_with("A4 LOGOUT")));
  }

  #[test]
  fn imap_append_sends_the_literal_after_the_continuation() {
    let log = Arc::new(Mutex::new(vec![]));
    let port = imap_server(log.clone());
    let c = ImapCmd { command: "APPEND \"Drafts\" (\\Draft)".into(), literal: Some("Subject: hi\r\n\r\nbody".into()) };
    imap_session(plain(port), &pw("me@example.org", "app-pass-1"), &[c]).unwrap();
    assert!(log.lock().unwrap().iter().any(|x| x == "LITERAL:Subject: hi\r\n\r\nbody"));
  }

  #[test]
  fn imap_bad_password_is_a_sign_in_error_that_never_echoes_the_password() {
    let port = imap_server(Arc::new(Mutex::new(vec![])));
    let e = imap_session(plain(port), &pw("me@example.org", "wrong-secret-xyz"), &[cmd("NOOP")]).unwrap_err();
    assert!(e.starts_with("sign_in_failed:"), "{e}");
    assert!(!e.contains("wrong-secret-xyz"));
  }

  #[test]
  fn imap_oauth_uses_authenticate_xoauth2_and_never_login() {
    let log = Arc::new(Mutex::new(vec![]));
    let port = imap_server(log.clone());
    imap_session(plain(port), &Cred { user: "me@example.org".into(), secret: Secret::Token("tok-1".into()) }, &[cmd("NOOP")]).ok();
    let l = log.lock().unwrap();
    assert!(l[0].starts_with("A1 AUTHENTICATE XOAUTH2 "));
    let blob = B64.decode(l[0].trim_start_matches("A1 AUTHENTICATE XOAUTH2 ")).unwrap();
    assert_eq!(blob, b"user=me@example.org\x01auth=Bearer tok-1\x01\x01");
    assert!(!l.iter().any(|x| x.contains("LOGIN")));
  }

  #[test]
  fn the_page_cannot_send_login_starttls_or_multi_line_commands() {
    for bad in ["LOGIN a b", "AUTHENTICATE PLAIN", "STARTTLS", "LOGOUT", "DELETE \"INBOX\"", "SELECT INBOX\r\nA9 LOGIN a b", "UID COPYX 1 x", "UID", "", "SELECT a\0b"] {
      assert!(check_command(&cmd(bad)).is_err(), "should refuse {bad:?}");
    }
    for ok in ["select \"INBOX\"", "UID FETCH 1:* (FLAGS)", "UID STORE 3 +FLAGS (\\Seen)", "LIST \"\" \"*\"", "UID MOVE 4 \"Archive\""] {
      assert!(check_command(&cmd(ok)).is_ok(), "should allow {ok:?}");
    }
    assert!(check_command(&ImapCmd { command: "SELECT x".into(), literal: Some("data".into()) }).is_err());
  }

  #[test]
  fn imap_refuses_to_start_when_the_server_is_not_imap() {
    let port = serve(|mut s| {
      s.write_all(b"HTTP/1.1 200 OK\r\n").ok();
    });
    assert!(imap_session(plain(port), &pw("a@b.c", "p"), &[cmd("NOOP")]).is_err());
  }

  #[test]
  fn smtp_authenticates_sends_recipients_and_dot_stuffs() {
    let got = Arc::new(Mutex::new(vec![]));
    let g = got.clone();
    let port = serve(move |s| {
      let mut w = s.try_clone().unwrap();
      let mut r = BufReader::new(s);
      w.write_all(b"220 fake smtp\r\n").unwrap();
      loop {
        let l = read_line(&mut r);
        if l.is_empty() {
          return;
        }
        let t = l.trim_end().to_string();
        g.lock().unwrap().push(t.clone());
        if t.starts_with("EHLO") {
          w.write_all(b"250-fake\r\n250 AUTH PLAIN XOAUTH2\r\n").unwrap();
        } else if t.starts_with("AUTH") {
          w.write_all(b"235 ok\r\n").unwrap();
        } else if t.starts_with("MAIL") || t.starts_with("RCPT") {
          w.write_all(b"250 ok\r\n").unwrap();
        } else if t == "DATA" {
          w.write_all(b"354 go\r\n").unwrap();
          loop {
            let d = read_line(&mut r);
            g.lock().unwrap().push(format!("D:{}", d.trim_end()));
            if d == ".\r\n" {
              break;
            }
          }
          w.write_all(b"250 queued\r\n").unwrap();
        } else if t == "QUIT" {
          return;
        }
      }
    });
    smtp_session(plain(port), &pw("me@example.org", "app-pass-1"), "me@example.org", &["a@example.com".into(), "hidden@example.com".into()], "Subject: x\n\n.dot line\nplain").unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let g = got.lock().unwrap();
    assert!(g.iter().any(|x| x == &format!("AUTH PLAIN {}", B64.encode("\0me@example.org\0app-pass-1"))));
    assert!(g.contains(&"MAIL FROM:<me@example.org>".to_string()));
    assert!(g.contains(&"RCPT TO:<a@example.com>".to_string()) && g.contains(&"RCPT TO:<hidden@example.com>".to_string()));
    assert!(g.contains(&"D:..dot line".to_string()), "leading dot doubled: {g:?}");
    assert!(g.contains(&"D:Subject: x".to_string()) && g.contains(&"D:.".to_string()));
  }

  #[test]
  fn smtp_refuses_bad_addresses_before_connecting() {
    for bad in ["a b@example.com", "a@example.com>\r\nRCPT TO:<x@y.z", "noat"] {
      assert!(smtp_addr(bad).is_err(), "{bad:?}");
    }
    assert!(smtp_addr("ok@example.com").is_ok());
    assert_eq!(dot_stuff("a\r\n.b\r\n"), "a\r\n..b\r\n");
  }

  #[test]
  fn the_server_must_be_registered_for_the_account_and_on_the_tls_port() {
    let s = ServerCfg { host: "imap.fastmail.com".into(), port: 993 };
    assert!(check_server("acct-h6a", &s, IMAP_PORT).unwrap_err().starts_with("host_rejected"));
    mail_net::mail_register_host("acct-h6a".into(), "imap.fastmail.com".into()).unwrap();
    assert!(check_server("acct-h6a", &s, IMAP_PORT).is_ok());
    assert!(check_server("acct-other", &s, IMAP_PORT).is_err(), "another account may not use it");
    assert!(check_server("acct-h6a", &ServerCfg { host: "imap.fastmail.com".into(), port: 143 }, IMAP_PORT).is_err(), "no plaintext port");
    assert!(check_server("acct-h6a", &ServerCfg { host: "evil.example.net".into(), port: 993 }, IMAP_PORT).is_err());
    assert!(mail_net::mail_register_host("acct-h6a".into(), "127.0.0.1".into()).is_err(), "no IP literals");
  }

  #[test]
  fn tls_is_required_a_plaintext_server_fails_the_handshake() {
    let port = serve(|mut s| {
      let _ = s.write_all(b"* OK plaintext imap\r\n");
      std::thread::sleep(Duration::from_millis(300));
    });
    let r = tls_connect("127.0.0.1", port).and_then(|c| Imap::open(c).map(|_| ()));
    assert!(r.is_err(), "a plaintext greeting must never be accepted");
  }

  #[test]
  fn app_passwords_are_reserved_from_the_page() {
    assert!(crate::mail_keychain::secret_get_impl_for_page(&format!("{PASSWORD_PREFIX}acct")).is_err());
  }
}
