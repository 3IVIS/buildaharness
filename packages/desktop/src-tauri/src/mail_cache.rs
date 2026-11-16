//! Local mailbox cache on SQLite (phase R3). Same semantics as the TypeScript `EmailCache` interface
//! (`packages/aielia/src/email/cache.ts`): upsert and delete, filtered windows over a newest-first view
//! (ties broken by ascending id) with the whole-view total, a per-account sync token, and `clear_account`.
//! Records are stored as JSON next to the columns the queries need. No network, no tokens, no message-body logging.

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::Manager;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS folders_account ON folders(account_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, thread_id TEXT NOT NULL, sender TEXT NOT NULL, date TEXT NOT NULL,
  is_read INTEGER NOT NULL, starred INTEGER NOT NULL, draft INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_date ON messages(date DESC, id ASC);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, date DESC, id ASC);
CREATE INDEX IF NOT EXISTS messages_sender ON messages(sender, date DESC, id ASC);
CREATE INDEX IF NOT EXISTS messages_account ON messages(account_id);
CREATE TABLE IF NOT EXISTS message_folders (
  folder_id TEXT NOT NULL, msg_id TEXT NOT NULL, PRIMARY KEY (folder_id, msg_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_folders_msg ON message_folders(msg_id);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, last_at TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS threads_last ON threads(last_at DESC, id ASC);
CREATE TABLE IF NOT EXISTS thread_folders (
  folder_id TEXT NOT NULL, thread_id TEXT NOT NULL, PRIMARY KEY (folder_id, thread_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS thread_folders_thread ON thread_folders(thread_id);
CREATE TABLE IF NOT EXISTS sync_tokens (account_id TEXT PRIMARY KEY, token TEXT NOT NULL);
";

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageQuery {
  pub folder_id: Option<String>,
  pub sender: Option<String>,
  pub thread_id: Option<String>,
  pub read: Option<bool>,
  pub starred: Option<bool>,
  pub draft: Option<bool>,
  pub since: Option<String>,
  pub before: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WindowResult {
  pub items: Vec<Value>,
  pub total: i64,
}

pub struct MailCache {
  conn: Connection,
}

fn s(v: &Value, path: &[&str]) -> Result<String, String> {
  let mut cur = v;
  for p in path {
    cur = cur.get(*p).ok_or_else(|| format!("record is missing {}", path.join(".")))?;
  }
  cur.as_str().map(str::to_string).ok_or_else(|| format!("{} is not a string", path.join(".")))
}
fn b(v: &Value, path: &[&str]) -> bool {
  let mut cur = v;
  for p in path {
    match cur.get(*p) {
      Some(n) => cur = n,
      None => return false,
    }
  }
  cur.as_bool().unwrap_or(false)
}
fn folder_ids(v: &Value) -> Vec<String> {
  v.get("folderIds")
    .and_then(Value::as_array)
    .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
    .unwrap_or_default()
}
fn e(err: rusqlite::Error) -> String {
  format!("cache error: {err}")
}
fn clamp(n: i64) -> i64 {
  n.max(0)
}

impl MailCache {
  pub fn open(path: &std::path::Path) -> Result<Self, String> {
    if let Some(dir) = path.parent() {
      std::fs::create_dir_all(dir).map_err(|err| format!("cache dir: {err}"))?;
    }
    Self::init(Connection::open(path).map_err(e)?)
  }
  #[cfg(test)]
  pub fn open_in_memory() -> Result<Self, String> {
    Self::init(Connection::open_in_memory().map_err(e)?)
  }
  fn init(conn: Connection) -> Result<Self, String> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;").ok();
    conn.execute_batch(SCHEMA).map_err(e)?;
    Ok(Self { conn })
  }

  pub fn upsert_folders(&mut self, folders: &[Value]) -> Result<(), String> {
    let tx = self.conn.transaction().map_err(e)?;
    for f in folders {
      tx.execute(
        "INSERT OR REPLACE INTO folders (id, account_id, json) VALUES (?1, ?2, ?3)",
        (s(f, &["id"])?, s(f, &["accountId"])?, f.to_string()),
      )
      .map_err(e)?;
    }
    tx.commit().map_err(e)
  }

  pub fn upsert_threads(&mut self, threads: &[Value]) -> Result<(), String> {
    let tx = self.conn.transaction().map_err(e)?;
    for t in threads {
      let id = s(t, &["id"])?;
      tx.execute("DELETE FROM thread_folders WHERE thread_id = ?1", [&id]).map_err(e)?;
      tx.execute(
        "INSERT OR REPLACE INTO threads (id, account_id, last_at, json) VALUES (?1, ?2, ?3, ?4)",
        (&id, s(t, &["accountId"])?, s(t, &["lastMessageAt"])?, t.to_string()),
      )
      .map_err(e)?;
      for f in folder_ids(t) {
        tx.execute("INSERT OR IGNORE INTO thread_folders (folder_id, thread_id) VALUES (?1, ?2)", (&f, &id)).map_err(e)?;
      }
    }
    tx.commit().map_err(e)
  }

  pub fn upsert_messages(&mut self, messages: &[Value]) -> Result<(), String> {
    let tx = self.conn.transaction().map_err(e)?;
    for m in messages {
      let id = s(m, &["id"])?;
      tx.execute("DELETE FROM message_folders WHERE msg_id = ?1", [&id]).map_err(e)?;
      tx.execute(
        "INSERT OR REPLACE INTO messages (id, account_id, thread_id, sender, date, is_read, starred, draft, json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        (
          &id,
          s(m, &["accountId"])?,
          s(m, &["threadId"])?,
          s(m, &["from", "address"])?.to_lowercase(),
          s(m, &["date"])?,
          b(m, &["flags", "read"]),
          b(m, &["flags", "starred"]),
          b(m, &["flags", "draft"]),
          m.to_string(),
        ),
      )
      .map_err(e)?;
      for f in folder_ids(m) {
        tx.execute("INSERT OR IGNORE INTO message_folders (folder_id, msg_id) VALUES (?1, ?2)", (&f, &id)).map_err(e)?;
      }
    }
    tx.commit().map_err(e)
  }

  pub fn delete_messages(&mut self, ids: &[String]) -> Result<(), String> {
    let tx = self.conn.transaction().map_err(e)?;
    for id in ids {
      tx.execute("DELETE FROM message_folders WHERE msg_id = ?1", [id]).map_err(e)?;
      tx.execute("DELETE FROM messages WHERE id = ?1", [id]).map_err(e)?;
    }
    tx.commit().map_err(e)
  }

  pub fn delete_threads(&mut self, ids: &[String]) -> Result<(), String> {
    let tx = self.conn.transaction().map_err(e)?;
    for id in ids {
      tx.execute("DELETE FROM thread_folders WHERE thread_id = ?1", [id]).map_err(e)?;
      tx.execute("DELETE FROM threads WHERE id = ?1", [id]).map_err(e)?;
    }
    tx.commit().map_err(e)
  }

  fn parse(text: String) -> Result<Value, String> {
    serde_json::from_str(&text).map_err(|err| format!("cache row is not JSON: {err}"))
  }

  pub fn get_folders(&self, account_id: &str) -> Result<Vec<Value>, String> {
    let mut st = self.conn.prepare("SELECT json FROM folders WHERE account_id = ?1 ORDER BY rowid").map_err(e)?;
    let rows = st.query_map([account_id], |r| r.get::<_, String>(0)).map_err(e)?;
    rows.map(|r| Self::parse(r.map_err(e)?)).collect()
  }

  fn get_one(&self, table: &str, id: &str) -> Result<Option<Value>, String> {
    let text: Option<String> = self
      .conn
      .query_row(&format!("SELECT json FROM {table} WHERE id = ?1"), [id], |r| r.get(0))
      .optional()
      .map_err(e)?;
    text.map(Self::parse).transpose()
  }
  pub fn get_message(&self, id: &str) -> Result<Option<Value>, String> {
    self.get_one("messages", id)
  }
  pub fn get_thread(&self, id: &str) -> Result<Option<Value>, String> {
    self.get_one("threads", id)
  }

  pub fn query_messages(&self, q: &MessageQuery, offset: i64, limit: i64) -> Result<WindowResult, String> {
    let mut from = String::from("messages m");
    let mut conds: Vec<String> = Vec::new();
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(f) = &q.folder_id {
      from.push_str(" JOIN message_folders mf ON mf.msg_id = m.id");
      conds.push("mf.folder_id = ?".into());
      args.push(f.clone().into());
    }
    if let Some(t) = &q.thread_id {
      conds.push("m.thread_id = ?".into());
      args.push(t.clone().into());
    }
    if let Some(x) = &q.sender {
      conds.push("m.sender = ?".into());
      args.push(x.to_lowercase().into());
    }
    for (col, v) in [("is_read", q.read), ("starred", q.starred), ("draft", q.draft)] {
      if let Some(v) = v {
        conds.push(format!("m.{col} = ?"));
        args.push(i64::from(v).into());
      }
    }
    if let Some(x) = &q.since {
      conds.push("m.date >= ?".into());
      args.push(x.clone().into());
    }
    if let Some(x) = &q.before {
      conds.push("m.date < ?".into());
      args.push(x.clone().into());
    }
    let wh = if conds.is_empty() { String::new() } else { format!(" WHERE {}", conds.join(" AND ")) };
    let total: i64 = self
      .conn
      .query_row(&format!("SELECT COUNT(*) FROM {from}{wh}"), params_from_iter(args.iter()), |r| r.get(0))
      .map_err(e)?;
    args.push(clamp(limit).into());
    args.push(clamp(offset).into());
    let mut st = self
      .conn
      .prepare(&format!("SELECT m.json FROM {from}{wh} ORDER BY m.date DESC, m.id ASC LIMIT ? OFFSET ?"))
      .map_err(e)?;
    let rows = st.query_map(params_from_iter(args.iter()), |r| r.get::<_, String>(0)).map_err(e)?;
    let items = rows.map(|r| Self::parse(r.map_err(e)?)).collect::<Result<Vec<_>, _>>()?;
    Ok(WindowResult { items, total })
  }

  pub fn list_threads(&self, folder_id: Option<&str>, offset: i64, limit: i64) -> Result<WindowResult, String> {
    let (from, wh, mut args): (&str, &str, Vec<SqlValue>) = match folder_id {
      Some(f) => ("threads t JOIN thread_folders tf ON tf.thread_id = t.id", " WHERE tf.folder_id = ?", vec![f.to_string().into()]),
      None => ("threads t", "", vec![]),
    };
    let total: i64 = self
      .conn
      .query_row(&format!("SELECT COUNT(*) FROM {from}{wh}"), params_from_iter(args.iter()), |r| r.get(0))
      .map_err(e)?;
    args.push(clamp(limit).into());
    args.push(clamp(offset).into());
    let mut st = self
      .conn
      .prepare(&format!("SELECT t.json FROM {from}{wh} ORDER BY t.last_at DESC, t.id ASC LIMIT ? OFFSET ?"))
      .map_err(e)?;
    let rows = st.query_map(params_from_iter(args.iter()), |r| r.get::<_, String>(0)).map_err(e)?;
    let items = rows.map(|r| Self::parse(r.map_err(e)?)).collect::<Result<Vec<_>, _>>()?;
    Ok(WindowResult { items, total })
  }

  pub fn get_sync_token(&self, account_id: &str) -> Result<Option<String>, String> {
    self.conn.query_row("SELECT token FROM sync_tokens WHERE account_id = ?1", [account_id], |r| r.get(0)).optional().map_err(e)
  }
  pub fn set_sync_token(&mut self, account_id: &str, token: Option<&str>) -> Result<(), String> {
    match token {
      Some(t) => self.conn.execute("INSERT OR REPLACE INTO sync_tokens (account_id, token) VALUES (?1, ?2)", (account_id, t)),
      None => self.conn.execute("DELETE FROM sync_tokens WHERE account_id = ?1", [account_id]),
    }
    .map(|_| ())
    .map_err(e)
  }

  pub fn clear_account(&mut self, account_id: &str) -> Result<(), String> {
    let tx = self.conn.transaction().map_err(e)?;
    tx.execute("DELETE FROM message_folders WHERE msg_id IN (SELECT id FROM messages WHERE account_id = ?1)", [account_id]).map_err(e)?;
    tx.execute("DELETE FROM messages WHERE account_id = ?1", [account_id]).map_err(e)?;
    tx.execute("DELETE FROM thread_folders WHERE thread_id IN (SELECT id FROM threads WHERE account_id = ?1)", [account_id]).map_err(e)?;
    tx.execute("DELETE FROM threads WHERE account_id = ?1", [account_id]).map_err(e)?;
    tx.execute("DELETE FROM folders WHERE account_id = ?1", [account_id]).map_err(e)?;
    tx.execute("DELETE FROM sync_tokens WHERE account_id = ?1", [account_id]).map_err(e)?;
    tx.commit().map_err(e)
  }
}

// ---- Tauri commands: the page sends records and queries and gets records back; there are no credentials here. ----

#[derive(Default)]
pub struct MailCacheState(Mutex<Option<MailCache>>);

fn with_cache<T>(app: &tauri::AppHandle, state: &MailCacheState, f: impl FnOnce(&mut MailCache) -> Result<T, String>) -> Result<T, String> {
  let mut guard = state.0.lock().map_err(|_| "cache lock poisoned".to_string())?;
  if guard.is_none() {
    let dir = app.path().app_local_data_dir().map_err(|err| format!("cache path: {err}"))?;
    *guard = Some(MailCache::open(&dir.join("mail-cache.sqlite"))?);
  }
  f(guard.as_mut().expect("opened above"))
}

macro_rules! cmd {
  ($name:ident($($arg:ident: $ty:ty),*) -> $ret:ty, |$c:ident| $body:expr) => {
    #[tauri::command]
    pub fn $name(app: tauri::AppHandle, state: tauri::State<MailCacheState>, $($arg: $ty),*) -> Result<$ret, String> {
      with_cache(&app, &state, |$c| $body)
    }
  };
}

cmd!(mail_cache_upsert_folders(items: Vec<Value>) -> (), |c| c.upsert_folders(&items));
cmd!(mail_cache_upsert_threads(items: Vec<Value>) -> (), |c| c.upsert_threads(&items));
cmd!(mail_cache_upsert_messages(items: Vec<Value>) -> (), |c| c.upsert_messages(&items));
cmd!(mail_cache_delete_messages(ids: Vec<String>) -> (), |c| c.delete_messages(&ids));
cmd!(mail_cache_delete_threads(ids: Vec<String>) -> (), |c| c.delete_threads(&ids));
cmd!(mail_cache_get_folders(account_id: String) -> Vec<Value>, |c| c.get_folders(&account_id));
cmd!(mail_cache_get_message(id: String) -> Option<Value>, |c| c.get_message(&id));
cmd!(mail_cache_get_thread(id: String) -> Option<Value>, |c| c.get_thread(&id));
cmd!(mail_cache_query_messages(query: MessageQuery, offset: i64, limit: i64) -> WindowResult, |c| c.query_messages(&query, offset, limit));
cmd!(mail_cache_list_threads(folder_id: Option<String>, offset: i64, limit: i64) -> WindowResult, |c| c.list_threads(folder_id.as_deref(), offset, limit));
cmd!(mail_cache_get_sync_token(account_id: String) -> Option<String>, |c| c.get_sync_token(&account_id));
cmd!(mail_cache_set_sync_token(account_id: String, token: Option<String>) -> (), |c| c.set_sync_token(&account_id, token.as_deref()));
cmd!(mail_cache_clear_account(account_id: String) -> (), |c| c.clear_account(&account_id));

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn msg(n: u32, folders: &[&str], date: &str) -> Value {
    json!({"id": format!("m{n:06}"), "accountId": "a", "threadId": format!("t{}", n % 3), "folderIds": folders,
           "from": {"address": if n % 2 == 0 { "Even@Example.com" } else { "odd@example.com" }},
           "date": date, "flags": {"read": n % 2 == 0, "starred": n % 5 == 0, "draft": false}})
  }
  fn ids(r: &WindowResult) -> Vec<String> {
    r.items.iter().map(|m| m["id"].as_str().unwrap().to_string()).collect()
  }
  fn q() -> MessageQuery {
    MessageQuery::default()
  }

  #[test]
  fn newest_first_ties_by_id_and_window_total() {
    let mut c = MailCache::open_in_memory().unwrap();
    c.upsert_messages(&[msg(2, &["inbox"], "2026-01-02"), msg(1, &["inbox"], "2026-01-02"), msg(3, &["inbox"], "2026-01-03")]).unwrap();
    let r = c.query_messages(&q(), 0, 2).unwrap();
    assert_eq!(ids(&r), ["m000003", "m000001"]);
    assert_eq!(r.total, 3);
    assert_eq!(ids(&c.query_messages(&q(), 2, 10).unwrap()), ["m000002"]);
    assert_eq!(c.query_messages(&q(), -5, 1).unwrap().items.len(), 1);
  }

  #[test]
  fn filters_folder_sender_thread_flags_dates() {
    let mut c = MailCache::open_in_memory().unwrap();
    c.upsert_messages(&[
      msg(1, &["inbox"], "2026-01-01"),
      msg(2, &["inbox", "archive"], "2026-01-02"),
      msg(3, &["archive"], "2026-01-03"),
      msg(5, &["inbox"], "2026-01-04"),
    ])
    .unwrap();
    let f = |q: MessageQuery| ids(&c.query_messages(&q, 0, 10).unwrap());
    assert_eq!(f(MessageQuery { folder_id: Some("archive".into()), ..q() }), ["m000003", "m000002"]);
    assert_eq!(f(MessageQuery { sender: Some("EVEN@example.com".into()), ..q() }), ["m000002"]);
    assert_eq!(f(MessageQuery { thread_id: Some("t2".into()), ..q() }), ["m000005", "m000002"]);
    assert_eq!(f(MessageQuery { read: Some(false), ..q() }), ["m000005", "m000003", "m000001"]);
    assert_eq!(f(MessageQuery { starred: Some(true), ..q() }), ["m000005"]);
    assert_eq!(f(MessageQuery { since: Some("2026-01-02".into()), before: Some("2026-01-04".into()), ..q() }), ["m000003", "m000002"]);
    assert_eq!(f(MessageQuery { folder_id: Some("inbox".into()), read: Some(false), ..q() }), ["m000005", "m000001"]);
  }

  #[test]
  fn upsert_moves_folders_and_delete_removes() {
    let mut c = MailCache::open_in_memory().unwrap();
    c.upsert_messages(&[msg(1, &["archive"], "2026-01-01"), msg(2, &["inbox"], "2026-01-02")]).unwrap();
    c.upsert_messages(&[msg(1, &["inbox"], "2026-01-01")]).unwrap();
    assert_eq!(c.query_messages(&MessageQuery { folder_id: Some("archive".into()), ..q() }, 0, 10).unwrap().total, 0);
    assert_eq!(c.query_messages(&MessageQuery { folder_id: Some("inbox".into()), ..q() }, 0, 10).unwrap().total, 2);
    c.delete_messages(&["m000001".into(), "missing".into()]).unwrap();
    assert!(c.get_message("m000001").unwrap().is_none());
    assert_eq!(c.query_messages(&MessageQuery { folder_id: Some("inbox".into()), ..q() }, 0, 10).unwrap().total, 1);
    assert_eq!(c.get_message("m000002").unwrap().unwrap()["from"]["address"], "Even@Example.com");
  }

  #[test]
  fn threads_listing_and_delete() {
    let mut c = MailCache::open_in_memory().unwrap();
    let t = |id: &str, at: &str, f: &[&str]| json!({"id": id, "accountId": "a", "lastMessageAt": at, "folderIds": f});
    c.upsert_threads(&[t("t1", "2026-01-01", &["inbox"]), t("t2", "2026-01-03", &["inbox", "x"]), t("t3", "2026-01-02", &["x"])]).unwrap();
    let all = c.list_threads(None, 0, 10).unwrap();
    assert_eq!(all.items.iter().map(|v| v["id"].as_str().unwrap()).collect::<Vec<_>>(), ["t2", "t3", "t1"]);
    assert_eq!(c.list_threads(Some("x"), 1, 5).unwrap().total, 2);
    c.upsert_threads(&[t("t2", "2026-01-03", &["inbox"])]).unwrap();
    assert_eq!(c.list_threads(Some("x"), 0, 5).unwrap().total, 1);
    c.delete_threads(&["t1".into()]).unwrap();
    assert!(c.get_thread("t1").unwrap().is_none());
    assert_eq!(c.list_threads(Some("inbox"), 0, 5).unwrap().total, 1);
  }

  #[test]
  fn sync_token_and_clear_account_scope() {
    let mut c = MailCache::open_in_memory().unwrap();
    let other = json!({"id": "o1", "accountId": "b", "threadId": "t", "folderIds": ["inbox"], "from": {"address": "x@y.z"},
                       "date": "2026-01-01", "flags": {"read": false, "starred": false, "draft": false}});
    c.upsert_messages(&[msg(1, &["inbox"], "2026-01-01"), other]).unwrap();
    c.upsert_folders(&[json!({"id": "inbox", "accountId": "a"}), json!({"id": "inbox-b", "accountId": "b"})]).unwrap();
    c.set_sync_token("a", Some("v1")).unwrap();
    c.set_sync_token("b", Some("w1")).unwrap();
    assert_eq!(c.get_sync_token("a").unwrap().as_deref(), Some("v1"));
    c.set_sync_token("a", None).unwrap();
    assert_eq!(c.get_sync_token("a").unwrap(), None);
    c.set_sync_token("a", Some("v2")).unwrap();
    c.clear_account("a").unwrap();
    assert_eq!(c.get_sync_token("a").unwrap(), None);
    assert!(c.get_folders("a").unwrap().is_empty());
    assert_eq!(c.get_folders("b").unwrap().len(), 1);
    assert_eq!(c.get_sync_token("b").unwrap().as_deref(), Some("w1"));
    let r = c.query_messages(&q(), 0, 10).unwrap();
    assert_eq!(ids(&r), ["o1"]);
    assert_eq!(c.query_messages(&MessageQuery { folder_id: Some("inbox".into()), ..q() }, 0, 10).unwrap().total, 1);
  }

  #[test]
  fn returns_stored_record_unchanged_and_rejects_bad_records() {
    let mut c = MailCache::open_in_memory().unwrap();
    let m = msg(7, &["inbox"], "2026-02-01");
    c.upsert_messages(&[m.clone()]).unwrap();
    assert_eq!(c.get_message("m000007").unwrap().unwrap(), m);
    assert!(c.upsert_messages(&[json!({"id": "bad"})]).is_err());
    assert!(c.get_message("bad").unwrap().is_none());
  }

  #[test]
  fn large_window_is_fast() {
    let mut c = MailCache::open_in_memory().unwrap();
    let batch: Vec<Value> = (0..50_000u32).map(|n| msg(n, &["inbox"], &format!("2026-01-01T00:{:02}:{:02}.{:03}Z", (n / 60000) % 60, (n / 1000) % 60, n % 1000))).collect();
    c.upsert_messages(&batch).unwrap();
    let t = std::time::Instant::now();
    let r = c.query_messages(&MessageQuery { folder_id: Some("inbox".into()), ..q() }, 100, 50).unwrap();
    assert_eq!(r.total, 50_000);
    assert_eq!(r.items.len(), 50);
    assert!(t.elapsed().as_millis() < 2_000);
  }
}
