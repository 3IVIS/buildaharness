//! Read-only reader for Apple Mail's local store (plans/aielia_email_capabilities_plan.html, phase D1).
//!
//! Apple Mail keeps what it has downloaded in `~/Library/Mail/V10`: an SQLite database (`MailData/Envelope Index`) with one row per
//! message, and one `.emlx` file per message body. This module lets the app list and read that mail without a second sign-in.
//!
//! Rules this file keeps, each covered by a test:
//!  - NEVER writes under the Mail folder. The database and its write-ahead log are copied into a private snapshot folder and only the
//!    copy is opened, so Mail running, its journal files and our reads cannot interfere. `.emlx` files are only ever read.
//!  - The webview cannot pass a path or an SQL string: every command takes structured values, the Mail root is found here, and message
//!    bodies are located from the database, not from the caller.
//!  - A refused permission, a missing store and a layout this code does not know each come back as a short code
//!    (`permission_denied`, `not_found`, `unsupported_layout`, `unsupported_platform`) so the screen can say what to do.
//!  - Message text is never logged.
//!
//! The layout below was read from a real macOS 26 / Mail V10 store in phase D0 (schema and counts only, no content): `messages`
//! (ROWID, global_message_id, sender, subject_prefix, subject, date_sent, date_received (Unix seconds), mailbox, read, flagged, deleted,
//! flags, size, conversation_id), `subjects`, `addresses`, `recipients`, `mailboxes` (url like `imap://<account-uuid>/<path>`),
//! `message_global_data` (message_id_header). Bodies live at `<account>/<path>.mbox/<uuid>/Data/<d>/<d>/<d>/Messages/<ROWID>.emlx`
//! where the `<d>` are the digits of ROWID/1000 in reverse; a body Mail has not fully downloaded is `<ROWID>.partial.emlx`.

use base64::Engine;
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const E_PERMISSION: &str = "permission_denied";
const E_NOT_FOUND: &str = "not_found";
const E_LAYOUT: &str = "unsupported_layout";
#[cfg(not(target_os = "macos"))]
const E_PLATFORM: &str = "unsupported_platform";

/// The tables and columns the queries use. A store missing any of them is an unknown layout.
const REQUIRED: &[(&str, &[&str])] = &[
  ("messages", &["ROWID", "global_message_id", "sender", "subject_prefix", "subject", "date_sent", "date_received", "mailbox", "read", "flagged", "deleted", "flags", "size", "conversation_id"]),
  ("subjects", &["ROWID", "subject"]),
  ("addresses", &["ROWID", "address", "comment"]),
  ("recipients", &["message", "address", "type", "position"]),
  ("mailboxes", &["ROWID", "url", "total_count", "unread_count"]),
  ("message_global_data", &["ROWID", "message_id_header"]),
];

fn io_code(err: &std::io::Error) -> String {
  match err.kind() {
    std::io::ErrorKind::PermissionDenied => E_PERMISSION.to_string(),
    std::io::ErrorKind::NotFound => E_NOT_FOUND.to_string(),
    _ => format!("io: {}", err.kind()),
  }
}

fn sql_err(err: rusqlite::Error) -> String {
  // A permission failure inside SQLite surfaces as "unable to open database file" or "authorization denied".
  let t = err.to_string();
  if t.contains("unable to open") || t.contains("not authorized") || t.contains("authorization") {
    E_PERMISSION.to_string()
  } else {
    format!("sql: {t}")
  }
}

// ---------- locating and snapshotting ----------

/// The newest `V<n>` folder under `~/Library/Mail`, or `not_found`.
pub fn find_mail_root(library_mail: &Path) -> Result<PathBuf, String> {
  let entries = fs::read_dir(library_mail).map_err(|e| io_code(&e))?;
  let mut best: Option<(u32, PathBuf)> = None;
  for e in entries.flatten() {
    let name = e.file_name().to_string_lossy().to_string();
    if let Some(n) = name.strip_prefix('V').and_then(|d| d.parse::<u32>().ok()) {
      if e.path().join("MailData").join("Envelope Index").exists() && best.as_ref().map_or(true, |(b, _)| n > *b) {
        best = Some((n, e.path()));
      }
    }
  }
  best.map(|(_, p)| p).ok_or_else(|| E_NOT_FOUND.to_string())
}

fn mtime(p: &Path) -> Option<SystemTime> {
  fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// A private copy of the database and its write-ahead log. Refreshed only when the originals changed.
pub struct Snapshot {
  root: PathBuf,
  dir: PathBuf,
  key: Option<(Option<SystemTime>, Option<SystemTime>)>,
}

impl Snapshot {
  pub fn new(root: PathBuf, dir: PathBuf) -> Self {
    Self { root, dir, key: None }
  }

  fn db_path(&self) -> PathBuf {
    self.dir.join("EnvelopeIndex")
  }

  /// Copy `Envelope Index` and `Envelope Index-wal` (never the `-shm`: SQLite rebuilds it) into the private folder when either changed.
  pub fn refresh(&mut self) -> Result<PathBuf, String> {
    let data = self.root.join("MailData");
    let src_db = data.join("Envelope Index");
    let src_wal = data.join("Envelope Index-wal");
    let key = (mtime(&src_db), mtime(&src_wal));
    if self.key == Some(key) && self.db_path().exists() {
      return Ok(self.db_path());
    }
    if key.0.is_none() {
      // Distinguish "no such file" from "not allowed to look" by trying to open it.
      return Err(match fs::File::open(&src_db) {
        Err(e) => io_code(&e),
        Ok(_) => E_NOT_FOUND.to_string(),
      });
    }
    fs::create_dir_all(&self.dir).map_err(|e| io_code(&e))?;
    let dst_db = self.db_path();
    let dst_wal = self.dir.join("EnvelopeIndex-wal");
    let _ = fs::remove_file(self.dir.join("EnvelopeIndex-shm"));
    let _ = fs::remove_file(&dst_wal);
    fs::copy(&src_db, &dst_db).map_err(|e| io_code(&e))?;
    if src_wal.exists() {
      fs::copy(&src_wal, &dst_wal).map_err(|e| io_code(&e))?;
    }
    self.key = Some(key);
    Ok(dst_db)
  }

  /// Open the private copy. It is ours to open read-write (SQLite needs that to read a write-ahead log), but only reads are issued
  /// and `query_only` makes any other statement fail.
  pub fn open(&mut self) -> Result<Connection, String> {
    let path = self.refresh()?;
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX).map_err(sql_err)?;
    conn.execute_batch("PRAGMA query_only = 1;").map_err(sql_err)?;
    Ok(conn)
  }
}

fn check_layout(conn: &Connection) -> Result<(), String> {
  for (table, cols) in REQUIRED {
    let mut stmt = conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')")).map_err(sql_err)?;
    let have: Vec<String> = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(sql_err)?.flatten().collect();
    for c in *cols {
      if !have.iter().any(|h| h == c) {
        return Err(format!("{E_LAYOUT}: {table}.{c} is missing"));
      }
    }
  }
  Ok(())
}

// ---------- discovery ----------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountInfo {
  pub id: String,
  pub scheme: String,
  pub mailboxes: i64,
  pub messages: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
  pub available: bool,
  /// A short code when `available` is false: `unsupported_platform`, `not_found`, `permission_denied`, `unsupported_layout`.
  pub reason: Option<String>,
  pub layout: Option<String>,
  pub accounts: Vec<AccountInfo>,
  pub message_count: i64,
}

/// `imap://<account>/<path>` or `local://<account>/<path>`: the account id, the scheme and the decoded path segments.
pub fn parse_mailbox_url(url: &str) -> Option<(String, String, Vec<String>)> {
  let (scheme, rest) = url.split_once("://")?;
  let (account, path) = rest.split_once('/').unwrap_or((rest, ""));
  if account.is_empty() {
    return None;
  }
  let segments = path.split('/').filter(|s| !s.is_empty()).map(percent_decode).collect();
  Some((scheme.to_string(), percent_decode(account), segments))
}

fn percent_decode(s: &str) -> String {
  let b = s.as_bytes();
  let mut out = Vec::with_capacity(b.len());
  let mut i = 0;
  while i < b.len() {
    if b[i] == b'%' && i + 2 < b.len() {
      if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
        out.push(v);
        i += 3;
        continue;
      }
    }
    out.push(b[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).to_string()
}

pub fn discover(snap: &mut Snapshot, layout: &str) -> Discovery {
  let fail = |reason: String| Discovery { available: false, reason: Some(reason), layout: None, accounts: vec![], message_count: 0 };
  let conn = match snap.open() {
    Ok(c) => c,
    Err(e) => return fail(e),
  };
  if let Err(e) = check_layout(&conn) {
    return fail(e);
  }
  let mut by_account: Vec<AccountInfo> = Vec::new();
  let total: i64 = conn.query_row("SELECT COUNT(*) FROM messages WHERE deleted = 0", [], |r| r.get(0)).unwrap_or(0);
  if let Ok(mut stmt) = conn.prepare("SELECT url, total_count FROM mailboxes") {
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1).unwrap_or(0)))).map(|it| it.flatten().collect::<Vec<_>>()).unwrap_or_default();
    for (url, count) in rows {
      if let Some((scheme, account, _)) = parse_mailbox_url(&url) {
        match by_account.iter_mut().find(|a| a.id == account && a.scheme == scheme) {
          Some(a) => { a.mailboxes += 1; a.messages += count.max(0); }
          None => by_account.push(AccountInfo { id: account, scheme, mailboxes: 1, messages: count.max(0) }),
        }
      }
    }
  }
  by_account.sort_by(|a, b| b.messages.cmp(&a.messages).then(a.id.cmp(&b.id)));
  Discovery { available: true, reason: None, layout: Some(layout.to_string()), accounts: by_account, message_count: total }
}

// ---------- reads ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxRow {
  pub rowid: i64,
  pub account_id: String,
  pub scheme: String,
  /// Decoded path segments, e.g. ["INBOX"] or ["[Gmail]", "All Mail"].
  pub path: Vec<String>,
  pub total: i64,
  pub unread: i64,
}

pub fn mailboxes(conn: &Connection) -> Result<Vec<MailboxRow>, String> {
  let mut stmt = conn.prepare("SELECT ROWID, url, total_count, unread_count FROM mailboxes ORDER BY ROWID").map_err(sql_err)?;
  let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2).unwrap_or(0), r.get::<_, i64>(3).unwrap_or(0)))).map_err(sql_err)?;
  let mut out = Vec::new();
  for row in rows.flatten() {
    if let Some((scheme, account, path)) = parse_mailbox_url(&row.1) {
      out.push(MailboxRow { rowid: row.0, account_id: account, scheme, path, total: row.2, unread: row.3 });
    }
  }
  Ok(out)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageFilter {
  pub mailbox_ids: Option<Vec<i64>>,
  /// Only this conversation (Mail's own thread id), across every mailbox.
  pub conversation_id: Option<i64>,
  /// Unix seconds, inclusive / exclusive.
  pub since: Option<i64>,
  pub before: Option<i64>,
  /// Only rows with a ROWID above this (new mail since a state mark).
  pub after_rowid: Option<i64>,
  pub unread_only: Option<bool>,
  pub text: Option<String>,
  pub from: Option<String>,
  pub limit: Option<i64>,
  pub offset: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
  pub rowid: i64,
  pub message_id_header: Option<String>,
  pub conversation_id: i64,
  pub mailbox: i64,
  pub subject_prefix: Option<String>,
  pub subject: String,
  pub sender: Option<String>,
  pub sender_name: Option<String>,
  pub date_received: i64,
  pub date_sent: Option<i64>,
  pub read: bool,
  pub flagged: bool,
  pub deleted: bool,
  pub flags: i64,
  pub size: i64,
}

#[derive(Debug, Serialize)]
pub struct MessagePage {
  pub items: Vec<MessageRow>,
  pub total: i64,
}

fn like_escape(s: &str) -> String {
  s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

const MESSAGE_SELECT: &str = "SELECT m.ROWID, g.message_id_header, m.conversation_id, m.mailbox, m.subject_prefix, COALESCE(s.subject, ''), a.address, a.comment, \
  COALESCE(m.date_received, 0), m.date_sent, m.read, m.flagged, m.deleted, m.flags, m.size \
  FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject LEFT JOIN addresses a ON a.ROWID = m.sender LEFT JOIN message_global_data g ON g.ROWID = m.global_message_id";

pub fn messages(conn: &Connection, f: &MessageFilter) -> Result<MessagePage, String> {
  let mut wheres: Vec<String> = vec!["m.deleted = 0".into()];
  let mut args: Vec<SqlValue> = Vec::new();
  if let Some(ids) = &f.mailbox_ids {
    if ids.is_empty() {
      return Ok(MessagePage { items: vec![], total: 0 });
    }
    wheres.push(format!("m.mailbox IN ({})", ids.iter().map(|_| "?").collect::<Vec<_>>().join(",")));
    args.extend(ids.iter().map(|i| SqlValue::Integer(*i)));
  }
  if let Some(v) = f.conversation_id { wheres.push("m.conversation_id = ?".into()); args.push(SqlValue::Integer(v)); }
  if let Some(v) = f.since { wheres.push("m.date_received >= ?".into()); args.push(SqlValue::Integer(v)); }
  if let Some(v) = f.before { wheres.push("m.date_received < ?".into()); args.push(SqlValue::Integer(v)); }
  if let Some(v) = f.after_rowid { wheres.push("m.ROWID > ?".into()); args.push(SqlValue::Integer(v)); }
  if f.unread_only == Some(true) { wheres.push("m.read = 0".into()); }
  if let Some(t) = f.text.as_ref().filter(|t| !t.trim().is_empty()) {
    wheres.push("(s.subject LIKE ? ESCAPE '\\' OR a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')".into());
    let p = format!("%{}%", like_escape(t.trim()));
    args.extend([SqlValue::Text(p.clone()), SqlValue::Text(p.clone()), SqlValue::Text(p)]);
  }
  if let Some(t) = f.from.as_ref().filter(|t| !t.trim().is_empty()) {
    wheres.push("(a.address LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\')".into());
    let p = format!("%{}%", like_escape(t.trim()));
    args.extend([SqlValue::Text(p.clone()), SqlValue::Text(p)]);
  }
  let clause = wheres.join(" AND ");
  let total: i64 = conn
    .query_row(&format!("SELECT COUNT(*) FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject LEFT JOIN addresses a ON a.ROWID = m.sender WHERE {clause}"), params_from_iter(args.iter()), |r| r.get(0))
    .map_err(sql_err)?;
  let limit = f.limit.unwrap_or(100).clamp(1, 2000);
  let offset = f.offset.unwrap_or(0).max(0);
  let mut stmt = conn.prepare(&format!("{MESSAGE_SELECT} WHERE {clause} ORDER BY m.date_received DESC, m.ROWID DESC LIMIT {limit} OFFSET {offset}")).map_err(sql_err)?;
  let rows = stmt
    .query_map(params_from_iter(args.iter()), |r| {
      Ok(MessageRow {
        rowid: r.get(0)?, message_id_header: r.get(1)?, conversation_id: r.get(2)?, mailbox: r.get(3)?, subject_prefix: r.get(4)?, subject: r.get(5)?,
        sender: r.get(6)?, sender_name: r.get(7)?, date_received: r.get(8)?, date_sent: r.get(9)?, read: r.get::<_, i64>(10)? != 0,
        flagged: r.get::<_, i64>(11)? != 0, deleted: r.get::<_, i64>(12)? != 0, flags: r.get(13)?, size: r.get(14)?,
      })
    })
    .map_err(sql_err)?;
  Ok(MessagePage { items: rows.flatten().collect(), total })
}

/// One message by ROWID (deleted ones included, so a caller can see that it is gone).
pub fn message_by_rowid(conn: &Connection, rowid: i64) -> Result<Option<MessageRow>, String> {
  let mut stmt = conn.prepare(&format!("{MESSAGE_SELECT} WHERE m.ROWID = ?")).map_err(sql_err)?;
  let mut rows = stmt
    .query_map([rowid], |r| {
      Ok(MessageRow {
        rowid: r.get(0)?, message_id_header: r.get(1)?, conversation_id: r.get(2)?, mailbox: r.get(3)?, subject_prefix: r.get(4)?, subject: r.get(5)?,
        sender: r.get(6)?, sender_name: r.get(7)?, date_received: r.get(8)?, date_sent: r.get(9)?, read: r.get::<_, i64>(10)? != 0,
        flagged: r.get::<_, i64>(11)? != 0, deleted: r.get::<_, i64>(12)? != 0, flags: r.get(13)?, size: r.get(14)?,
      })
    })
    .map_err(sql_err)?;
  Ok(rows.next().and_then(|r| r.ok()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipientRow {
  pub message: i64,
  pub address: String,
  pub name: Option<String>,
  /// Mail's own code (0 is To, 1 is Cc in the stores read so far); the caller prefers the parsed headers.
  pub kind: i64,
  pub position: i64,
}

pub fn recipients(conn: &Connection, rowids: &[i64]) -> Result<Vec<RecipientRow>, String> {
  if rowids.is_empty() {
    return Ok(vec![]);
  }
  let marks = rowids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
  let mut stmt = conn
    .prepare(&format!("SELECT r.message, a.address, a.comment, r.type, r.position FROM recipients r JOIN addresses a ON a.ROWID = r.address WHERE r.message IN ({marks}) ORDER BY r.message, r.type, r.position"))
    .map_err(sql_err)?;
  let rows = stmt
    .query_map(params_from_iter(rowids.iter()), |r| Ok(RecipientRow { message: r.get(0)?, address: r.get(1)?, name: r.get(2)?, kind: r.get(3)?, position: r.get(4)? }))
    .map_err(sql_err)?;
  Ok(rows.flatten().collect())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StateMark {
  pub count: i64,
  pub max_rowid: i64,
  /// A cheap fingerprint of the mutable columns, so a changed flag, folder or deletion shows up without comparing every row.
  pub fingerprint: i64,
}

pub fn state(conn: &Connection) -> Result<StateMark, String> {
  conn
    .query_row(
      "SELECT COUNT(*), COALESCE(MAX(ROWID), 0), COALESCE(SUM((read + 1) * 3 + (flagged + 1) * 5 + (deleted + 1) * 7 + mailbox * 11), 0) FROM messages",
      [],
      |r| Ok(StateMark { count: r.get(0)?, max_rowid: r.get(1)?, fingerprint: r.get(2)? }),
    )
    .map_err(sql_err)
}

/// Per-message mutable state, for diffing two marks: (ROWID, read, flagged, deleted, mailbox).
pub fn states(conn: &Connection) -> Result<Vec<(i64, i64, i64, i64, i64)>, String> {
  let mut stmt = conn.prepare("SELECT ROWID, read, flagged, deleted, mailbox FROM messages ORDER BY ROWID").map_err(sql_err)?;
  let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(sql_err)?;
  Ok(rows.flatten().collect())
}

// ---------- bodies ----------

/// The `.emlx` format: a line with the byte length N, then N bytes of the RFC 822 message, then a property list we do not need.
pub fn parse_emlx(bytes: &[u8]) -> Result<Vec<u8>, String> {
  let nl = bytes.iter().position(|b| *b == b'\n').ok_or("emlx: no length line")?;
  let n: usize = std::str::from_utf8(&bytes[..nl]).map_err(|_| "emlx: bad length line")?.trim().parse().map_err(|_| "emlx: bad length")?;
  let start = nl + 1;
  let end = start.checked_add(n).ok_or("emlx: length overflow")?;
  if end > bytes.len() {
    return Err("emlx: shorter than its declared length".into());
  }
  Ok(bytes[start..end].to_vec())
}

/// Where Mail keeps the body of message `rowid` in the mailbox at `path_segments` of `account`. Only the database decides the inputs.
/// A name that is one plain path component: no separator, no NUL, not `.` or `..`. Anything else is refused outright.
fn safe_component(s: &str) -> bool {
  !s.is_empty() && s != "." && s != ".." && !s.contains('/') && !s.contains('\\') && !s.contains('\0')
}

pub fn body_candidates(root: &Path, account: &str, path_segments: &[String], rowid: i64) -> Vec<PathBuf> {
  if !safe_component(account) || !path_segments.iter().all(|s| safe_component(s)) {
    return Vec::new();
  }
  let mut dir = root.join(account);
  for seg in path_segments {
    dir = dir.join(format!("{seg}.mbox"));
  }
  let mut out = Vec::new();
  let Ok(rd) = fs::read_dir(&dir) else { return out };
  let mut uuids: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir() && p.join("Data").is_dir()).collect();
  uuids.sort();
  let thousands = rowid / 1000;
  let digits: Vec<String> = if thousands == 0 { vec![] } else { thousands.to_string().chars().rev().map(|c| c.to_string()).collect() };
  for u in uuids {
    let mut p = u.join("Data");
    for d in &digits {
      p = p.join(d);
    }
    p = p.join("Messages");
    out.push(p.join(format!("{rowid}.emlx")));
    out.push(p.join(format!("{rowid}.partial.emlx")));
  }
  out
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
  /// The RFC 822 message, base64.
  pub raw_base64: String,
  /// Mail has only headers (the body was not downloaded to this computer).
  pub partial: bool,
}

pub fn read_body(root: &Path, account: &str, path_segments: &[String], rowid: i64) -> Result<Body, String> {
  let mut denied = false;
  for c in body_candidates(root, account, path_segments, rowid) {
    match fs::read(&c) {
      Ok(bytes) => {
        let raw = parse_emlx(&bytes)?;
        let partial = c.file_name().map_or(false, |n| n.to_string_lossy().ends_with(".partial.emlx"));
        return Ok(Body { raw_base64: base64::engine::general_purpose::STANDARD.encode(raw), partial });
      }
      Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => denied = true,
      Err(_) => {}
    }
  }
  Err(if denied { E_PERMISSION.to_string() } else { "body_not_on_this_computer".to_string() })
}

// ---------- Tauri commands ----------

pub struct LocalMailState(Mutex<Option<Snapshot>>);
impl Default for LocalMailState {
  fn default() -> Self {
    Self(Mutex::new(None))
  }
}

#[cfg(target_os = "macos")]
fn library_mail() -> Result<PathBuf, String> {
  let home = std::env::var_os("HOME").ok_or_else(|| E_NOT_FOUND.to_string())?;
  Ok(PathBuf::from(home).join("Library").join("Mail"))
}

#[cfg(not(target_os = "macos"))]
fn library_mail() -> Result<PathBuf, String> {
  Err(E_PLATFORM.to_string())
}

fn with_snapshot<T>(app: &tauri::AppHandle, state: &LocalMailState, f: impl FnOnce(&mut Snapshot, &str) -> Result<T, String>) -> Result<T, String> {
  use tauri::Manager;
  let mut guard = state.0.lock().map_err(|_| "lock poisoned".to_string())?;
  if guard.is_none() {
    let root = find_mail_root(&library_mail()?)?;
    let dir = app.path().app_local_data_dir().map_err(|e| format!("path: {e}"))?.join("mail-local-snapshot");
    *guard = Some(Snapshot::new(root, dir));
  }
  let snap = guard.as_mut().expect("opened above");
  let layout = snap.root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
  f(snap, &layout)
}

#[tauri::command]
pub fn mail_local_discover(app: tauri::AppHandle, state: tauri::State<LocalMailState>) -> Discovery {
  let fail = |reason: String| Discovery { available: false, reason: Some(reason), layout: None, accounts: vec![], message_count: 0 };
  match with_snapshot(&app, &state, |s, layout| Ok(discover(s, layout))) {
    Ok(d) => d,
    Err(e) => fail(e),
  }
}

macro_rules! local_cmd {
  ($name:ident($($arg:ident: $ty:ty),*) -> $ret:ty, |$conn:ident, $snap:ident| $body:expr) => {
    #[tauri::command]
    pub fn $name(app: tauri::AppHandle, state: tauri::State<LocalMailState>, $($arg: $ty),*) -> Result<$ret, String> {
      with_snapshot(&app, &state, |$snap, _layout| {
        let $conn = $snap.open()?;
        check_layout(&$conn)?;
        $body
      })
    }
  };
}

local_cmd!(mail_local_mailboxes() -> Vec<MailboxRow>, |conn, _s| mailboxes(&conn));
local_cmd!(mail_local_messages(filter: MessageFilter) -> MessagePage, |conn, _s| messages(&conn, &filter));
local_cmd!(mail_local_message(rowid: i64) -> Option<MessageRow>, |conn, _s| message_by_rowid(&conn, rowid));
local_cmd!(mail_local_recipients(rowids: Vec<i64>) -> Vec<RecipientRow>, |conn, _s| recipients(&conn, &rowids));
local_cmd!(mail_local_state() -> StateMark, |conn, _s| state(&conn));
local_cmd!(mail_local_states() -> Vec<(i64, i64, i64, i64, i64)>, |conn, _s| states(&conn));

#[tauri::command]
pub fn mail_local_body(app: tauri::AppHandle, state: tauri::State<LocalMailState>, rowid: i64) -> Result<Body, String> {
  with_snapshot(&app, &state, |snap, _| {
    let conn = snap.open()?;
    let m = message_by_rowid(&conn, rowid)?.ok_or_else(|| "message_not_found".to_string())?;
    let boxes = mailboxes(&conn)?;
    let mb = boxes.iter().find(|b| b.rowid == m.mailbox).ok_or_else(|| "mailbox_not_found".to_string())?;
    read_body(&snap.root, &mb.account_id, &mb.path, rowid)
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU32, Ordering};

  static N: AtomicU32 = AtomicU32::new(0);
  fn tmp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("aielia-local-{}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst), name));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    p
  }

  const ACCT: &str = "11111111-2222-3333-4444-555555555555";

  /// A store in the shape read in phase D0: only the columns the reader uses, plus a few Mail has that it must ignore.
  fn fixture() -> (PathBuf, Connection) {
    let lib = tmp("lib");
    let root = lib.join("V10");
    fs::create_dir_all(root.join("MailData")).unwrap();
    let conn = Connection::open(root.join("MailData").join("Envelope Index")).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
    conn.execute_batch(
      "CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL DEFAULT 0, global_message_id INTEGER NOT NULL, remote_id INTEGER, sender INTEGER, subject_prefix TEXT, subject INTEGER NOT NULL, summary INTEGER, date_sent INTEGER, date_received INTEGER, mailbox INTEGER NOT NULL, flags INTEGER NOT NULL DEFAULT 0, read INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0, conversation_id INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
       CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
       CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message INTEGER, address INTEGER, type INTEGER, position INTEGER);
       CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT, total_count INTEGER, unread_count INTEGER);
       CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER, message_id_header TEXT);",
    )
    .unwrap();
    (lib, conn)
  }

  fn add_mailbox(c: &Connection, id: i64, url: &str, total: i64) {
    c.execute("INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, 0)", rusqlite::params![id, url, total]).unwrap();
  }
  fn add_msg(c: &Connection, rowid: i64, mailbox: i64, subject: &str, from: &str, name: &str, received: i64, read: i64, conv: i64) {
    c.execute("INSERT OR IGNORE INTO subjects (ROWID, subject) VALUES (?, ?)", rusqlite::params![rowid, subject]).unwrap();
    c.execute("INSERT OR IGNORE INTO addresses (ROWID, address, comment) VALUES (?, ?, ?)", rusqlite::params![rowid, from, name]).unwrap();
    c.execute("INSERT INTO message_global_data (ROWID, message_id, message_id_header) VALUES (?, ?, ?)", rusqlite::params![rowid, rowid, format!("<m{rowid}@example.net>")]).unwrap();
    c.execute(
      "INSERT INTO messages (ROWID, global_message_id, sender, subject_prefix, subject, date_received, date_sent, mailbox, read, conversation_id) VALUES (?, ?, ?, 'Re: ', ?, ?, ?, ?, ?, ?)",
      rusqlite::params![rowid, rowid, rowid, rowid, received, received - 5, mailbox, read, conv],
    )
    .unwrap();
  }
  fn write_emlx(root: &Path, mailbox_path: &[&str], rowid: i64, body: &str, partial: bool) {
    let mut dir = root.join(ACCT);
    for s in mailbox_path { dir = dir.join(format!("{s}.mbox")); }
    dir = dir.join("0A0A0A0A-0000-0000-0000-000000000000").join("Data");
    let thousands = rowid / 1000;
    if thousands > 0 { for d in thousands.to_string().chars().rev() { dir = dir.join(d.to_string()); } }
    dir = dir.join("Messages");
    fs::create_dir_all(&dir).unwrap();
    let name = if partial { format!("{rowid}.partial.emlx") } else { format!("{rowid}.emlx") };
    fs::write(dir.join(name), format!("{}\n{}<?xml version=\"1.0\"?><plist/>", body.len(), body)).unwrap();
  }

  fn open_store() -> (PathBuf, Snapshot, Connection) {
    let (lib, c) = fixture();
    add_mailbox(&c, 1, &format!("imap://{ACCT}/INBOX"), 3);
    add_mailbox(&c, 2, &format!("imap://{ACCT}/%5BGmail%5D/All%20Mail"), 1);
    add_mailbox(&c, 3, "local://AAAA/Notes", 0);
    add_msg(&c, 1, 1, "First", "ann@example.com", "Ann", 1_700_000_300, 0, 10);
    add_msg(&c, 2, 1, "Second_50%", "bob@example.com", "Bob", 1_700_000_200, 1, 11);
    add_msg(&c, 3, 1, "Third", "ann@example.com", "Ann", 1_700_000_100, 1, 10);
    add_msg(&c, 119_563, 2, "Old gmail", "carl@example.com", "Carl", 1_600_000_000, 1, 12);
    c.execute("UPDATE messages SET deleted = 1 WHERE ROWID = 3", []).unwrap();
    let root = lib.join("V10");
    let snap = Snapshot::new(root, tmp("snap"));
    (lib, snap, c)
  }

  #[test]
  fn finds_the_newest_layout_and_says_when_there_is_none() {
    let (lib, _s, _c) = open_store();
    fs::create_dir_all(lib.join("V9").join("MailData")).unwrap();
    fs::write(lib.join("V9").join("MailData").join("Envelope Index"), b"x").unwrap();
    assert!(find_mail_root(&lib).unwrap().ends_with("V10"));
    assert_eq!(find_mail_root(&tmp("empty")).unwrap_err(), E_NOT_FOUND);
    assert_eq!(find_mail_root(&tmp("nothere").join("x")).unwrap_err(), E_NOT_FOUND);
  }

  #[test]
  fn discovers_accounts_from_mailbox_urls() {
    let (_l, mut snap, _c) = open_store();
    let d = discover(&mut snap, "V10");
    assert!(d.available, "{:?}", d.reason);
    assert_eq!(d.layout.as_deref(), Some("V10"));
    assert_eq!(d.message_count, 3);
    assert_eq!(d.accounts.len(), 2);
    assert_eq!(d.accounts[0], AccountInfo { id: ACCT.into(), scheme: "imap".into(), mailboxes: 2, messages: 4 });
    assert_eq!(d.accounts[1].scheme, "local");
  }

  #[test]
  fn an_unknown_layout_and_a_missing_store_come_back_as_codes() {
    let lib = tmp("odd");
    let root = lib.join("V10");
    fs::create_dir_all(root.join("MailData")).unwrap();
    let c = Connection::open(root.join("MailData").join("Envelope Index")).unwrap();
    c.execute_batch("CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, subject INTEGER);").unwrap();
    drop(c);
    let mut snap = Snapshot::new(root, tmp("snap2"));
    let d = discover(&mut snap, "V10");
    assert!(!d.available);
    assert!(d.reason.unwrap().starts_with(E_LAYOUT));
    let mut gone = Snapshot::new(lib.join("nowhere"), tmp("snap3"));
    assert_eq!(discover(&mut gone, "V10").reason.as_deref(), Some(E_NOT_FOUND));
  }

  #[test]
  fn lists_mailboxes_with_decoded_paths() {
    let (_l, mut snap, _c) = open_store();
    let conn = snap.open().unwrap();
    let m = mailboxes(&conn).unwrap();
    assert_eq!(m[0].path, vec!["INBOX"]);
    assert_eq!(m[1].path, vec!["[Gmail]", "All Mail"]);
    assert_eq!(m[2].scheme, "local");
  }

  #[test]
  fn lists_messages_newest_first_without_deleted_ones_and_honours_the_window() {
    let (_l, mut snap, _c) = open_store();
    let conn = snap.open().unwrap();
    let all = messages(&conn, &MessageFilter::default()).unwrap();
    assert_eq!(all.total, 3);
    assert_eq!(all.items.iter().map(|m| m.rowid).collect::<Vec<_>>(), vec![1, 2, 119_563]);
    assert_eq!(all.items[0].message_id_header.as_deref(), Some("<m1@example.net>"));
    assert_eq!(all.items[0].sender.as_deref(), Some("ann@example.com"));
    assert_eq!(all.items[0].subject_prefix.as_deref(), Some("Re: "));
    let recent = messages(&conn, &MessageFilter { since: Some(1_700_000_000), ..Default::default() }).unwrap();
    assert_eq!(recent.total, 2);
    let page = messages(&conn, &MessageFilter { limit: Some(1), offset: Some(1), ..Default::default() }).unwrap();
    assert_eq!((page.items.len(), page.total, page.items[0].rowid), (1, 3, 2));
    let inbox = messages(&conn, &MessageFilter { mailbox_ids: Some(vec![1]), unread_only: Some(true), ..Default::default() }).unwrap();
    assert_eq!(inbox.items.iter().map(|m| m.rowid).collect::<Vec<_>>(), vec![1]);
    assert_eq!(messages(&conn, &MessageFilter { mailbox_ids: Some(vec![]), ..Default::default() }).unwrap().total, 0);
    assert_eq!(messages(&conn, &MessageFilter { after_rowid: Some(1), ..Default::default() }).unwrap().total, 2);
    let conv = messages(&conn, &MessageFilter { conversation_id: Some(10), ..Default::default() }).unwrap();
    assert_eq!(conv.items.iter().map(|m| m.rowid).collect::<Vec<_>>(), vec![1], "conversation 10 holds rows 1 and 3; 3 is deleted");
  }

  #[test]
  fn search_matches_subject_and_sender_and_treats_wildcards_literally() {
    let (_l, mut snap, _c) = open_store();
    let conn = snap.open().unwrap();
    let by = |text: Option<&str>, from: Option<&str>| messages(&conn, &MessageFilter { text: text.map(String::from), from: from.map(String::from), ..Default::default() }).unwrap().total;
    assert_eq!(by(Some("second"), None), 1);
    assert_eq!(by(None, Some("ann")), 1);
    assert_eq!(by(Some("50%"), None), 1);
    assert_eq!(by(Some("%"), None), 1, "a percent sign is a character, not a wildcard");
    assert_eq!(by(Some("_"), None), 1);
    assert_eq!(by(Some("zzz"), None), 0);
  }

  #[test]
  fn recipients_and_state_marks() {
    let (_l, mut snap, c) = open_store();
    c.execute("INSERT INTO addresses (ROWID, address, comment) VALUES (900, 'to@example.org', 'To Person')", []).unwrap();
    c.execute("INSERT INTO recipients (message, address, type, position) VALUES (1, 900, 0, 0)", []).unwrap();
    let conn = snap.open().unwrap();
    let r = recipients(&conn, &[1, 2]).unwrap();
    assert_eq!((r.len(), r[0].address.as_str(), r[0].kind), (1, "to@example.org", 0));
    assert!(recipients(&conn, &[]).unwrap().is_empty());
    let before = state(&conn).unwrap();
    assert_eq!((before.count, before.max_rowid), (4, 119_563));
    drop(conn);
    c.execute("UPDATE messages SET read = 1 WHERE ROWID = 1", []).unwrap();
    let conn = snap.open().unwrap();
    let after = state(&conn).unwrap();
    assert_ne!(before.fingerprint, after.fingerprint, "a read flag changes the fingerprint");
    assert_eq!(states(&conn).unwrap().len(), 4);
  }

  #[test]
  fn the_snapshot_sees_rows_that_are_only_in_the_write_ahead_log() {
    let (lib, mut snap, c) = open_store();
    // `c` is still open in WAL mode, so these rows are in the -wal file, not yet in the main file.
    assert!(lib.join("V10").join("MailData").join("Envelope Index-wal").exists());
    add_msg(&c, 7, 1, "Only in the log", "log@example.com", "Log", 1_700_000_900, 0, 20);
    let conn = snap.open().unwrap();
    assert!(messages(&conn, &MessageFilter::default()).unwrap().items.iter().any(|m| m.rowid == 7));
    drop(conn);
    // A change in Mail is picked up by the next open.
    add_msg(&c, 8, 1, "Later", "later@example.com", "Later", 1_700_001_000, 0, 21);
    std::thread::sleep(std::time::Duration::from_millis(30));
    let conn = snap.open().unwrap();
    assert!(messages(&conn, &MessageFilter::default()).unwrap().items.iter().any(|m| m.rowid == 8));
  }

  fn hash_tree(dir: &Path) -> Vec<(String, u64, Vec<u8>)> {
    let mut out = Vec::new();
    fn walk(d: &Path, root: &Path, out: &mut Vec<(String, u64, Vec<u8>)>) {
      for e in fs::read_dir(d).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() { walk(&p, root, out); } else {
          let b = fs::read(&p).unwrap();
          out.push((p.strip_prefix(root).unwrap().to_string_lossy().to_string(), b.len() as u64, b));
        }
      }
    }
    walk(dir, dir, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
  }

  #[test]
  fn reading_never_changes_anything_under_the_mail_folder() {
    let (lib, mut snap, c) = open_store();
    write_emlx(&lib.join("V10"), &["INBOX"], 1, "Subject: x\r\n\r\nbody", false);
    c.execute_batch("PRAGMA wal_checkpoint(FULL);").ok();
    let before = hash_tree(&lib);
    for _ in 0..3 {
      let conn = snap.open().unwrap();
      discover(&mut snap, "V10");
      let _ = messages(&conn, &MessageFilter::default()).unwrap();
      let _ = mailboxes(&conn).unwrap();
      let _ = recipients(&conn, &[1]).unwrap();
      let _ = state(&conn).unwrap();
      let _ = read_body(&lib.join("V10"), ACCT, &["INBOX".to_string()], 1).unwrap();
      // Any statement that is not a read is refused on the copy.
      assert!(conn.execute("DELETE FROM messages", []).is_err());
    }
    assert_eq!(hash_tree(&lib), before, "the Mail folder must be byte-for-byte unchanged by reads");
  }

  #[test]
  fn emlx_parsing_takes_exactly_the_declared_length() {
    let raw = b"123\nSubject: hi\r\n\r\nbody<plist>ignored</plist>";
    assert!(parse_emlx(raw).is_err(), "declared 123 bytes, fewer present");
    let ok = b"19\nSubject: hi\r\n\r\nbodyEXTRA";
    assert_eq!(parse_emlx(ok).unwrap(), b"Subject: hi\r\n\r\nbody".to_vec());
    assert!(parse_emlx(b"no newline").is_err());
    assert!(parse_emlx(b"abc\nx").is_err());
    assert!(parse_emlx(b"18446744073709551615\nx").is_err());
  }

  #[test]
  fn finds_bodies_by_the_reversed_digit_path_and_flags_partial_ones() {
    let (lib, _s, _c) = open_store();
    let root = lib.join("V10");
    write_emlx(&root, &["INBOX"], 1, "Subject: small\r\n\r\nbody one", false);
    write_emlx(&root, &["[Gmail]", "All Mail"], 119_563, "Subject: big\r\n\r\nbody two", false);
    write_emlx(&root, &["INBOX"], 2, "Subject: head only\r\n\r\n", true);
    let a = read_body(&root, ACCT, &["INBOX".to_string()], 1).unwrap();
    assert!(!a.partial);
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(a.raw_base64).unwrap(), b"Subject: small\r\n\r\nbody one");
    let b = read_body(&root, ACCT, &["[Gmail]".to_string(), "All Mail".to_string()], 119_563).unwrap();
    assert!(!b.partial);
    assert!(root.join(ACCT).join("[Gmail].mbox").join("All Mail.mbox").join("0A0A0A0A-0000-0000-0000-000000000000").join("Data").join("9").join("1").join("1").join("Messages").join("119563.emlx").exists());
    assert!(read_body(&root, ACCT, &["INBOX".to_string()], 2).unwrap().partial);
    assert_eq!(read_body(&root, ACCT, &["INBOX".to_string()], 99).unwrap_err(), "body_not_on_this_computer");
    assert_eq!(read_body(&root, "no-such-account", &["INBOX".to_string()], 1).unwrap_err(), "body_not_on_this_computer");
  }

  #[test]
  fn a_hostile_mailbox_url_cannot_point_a_read_outside_the_mail_folder() {
    let (lib, _s, _c) = open_store();
    let root = lib.join("V10");
    for bad in ["..", ".", "a/b", "..\\x", ""] {
      assert!(body_candidates(&root, ACCT, &[bad.to_string()], 1).is_empty(), "segment {bad:?}");
      assert!(body_candidates(&root, bad, &["INBOX".to_string()], 1).is_empty(), "account {bad:?}");
    }
    // A percent-encoded separator decodes to a slash and is then refused the same way.
    let (_, account, segs) = parse_mailbox_url("imap://ACCT/%2E%2E%2F%2E%2E%2Fetc").unwrap();
    assert!(body_candidates(&root, &account, &segs, 1).is_empty());
    assert_eq!(read_body(&root, ACCT, &["..".to_string()], 1).unwrap_err(), "body_not_on_this_computer");
  }

  #[test]
  fn percent_decoding_and_urls() {
    assert_eq!(percent_decode("%5BGmail%5D/All%20Mail"), "[Gmail]/All Mail");
    assert_eq!(percent_decode("100%"), "100%");
    assert_eq!(percent_decode("%zz"), "%zz");
    assert_eq!(parse_mailbox_url("imap://A-B/INBOX").unwrap(), ("imap".into(), "A-B".into(), vec!["INBOX".to_string()]));
    assert_eq!(parse_mailbox_url("local://X").unwrap().2.len(), 0);
    assert!(parse_mailbox_url("nonsense").is_none());
    assert!(parse_mailbox_url("imap:///x").is_none());
  }

  /// Run by hand on a Mac with `AIELIA_REAL_MAIL_SMOKE=1 cargo test real_store -- --ignored --nocapture`. Prints counts and layout checks only, never message content.
  #[test]
  #[ignore]
  fn real_store_smoke_counts_only() {
    if std::env::var("AIELIA_REAL_MAIL_SMOKE").is_err() { return; }
    let lib = PathBuf::from(std::env::var("HOME").unwrap()).join("Library").join("Mail");
    let root = find_mail_root(&lib).expect("a Mail store");
    let mut snap = Snapshot::new(root.clone(), tmp("real-snap"));
    let d = discover(&mut snap, "V");
    println!("available={} reason={:?} accounts={} messages={}", d.available, d.reason, d.accounts.len(), d.message_count);
    assert!(d.available);
    let conn = snap.open().unwrap();
    let boxes = mailboxes(&conn).unwrap();
    let page = messages(&conn, &MessageFilter { limit: Some(200), ..Default::default() }).unwrap();
    let mut bodies = 0; let mut partial = 0; let mut missing = 0;
    for m in &page.items {
      if let Some(b) = boxes.iter().find(|b| b.rowid == m.mailbox) {
        match read_body(&root, &b.account_id, &b.path, m.rowid) { Ok(x) => { bodies += 1; if x.partial { partial += 1; } } Err(_) => missing += 1 }
      }
    }
    println!("mailboxes={} listed={} total={} bodies_read={} partial={} missing={}", boxes.len(), page.items.len(), page.total, bodies, partial, missing);
    let st = state(&conn).unwrap();
    println!("state count={} max_rowid={}", st.count, st.max_rowid);
    assert!(bodies > 0);
  }
}
