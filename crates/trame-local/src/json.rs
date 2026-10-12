use serde_json::Value;

pub fn stringify(value: &Value) -> String {
    match value {
        Value::Number(n) => {
            let number = n.as_f64().unwrap();
            if number == 0.0 {
                return "0".into();
            }
            if !(1e-6..1e21).contains(&number.abs()) {
                let scientific = format!("{number:e}");
                let (mantissa, exponent) = scientific.split_once('e').unwrap();
                let exponent: i32 = exponent.parse().unwrap();
                format!("{mantissa}e{exponent:+}")
            } else {
                number.to_string()
            }
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(values) => {
            let index = |key: &str| {
                key.parse::<u32>()
                    .ok()
                    .filter(|n| *n != u32::MAX && n.to_string() == key)
            };
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_by_key(|key| index(key).map(|n| (0, n)).unwrap_or((1, 0)));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        stringify(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_json_stringify_number_and_key_order() {
        for (input, expected) in [
            ("1.0", "1"),
            ("-0.0", "0"),
            ("1e20", "100000000000000000000"),
            ("1e21", "1e+21"),
            ("0.000001", "0.000001"),
            ("0.0000001", "1e-7"),
            ("9007199254740993", "9007199254740992"),
            (
                r#"{"10":1,"a":2,"2":3,"01":4}"#,
                r#"{"2":3,"10":1,"a":2,"01":4}"#,
            ),
        ] {
            assert_eq!(stringify(&serde_json::from_str(input).unwrap()), expected);
        }
    }
}
