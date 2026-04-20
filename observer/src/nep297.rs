//! Shared NEP-297 `EVENT_JSON:` log-line parser.

/// Parse a log line as a NEP-297 `EVENT_JSON:` envelope.
/// Returns the inner JSON body if the prefix matches and the body
/// parses; returns None for any non-event log or malformed event.
pub fn parse_event_json(log: &str) -> Option<serde_json::Value> {
    let body = log.strip_prefix("EVENT_JSON:")?;
    serde_json::from_str(body.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_event_json_accepts_sa_automation() {
        let log = r#"EVENT_JSON:{"standard":"sa-automation","version":"1.1.0","event":"step_resolved_ok","data":{"step_id":"s1"}}"#;
        let v = parse_event_json(log).unwrap();
        assert_eq!(v["standard"], "sa-automation");
        assert_eq!(v["event"], "step_resolved_ok");
        assert_eq!(v["data"]["step_id"], "s1");
    }

    #[test]
    fn parse_event_json_tolerates_whitespace() {
        let log = "EVENT_JSON:  { \"standard\": \"x\" }";
        let v = parse_event_json(log).unwrap();
        assert_eq!(v["standard"], "x");
    }

    #[test]
    fn parse_event_json_rejects_non_event_logs() {
        assert!(parse_event_json("just a regular log line").is_none());
        assert!(parse_event_json("").is_none());
    }

    #[test]
    fn parse_event_json_rejects_malformed_body() {
        assert!(parse_event_json("EVENT_JSON:not json").is_none());
        assert!(parse_event_json("EVENT_JSON:{bad}").is_none());
    }
}
