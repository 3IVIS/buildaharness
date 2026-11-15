//! Account-keyed keychain for mail credentials (Email, phase R2).
//!
//! One API over Keychain Services (macOS), Credential Manager (Windows) and the Secret Service (Linux), through the
//! `keyring` crate. Commands take an account id: set, get, delete. The model-key commands in `lib.rs` are unchanged.
//!
//! When there is no usable keyring (typically Linux without a Secret Service), every command fails with an error
//! string that starts with `no_keyring:`. The TypeScript side then keeps the token for the session only and shows a
//! notice. There is no plain-file fallback, by decision (2026-11-13).

use keyring::Error as KeyringError;

/// Storage identifier, not a display name. Kept apart from the model-key service so the two never collide.
const MAIL_SERVICE: &str = "com.buildaharness.assistant.mail";
/// Prefix the page recognises as "no keyring on this machine".
pub const NO_KEYRING_PREFIX: &str = "no_keyring:";

fn map_err(e: KeyringError) -> String {
  match e {
    // No secret-service daemon, no D-Bus, a locked or missing store: the page falls back to the session.
    KeyringError::NoStorageAccess(inner) => format!("{NO_KEYRING_PREFIX} {inner}"),
    KeyringError::PlatformFailure(inner) => format!("{NO_KEYRING_PREFIX} {inner}"),
    other => format!("keychain error: {other}"),
  }
}

fn valid_account(account_id: &str) -> Result<(), String> {
  if account_id.is_empty() || account_id.len() > 200 {
    return Err("keychain error: invalid account id".to_string());
  }
  Ok(())
}

fn entry(account_id: &str) -> Result<keyring::Entry, String> {
  valid_account(account_id)?;
  keyring::Entry::new(MAIL_SERVICE, account_id).map_err(map_err)
}

pub fn secret_set_impl(account_id: &str, value: &str) -> Result<(), String> {
  entry(account_id)?.set_password(value).map_err(map_err)
}

/// Not found is `Ok(None)`, matching the model-key `get` and the TypeScript `SecretStore` contract.
pub fn secret_get_impl(account_id: &str) -> Result<Option<String>, String> {
  match entry(account_id)?.get_password() {
    Ok(v) => Ok(Some(v)),
    Err(KeyringError::NoEntry) => Ok(None),
    Err(e) => Err(map_err(e)),
  }
}

/// Deleting a missing entry succeeds (idempotent), like the model-key `delete`.
pub fn secret_delete_impl(account_id: &str) -> Result<(), String> {
  match entry(account_id)?.delete_credential() {
    Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
    Err(e) => Err(map_err(e)),
  }
}

/// The page-facing commands refuse the entries Rust owns (OAuth tokens, phase R4), so a token never reaches the page.
fn page_guard(account_id: &str) -> Result<(), String> {
  if account_id.starts_with(crate::mail_net::RESERVED_PREFIX) {
    return Err("keychain error: reserved account id".to_string());
  }
  Ok(())
}

pub fn secret_get_impl_for_page(account_id: &str) -> Result<Option<String>, String> {
  page_guard(account_id)?;
  secret_get_impl(account_id)
}
pub fn secret_set_impl_for_page(account_id: &str, value: &str) -> Result<(), String> {
  page_guard(account_id)?;
  secret_set_impl(account_id, value)
}
pub fn secret_delete_impl_for_page(account_id: &str) -> Result<(), String> {
  page_guard(account_id)?;
  secret_delete_impl(account_id)
}

#[tauri::command]
pub async fn mail_secret_set(account_id: String, value: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || secret_set_impl_for_page(&account_id, &value))
    .await
    .map_err(|e| format!("keychain error: {e}"))?
}

#[tauri::command]
pub async fn mail_secret_get(account_id: String) -> Result<Option<String>, String> {
  tauri::async_runtime::spawn_blocking(move || secret_get_impl_for_page(&account_id))
    .await
    .map_err(|e| format!("keychain error: {e}"))?
}

#[tauri::command]
pub async fn mail_secret_delete(account_id: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || secret_delete_impl_for_page(&account_id))
    .await
    .map_err(|e| format!("keychain error: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_empty_and_oversized_account_ids() {
    assert!(secret_get_impl("").is_err());
    assert!(secret_set_impl(&"a".repeat(201), "x").is_err());
  }

  #[test]
  fn no_storage_maps_to_the_no_keyring_prefix() {
    let e = map_err(KeyringError::NoStorageAccess("no daemon".into()));
    assert!(e.starts_with(NO_KEYRING_PREFIX));
    let e = map_err(KeyringError::NoEntry);
    assert!(!e.starts_with(NO_KEYRING_PREFIX));
  }

  /// Real round trip through the OS store. Skips itself when the machine has no keyring (headless CI, Linux without a
  /// Secret Service), which is the very case the typed error exists for.
  #[test]
  fn round_trips_by_account_id_and_is_idempotent_on_delete() {
    let a = format!("test-acct-a-{}", std::process::id());
    let b = format!("test-acct-b-{}", std::process::id());
    match secret_set_impl(&a, "tok-a") {
      Err(e) if e.starts_with(NO_KEYRING_PREFIX) => {
        eprintln!("skipping: no keyring here ({e})");
        return;
      }
      other => other.unwrap(),
    }
    secret_set_impl(&b, "tok-b").unwrap();
    assert_eq!(secret_get_impl(&a).unwrap().as_deref(), Some("tok-a"));
    assert_eq!(secret_get_impl(&b).unwrap().as_deref(), Some("tok-b"));
    secret_set_impl(&a, "tok-a2").unwrap();
    assert_eq!(secret_get_impl(&a).unwrap().as_deref(), Some("tok-a2"));
    secret_delete_impl(&a).unwrap();
    secret_delete_impl(&a).unwrap();
    assert_eq!(secret_get_impl(&a).unwrap(), None);
    assert_eq!(secret_get_impl(&b).unwrap().as_deref(), Some("tok-b"));
    secret_delete_impl(&b).unwrap();
  }
}
