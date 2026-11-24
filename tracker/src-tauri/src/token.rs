use keyring::{Entry, Error};

fn entry() -> Result<Entry, Error> {
    Entry::new("GameTracker", "device-token")
}

pub fn get() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn set(token: &str) -> Result<(), Error> {
    entry()?.set_password(token)
}

pub fn clear() -> Result<(), Error> {
    match entry()?.delete_credential() {
        Err(Error::NoEntry) => Ok(()),
        r => r,
    }
}

/// First 9 chars + 8 bullets.
pub fn mask(token: &str) -> String {
    token.chars().take(9).chain("••••••••".chars()).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn mask_keeps_prefix() {
        assert_eq!(super::mask("gt_abcdefghijk"), "gt_abcdef••••••••");
    }
}
