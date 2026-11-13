use chrono::{NaiveDate, ParseError};

/// Days from `today` to `due` (both `YYYY-MM-DD`); negative when late.
pub fn days_until(due: &str, today: &str) -> Result<i64, ParseError> {
    let due = NaiveDate::parse_from_str(due, "%Y-%m-%d")?;
    let today = NaiveDate::parse_from_str(today, "%Y-%m-%d")?;
    Ok((due - today).num_days())
}

/// Late or due within 7 days: what the sidebar's DUE section shows.
pub fn shown_due(due: &str, today: &str) -> Result<bool, ParseError> {
    Ok(days_until(due, today)? <= 7)
}
