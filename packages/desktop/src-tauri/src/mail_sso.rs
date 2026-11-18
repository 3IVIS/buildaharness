//! Single sign-on through the operating system's Microsoft broker (plans/aielia_email_capabilities_plan.html, phase D5).
//!
//! NOT BUILT in this version. The commands exist so the page can ask and get a plain answer ("not built") and never show the option. A real
//! broker needs the Microsoft identity platform client for macOS (the broker plug-in) or Windows (the Web Account Manager) and an app registration
//! owned by the project; neither is available to build or test here (no Windows machine, no registration). Until then every call says so.

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
  pub available: bool,
  pub reason: Option<&'static str>,
}

pub fn availability() -> Availability {
  Availability { available: false, reason: Some("not_built") }
}

#[tauri::command]
pub fn mail_sso_availability() -> Availability {
  availability()
}

#[tauri::command]
pub fn mail_sso_acquire(scopes: Vec<String>, account_hint: Option<String>) -> Result<(), String> {
  let _ = (scopes, account_hint);
  Err("sso_unavailable: not_built".into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn says_plainly_that_it_is_not_built() {
    let a = availability();
    assert!(!a.available);
    assert_eq!(a.reason, Some("not_built"));
    assert_eq!(mail_sso_acquire(vec!["x".into()], None).unwrap_err(), "sso_unavailable: not_built");
  }
}
