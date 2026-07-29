//! Locale-aware number expansion for phonemizers that only accept words.
//!
//! Kokoro's reference Misaki pipeline runs `num2words` before G2P. The
//! lightweight CrispASR English/French G2P bundled by NotaBene does not: digit
//! characters reach its letter-to-sound fallback and are skipped. Expand them
//! at the engine boundary so every Kokoro caller gets audible numbers.

use regex::{Captures, Regex};
use std::sync::OnceLock;

const EN_ONES: [&str; 20] = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
];
const EN_TENS: [&str; 10] = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
];
const EN_SCALES: [(u64, &str); 5] = [
    (1_000_000_000_000_000, "quadrillion"),
    (1_000_000_000_000, "trillion"),
    (1_000_000_000, "billion"),
    (1_000_000, "million"),
    (1_000, "thousand"),
];
const FR_SMALL: [&str; 17] = [
    "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix", "onze",
    "douze", "treize", "quatorze", "quinze", "seize",
];
const DIGITS_EN: [&str; 10] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
];
const DIGITS_FR: [&str; 10] = [
    "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
];

fn number_pattern(french: bool) -> &'static Regex {
    static ENGLISH: OnceLock<Regex> = OnceLock::new();
    static FRENCH: OnceLock<Regex> = OnceLock::new();
    let (pattern, source) = if french {
        (
            &FRENCH,
            r"(?P<sign>[+-]?)(?P<number>[0-9]+(?:[,.][0-9]+)*)(?P<ordinal>er|re|ème|e)?(?P<percent>\s*%)?",
        )
    } else {
        (
            &ENGLISH,
            r"(?P<sign>[+-]?)(?P<number>[0-9]+(?:[,.][0-9]+)*)(?P<ordinal>st|nd|rd|th)?(?P<percent>\s*%)?",
        )
    };
    pattern.get_or_init(|| Regex::new(source).expect("the Kokoro number pattern must be valid"))
}

pub(super) fn expand_numbers(text: &str, language: &str) -> String {
    let french = language.starts_with("fr");
    number_pattern(french)
        .replace_all(text, |captures: &Captures<'_>| {
            let matched = captures
                .get(0)
                .expect("the full number match is always available");
            let captured_sign = captures.name("sign").map_or("", |value| value.as_str());
            // A hyphen between two digits is a separator (commonly a date or
            // phone number), not a negative sign for every following group.
            let adjacent_to_digit = !captured_sign.is_empty()
                && text[..matched.start()]
                    .chars()
                    .next_back()
                    .is_some_and(|character| character.is_ascii_digit());
            let mut spoken = expand_match(
                if adjacent_to_digit { "" } else { captured_sign },
                captures
                    .name("number")
                    .expect("number capture is required")
                    .as_str(),
                captures.name("ordinal").map(|value| value.as_str()),
                captures.name("percent").is_some(),
                french,
            );
            if adjacent_to_digit {
                spoken.insert(0, ' ');
            }
            spoken
        })
        .into_owned()
}

fn expand_match(
    sign: &str,
    raw: &str,
    ordinal: Option<&str>,
    percent: bool,
    french: bool,
) -> String {
    let (integer, fraction) = split_number(raw, french);
    let negative = sign == "-";
    let mut spoken = if integer.len() > 15 || (integer.len() > 1 && integer.starts_with('0')) {
        digits_to_words(&integer, french)
    } else if let Ok(value) = integer.parse::<u64>() {
        if ordinal.is_some() {
            if french {
                french_ordinal(value, ordinal)
            } else {
                english_ordinal(value)
            }
        } else if french {
            french_integer(value)
        } else {
            english_integer(value)
        }
    } else {
        digits_to_words(&integer, french)
    };

    if let Some(fraction) = fraction {
        spoken.push(' ');
        spoken.push_str(if french { "virgule" } else { "point" });
        spoken.push(' ');
        spoken.push_str(&digits_to_words(&fraction, french));
    }
    if negative {
        spoken = format!("{} {spoken}", if french { "moins" } else { "minus" });
    } else if sign == "+" {
        spoken = format!("plus {spoken}");
    }
    if percent {
        spoken.push_str(if french { " pour cent" } else { " percent" });
    }
    spoken
}

fn split_number(raw: &str, french: bool) -> (String, Option<String>) {
    let dot = raw.rfind('.');
    let comma = raw.rfind(',');
    let decimal = match (dot, comma) {
        (Some(dot), Some(comma)) => Some(dot.max(comma)),
        (Some(dot), None) => {
            if french && grouping_separator(raw, '.') {
                None
            } else {
                Some(dot)
            }
        }
        (None, Some(comma)) => {
            if !french && grouping_separator(raw, ',') {
                None
            } else {
                Some(comma)
            }
        }
        (None, None) => None,
    };

    let integer_end = decimal.unwrap_or(raw.len());
    let integer = raw[..integer_end]
        .chars()
        .filter(char::is_ascii_digit)
        .collect();
    let fraction = decimal.map(|index| {
        raw[index + 1..]
            .chars()
            .filter(char::is_ascii_digit)
            .collect()
    });
    (integer, fraction)
}

fn grouping_separator(raw: &str, separator: char) -> bool {
    let mut groups = raw.split(separator);
    let first = groups.next().unwrap_or_default();
    !first.is_empty()
        && first.len() <= 3
        && groups.clone().count() > 0
        && groups.all(|group| group.len() == 3)
}

fn digits_to_words(digits: &str, french: bool) -> String {
    let names = if french { &DIGITS_FR } else { &DIGITS_EN };
    digits
        .bytes()
        .filter(|byte| byte.is_ascii_digit())
        .map(|byte| names[(byte - b'0') as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

fn english_integer(value: u64) -> String {
    if value < 20 {
        return EN_ONES[value as usize].into();
    }
    if value < 100 {
        let tens = EN_TENS[(value / 10) as usize];
        let remainder = value % 10;
        return if remainder == 0 {
            tens.into()
        } else {
            format!("{tens} {}", EN_ONES[remainder as usize])
        };
    }
    if value < 1_000 {
        let remainder = value % 100;
        let hundreds = format!("{} hundred", EN_ONES[(value / 100) as usize]);
        return if remainder == 0 {
            hundreds
        } else {
            format!("{hundreds} {}", english_integer(remainder))
        };
    }
    for (scale, label) in EN_SCALES {
        if value >= scale {
            let remainder = value % scale;
            let prefix = format!("{} {label}", english_integer(value / scale));
            return if remainder == 0 {
                prefix
            } else {
                format!("{prefix} {}", english_integer(remainder))
            };
        }
    }
    unreachable!("all u64 values supported by the scale table are handled")
}

fn english_ordinal(value: u64) -> String {
    let cardinal = english_integer(value);
    let Some((prefix, last)) = cardinal.rsplit_once(' ') else {
        return ordinal_word(&cardinal);
    };
    format!("{prefix} {}", ordinal_word(last))
}

fn ordinal_word(word: &str) -> String {
    match word {
        "one" => "first".into(),
        "two" => "second".into(),
        "three" => "third".into(),
        "four" => "fourth".into(),
        "five" => "fifth".into(),
        "eight" => "eighth".into(),
        "nine" => "ninth".into(),
        "twelve" => "twelfth".into(),
        value if value.ends_with('y') => format!("{}ieth", &value[..value.len() - 1]),
        value => format!("{value}th"),
    }
}

fn french_under_hundred(value: u64) -> String {
    if value <= 16 {
        return FR_SMALL[value as usize].into();
    }
    if value < 20 {
        return format!("dix {}", FR_SMALL[(value - 10) as usize]);
    }
    if value < 70 {
        const TENS: [&str; 7] = [
            "",
            "",
            "vingt",
            "trente",
            "quarante",
            "cinquante",
            "soixante",
        ];
        let tens = TENS[(value / 10) as usize];
        let remainder = value % 10;
        return match remainder {
            0 => tens.into(),
            1 => format!("{tens} et un"),
            _ => format!("{tens} {}", FR_SMALL[remainder as usize]),
        };
    }
    if value < 80 {
        return if value == 71 {
            "soixante et onze".into()
        } else {
            format!("soixante {}", french_under_hundred(value - 60))
        };
    }
    if value == 80 {
        return "quatre vingts".into();
    }
    format!("quatre vingt {}", french_under_hundred(value - 80))
}

fn french_under_thousand(value: u64) -> String {
    if value < 100 {
        return french_under_hundred(value);
    }
    let hundreds = value / 100;
    let remainder = value % 100;
    let prefix = match (hundreds, remainder) {
        (1, _) => "cent".into(),
        (_, 0) => format!("{} cents", french_under_hundred(hundreds)),
        _ => format!("{} cent", french_under_hundred(hundreds)),
    };
    if remainder == 0 {
        prefix
    } else {
        format!("{prefix} {}", french_under_hundred(remainder))
    }
}

fn french_integer(value: u64) -> String {
    if value < 1_000 {
        return french_under_thousand(value);
    }
    const SCALES: [(u64, &str, bool); 5] = [
        (1_000_000_000_000_000, "billiard", true),
        (1_000_000_000_000, "billion", true),
        (1_000_000_000, "milliard", true),
        (1_000_000, "million", true),
        (1_000, "mille", false),
    ];
    for (scale, label, pluralizes) in SCALES {
        if value >= scale {
            let count = value / scale;
            let remainder = value % scale;
            let prefix = if scale == 1_000 && count == 1 {
                label.into()
            } else {
                format!(
                    "{} {label}{}",
                    french_integer(count),
                    if pluralizes && count > 1 { "s" } else { "" }
                )
            };
            return if remainder == 0 {
                prefix
            } else {
                format!("{prefix} {}", french_integer(remainder))
            };
        }
    }
    unreachable!("all u64 values supported by the scale table are handled")
}

fn french_ordinal(value: u64, suffix: Option<&str>) -> String {
    if value == 1 {
        return if suffix == Some("re") {
            "première".into()
        } else {
            "premier".into()
        };
    }
    let cardinal = french_integer(value);
    let Some((prefix, last)) = cardinal.rsplit_once(' ') else {
        return french_ordinal_word(&cardinal);
    };
    format!("{prefix} {}", french_ordinal_word(last))
}

fn french_ordinal_word(word: &str) -> String {
    match word {
        "cinq" => "cinquième".into(),
        "neuf" => "neuvième".into(),
        "vingts" => "vingtième".into(),
        "cents" => "centième".into(),
        value if value.ends_with('e') => format!("{}ième", &value[..value.len() - 1]),
        value => format!("{value}ième"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_english_cardinals_decimals_ordinals_and_percentages() {
        assert_eq!(
            expand_numbers("There are 42 notes, 3.14 pages, and a 21st item at 5%.", "en-us"),
            "There are forty two notes, three point one four pages, and a twenty first item at five percent."
        );
        assert_eq!(
            expand_numbers("The total is 1,234,567 and code 007.", "en-us"),
            "The total is one million two hundred thirty four thousand five hundred sixty seven and code zero zero seven."
        );
    }

    #[test]
    fn expands_french_cardinals_decimals_ordinals_and_percentages() {
        assert_eq!(
            expand_numbers("Il y a 71 notes, 3,14 pages et le 21e élément à 5 %.", "fr"),
            "Il y a soixante et onze notes, trois virgule un quatre pages et le vingt et unième élément à cinq pour cent."
        );
        assert_eq!(
            expand_numbers("Les valeurs sont 80, 81 et 1.234.", "fr"),
            "Les valeurs sont quatre vingts, quatre vingt un et mille deux cent trente quatre."
        );
    }

    #[test]
    fn expands_signed_and_very_long_values_without_dropping_digits() {
        assert_eq!(
            expand_numbers("From -2 to +10.", "en"),
            "From minus two to plus ten."
        );
        assert_eq!(
            expand_numbers("Date 2026-07-29", "en"),
            "Date two thousand twenty six zero seven twenty nine"
        );
        assert_eq!(
            expand_numbers("ID 1234567890123456", "en"),
            "ID one two three four five six seven eight nine zero one two three four five six"
        );
    }
}
