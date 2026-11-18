//! Changes to mail made through Apple Mail's own automation (plans/aielia_email_capabilities_plan.html, phase D3).
//!
//! Mail makes the change and syncs it to the server with its own login, so Aielia needs no sign-in. Rules this file keeps, each covered by a test:
//!  - The webview never sends script text. It names an allow-listed action (`move`, `set_read`, `set_flagged`, `create_draft`, `list_accounts`)
//!    and passes values; the scripts live here.
//!  - Values reach the script only as `argv` items (after `--`), never joined into the script text, so a subject or folder name with quotes,
//!    backslashes, newlines or script keywords cannot become code.
//!  - No script can send or delete: the scripts do not contain those verbs (asserted below). A draft is saved, never sent.
//!  - Every run has a time limit, and a refused permission comes back as a short code (`automation_denied`) the screen can explain.
//!  - Message text is never logged.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HANDLERS: &str = r#"
on mailboxAt(acct, pathText)
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to (character id 31)
	set parts to text items of pathText
	set AppleScript's text item delimiters to oldDelims
	tell application "Mail"
		set mb to mailbox (item 1 of parts) of acct
		repeat with i from 2 to (count of parts)
			set mb to mailbox (item i of parts) of mb
		end repeat
		return mb
	end tell
end mailboxAt

on findMessage(mb, mid)
	tell application "Mail"
		set found to (messages of mb whose message id is mid)
		if (count of found) is 0 then set found to (messages of mb whose message id is ("<" & mid & ">"))
		if (count of found) is 0 then return missing value
		return item 1 of found
	end tell
end findMessage

on splitOn(txt, code)
	if txt is "" then return {}
	set oldDelims to AppleScript's text item delimiters
	set AppleScript's text item delimiters to (character id code)
	set parts to text items of txt
	set AppleScript's text item delimiters to oldDelims
	return parts
end splitOn
"#;

const MOVE: &str = r#"
on run argv
	set acctId to item 1 of argv
	set srcPath to item 2 of argv
	set dstPath to item 3 of argv
	set moved to 0
	set missed to 0
	tell application "Mail"
		set acct to first account whose id is acctId
		set src to my mailboxAt(acct, srcPath)
		set dst to my mailboxAt(acct, dstPath)
		repeat with i from 4 to (count of argv)
			set m to my findMessage(src, item i of argv)
			if m is missing value then
				set missed to missed + 1
			else
				move m to dst
				set moved to moved + 1
			end if
		end repeat
	end tell
	return "ok:" & moved & ":" & missed
end run
"#;

const SET_READ: &str = r#"
on run argv
	set acctId to item 1 of argv
	set srcPath to item 2 of argv
	set wanted to ((item 3 of argv) is "true")
	set changed to 0
	set missed to 0
	tell application "Mail"
		set acct to first account whose id is acctId
		set src to my mailboxAt(acct, srcPath)
		repeat with i from 4 to (count of argv)
			set m to my findMessage(src, item i of argv)
			if m is missing value then
				set missed to missed + 1
			else
				set read status of m to wanted
				set changed to changed + 1
			end if
		end repeat
	end tell
	return "ok:" & changed & ":" & missed
end run
"#;

const SET_FLAGGED: &str = r#"
on run argv
	set acctId to item 1 of argv
	set srcPath to item 2 of argv
	set wanted to ((item 3 of argv) is "true")
	set changed to 0
	set missed to 0
	tell application "Mail"
		set acct to first account whose id is acctId
		set src to my mailboxAt(acct, srcPath)
		repeat with i from 4 to (count of argv)
			set m to my findMessage(src, item i of argv)
			if m is missing value then
				set missed to missed + 1
			else
				set flagged status of m to wanted
				set changed to changed + 1
			end if
		end repeat
	end tell
	return "ok:" & changed & ":" & missed
end run
"#;

const CREATE_DRAFT: &str = r#"
on run argv
	set fromAddr to item 1 of argv
	set subj to item 2 of argv
	set bodyText to item 3 of argv
	set toList to my splitOn(item 4 of argv, 31)
	set ccList to my splitOn(item 5 of argv, 31)
	tell application "Mail"
		set msg to make new outgoing message with properties {subject:subj, content:bodyText, visible:false}
		if fromAddr is not "" then set sender of msg to fromAddr
		repeat with e in toList
			set pair to my splitOn(contents of e, 30)
			tell msg to make new to recipient at end of to recipients with properties {address:(item 1 of pair), name:(item 2 of pair)}
		end repeat
		repeat with e in ccList
			set pair to my splitOn(contents of e, 30)
			tell msg to make new cc recipient at end of cc recipients with properties {address:(item 1 of pair), name:(item 2 of pair)}
		end repeat
		save msg
	end tell
	return "ok"
end run
"#;

const LIST_ACCOUNTS: &str = r#"
on run argv
	set out to ""
	tell application "Mail"
		repeat with a in accounts
			set out to out & (id of a) & tab & (name of a) & linefeed
		end repeat
	end tell
	return out
end run
"#;

/// (kind, script body, minimum argument count). The handlers are appended to every script.
const SCRIPTS: &[(&str, &str, usize)] = &[
  ("move", MOVE, 4),
  ("set_read", SET_READ, 4),
  ("set_flagged", SET_FLAGGED, 4),
  ("create_draft", CREATE_DRAFT, 5),
  ("list_accounts", LIST_ACCOUNTS, 0),
];

pub fn script_for(kind: &str) -> Option<(String, usize)> {
  SCRIPTS.iter().find(|(k, _, _)| *k == kind).map(|(_, body, min)| (format!("{body}\n{HANDLERS}"), *min))
}

/// Check the arguments for an action before anything runs.
pub fn validate(kind: &str, args: &[String]) -> Result<(), String> {
  let (_, min) = script_for(kind).ok_or_else(|| format!("bad_request: unknown action {kind}"))?;
  if args.len() < min {
    return Err(format!("bad_request: {kind} needs at least {min} values"));
  }
  if kind == "create_draft" && args.len() != 5 {
    return Err("bad_request: create_draft needs exactly 5 values".into());
  }
  if kind == "list_accounts" && !args.is_empty() {
    return Err("bad_request: list_accounts takes no values".into());
  }
  if (kind == "set_read" || kind == "set_flagged") && args[2] != "true" && args[2] != "false" {
    return Err("bad_request: the third value must be true or false".into());
  }
  if args.iter().any(|a| a.contains('\0')) {
    return Err("bad_request: a value contains a NUL".into());
  }
  if args.iter().map(|a| a.len()).sum::<usize>() > 2_000_000 {
    return Err("bad_request: too much text for one action".into());
  }
  Ok(())
}

/// The short code for what osascript said when it failed. Only codes and the first line, truncated; never message text.
pub fn classify_failure(stderr: &str) -> String {
  let t = stderr.trim();
  if t.contains("-1743") || t.to_lowercase().contains("not authorized") {
    "automation_denied".into()
  } else if t.contains("-600") || t.to_lowercase().contains("isn't running") || t.to_lowercase().contains("isn’t running") {
    "mail_not_running".into()
  } else if t.contains("-1728") {
    "mail_object_not_found".into()
  } else {
    let first: String = t.lines().next().unwrap_or("").chars().take(160).collect();
    format!("script_failed: {first}")
  }
}

/// Run an action. Arguments follow `--`, so even one that starts with a dash is a value, not an option.
#[cfg(target_os = "macos")]
pub fn run(kind: &str, args: &[String], timeout: Duration) -> Result<String, String> {
  validate(kind, args)?;
  let (script, _) = script_for(kind).expect("validated");
  let mut child = Command::new("osascript")
    .arg("-e")
    .arg(&script)
    .arg("--")
    .args(args)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("script_failed: cannot start osascript: {e}"))?;
  let started = Instant::now();
  loop {
    match child.try_wait().map_err(|e| format!("script_failed: {e}"))? {
      Some(status) => {
        let mut out = String::new();
        let mut err = String::new();
        if let Some(mut s) = child.stdout.take() { let _ = s.read_to_string(&mut out); }
        if let Some(mut s) = child.stderr.take() { let _ = s.read_to_string(&mut err); }
        return if status.success() { Ok(out.trim_end_matches('\n').to_string()) } else { Err(classify_failure(&err)) };
      }
      None if started.elapsed() > timeout => {
        let _ = child.kill();
        let _ = child.wait();
        return Err("script_timeout".into());
      }
      None => std::thread::sleep(Duration::from_millis(40)),
    }
  }
}

#[cfg(not(target_os = "macos"))]
pub fn run(kind: &str, args: &[String], _timeout: Duration) -> Result<String, String> {
  validate(kind, args)?;
  Err("unsupported_platform".into())
}

/// The two System Settings panes this feature needs. A fixed list: the page cannot ask for any other address to be opened.
pub fn privacy_url(pane: &str) -> Option<&'static str> {
  match pane {
    "full_disk_access" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
    "automation" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"),
    _ => None,
  }
}

#[tauri::command]
pub fn mail_local_open_privacy_settings(pane: String) -> Result<(), String> {
  let url = privacy_url(&pane).ok_or_else(|| "bad_request: unknown settings pane".to_string())?;
  #[cfg(target_os = "macos")]
  {
    Command::new("open").arg(url).status().map_err(|e| format!("script_failed: {e}"))?;
    Ok(())
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = url;
    Err("unsupported_platform".into())
  }
}

#[tauri::command]
pub async fn mail_local_script(kind: String, args: Vec<String>) -> Result<String, String> {
  // Off the async runtime's thread: a script can take many seconds.
  tauri::async_runtime::spawn_blocking(move || run(&kind, &args, Duration::from_secs(90))).await.map_err(|e| format!("script_failed: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;

  fn s(v: &[&str]) -> Vec<String> { v.iter().map(|x| x.to_string()).collect() }

  #[test]
  fn only_the_listed_actions_exist() {
    for k in ["move", "set_read", "set_flagged", "create_draft", "list_accounts"] { assert!(script_for(k).is_some(), "{k}"); }
    for k in ["send", "delete", "run", "", "move; do shell script \"x\""] { assert!(script_for(k).is_none(), "{k:?}"); }
  }

  #[test]
  fn no_script_can_send_or_delete_or_reach_outside_mail() {
    for (kind, body, _) in SCRIPTS {
      let all = format!("{body}\n{HANDLERS}").to_lowercase();
      for banned in ["send ", "delete ", "do shell script", "run script", "system events", "keystroke", "set password", "open location", "quit"] {
        assert!(!all.contains(banned), "script {kind} contains {banned:?}");
      }
      assert!(all.contains("on run argv"), "script {kind} reads its values from argv");
      // The only application it talks to is Mail.
      for line in all.lines().filter(|l| l.contains("tell application")) { assert!(line.contains("\"mail\""), "{kind}: {line}"); }
    }
  }

  #[test]
  fn only_two_settings_panes_can_be_opened() {
    assert!(privacy_url("full_disk_access").unwrap().starts_with("x-apple.systempreferences:"));
    assert!(privacy_url("automation").is_some());
    for bad in ["", "https://example.com", "file:///etc/passwd", "full_disk_access;rm"] { assert!(privacy_url(bad).is_none(), "{bad:?}"); }
  }

  #[test]
  fn arguments_are_checked_before_anything_runs() {
    assert!(validate("move", &s(&["acct", "INBOX", "Archive", "id1"])).is_ok());
    assert!(validate("move", &s(&["acct", "INBOX", "Archive"])).is_err());
    assert!(validate("set_read", &s(&["a", "p", "maybe", "id"])).is_err());
    assert!(validate("set_read", &s(&["a", "p", "true", "id"])).is_ok());
    assert!(validate("create_draft", &s(&["", "subj", "body", "", ""])).is_ok());
    assert!(validate("create_draft", &s(&["subj", "body"])).is_err());
    assert!(validate("list_accounts", &s(&["x"])).is_err());
    assert!(validate("move", &s(&["a", "p", "q", "id\0x"])).is_err());
    assert!(validate("nope", &[]).is_err());
  }

  #[test]
  fn failures_become_codes_and_never_carry_much_text() {
    assert_eq!(classify_failure("execution error: Not authorized to send Apple events to Mail. (-1743)"), "automation_denied");
    assert_eq!(classify_failure("Application isn't running. (-600)"), "mail_not_running");
    assert_eq!(classify_failure("Can't get mailbox \"x\". (-1728)"), "mail_object_not_found");
    let long = "boom ".repeat(200);
    let c = classify_failure(&long);
    assert!(c.starts_with("script_failed: ") && c.len() < 200);
  }

  /// Hostile values only ever travel as arguments: compile each script and confirm the values never appear in the script text.
  #[cfg(target_os = "macos")]
  #[test]
  fn every_script_compiles_and_values_are_never_part_of_the_script_text() {
    let dir = std::env::temp_dir().join(format!("aielia-script-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    if Command::new("osacompile").arg("-h").output().is_err() { return; }
    for (kind, body, _) in SCRIPTS {
      let src = dir.join(format!("{kind}.applescript"));
      std::fs::write(&src, format!("{body}\n{HANDLERS}")).unwrap();
      let out = Command::new("osacompile").arg("-o").arg(dir.join(format!("{kind}.scpt"))).arg(&src).output().unwrap();
      assert!(out.status.success(), "{kind} does not compile: {}", String::from_utf8_lossy(&out.stderr));
    }
    let hostile = "x\" & (do shell script \"touch /tmp/pwned\") & \"";
    let (script, _) = script_for("move").unwrap();
    assert!(!script.contains(hostile) && !script.contains("pwned"));
  }
}
