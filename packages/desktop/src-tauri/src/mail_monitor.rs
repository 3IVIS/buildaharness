//! An opt-in log of what a person does in the Email screen, for a supervised test session. It is OFF unless the app was started with
//! `AIELIA_EMAIL_MONITOR=<absolute path ending in .jsonl>` (set by the person or the test setup, never by the page). The page sends one JSON line
//! per interaction; this appends it to that one file. Nothing else is written, no other path is accepted, a line is capped and the file is capped.
//! The lines can contain what the person typed and mail subjects, so the file stays on this computer and is for the test session only.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

const MAX_LINE: usize = 16_000;
const MAX_FILE: u64 = 20_000_000;

/// The file to append to, from the environment value: an absolute `.jsonl` path in a folder that exists. Anything else means the monitor is off.
pub fn target_from(value: Option<String>) -> Option<PathBuf> {
  let p = PathBuf::from(value?);
  if !p.is_absolute() || p.extension().and_then(|e| e.to_str()) != Some("jsonl") || p.file_name().is_none() {
    return None;
  }
  if p.parent()?.is_dir() { Some(p) } else { None }
}

fn target() -> Option<PathBuf> {
  target_from(std::env::var("AIELIA_EMAIL_MONITOR").ok())
}

/// Append one line; false when the line is not acceptable (too long, or not one line).
pub fn append_line(path: &PathBuf, line: &str) -> Result<bool, String> {
  if line.len() > MAX_LINE || line.contains('\n') || line.contains('\r') {
    return Ok(false);
  }
  if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) > MAX_FILE {
    return Ok(false);
  }
  let mut f = OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
  writeln!(f, "{line}").map_err(|e| e.to_string())?;
  Ok(true)
}

#[tauri::command]
pub fn email_monitor_enabled() -> bool {
  target().is_some()
}

#[tauri::command]
pub fn email_monitor_log(line: String) -> Result<(), String> {
  let Some(path) = target() else { return Ok(()) };
  append_line(&path, &line).map(|_| ())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmp(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("aielia-monitor-{}-{}", std::process::id(), name))
  }

  #[test]
  fn only_an_absolute_jsonl_path_in_an_existing_folder_turns_it_on() {
    assert!(target_from(None).is_none());
    assert!(target_from(Some("relative.jsonl".into())).is_none());
    assert!(target_from(Some(tmp("x.txt").to_string_lossy().to_string())).is_none());
    assert!(target_from(Some("/definitely/not/a/folder/x.jsonl".into())).is_none());
    assert!(target_from(Some(tmp("ok.jsonl").to_string_lossy().to_string())).is_some());
  }

  #[test]
  fn appends_whole_lines_and_refuses_multi_line_or_oversized_ones() {
    let p = tmp("append.jsonl");
    let _ = std::fs::remove_file(&p);
    assert!(append_line(&p, "{\"a\":1}").unwrap());
    assert!(append_line(&p, "{\"b\":2}").unwrap());
    assert!(!append_line(&p, "one\ntwo").unwrap());
    assert!(!append_line(&p, &"x".repeat(MAX_LINE + 1)).unwrap());
    assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"a\":1}\n{\"b\":2}\n");
    let _ = std::fs::remove_file(&p);
  }
}
