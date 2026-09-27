use regex::Regex;

use crate::types::{Position, Sentiment};

pub struct ParseResult {
    pub mentioned: bool,
    pub cited: bool,
    pub position: Position,
    pub sentiment: Sentiment,
    pub snippet: Option<String>,
}

/// Rule-based parser — fast, zero-cost, works offline.
///
/// For higher-accuracy verdicts (especially tricky paraphrases), enable the
/// LLM-as-judge path via `parse_with_judge`. The judge prompt template is
/// documented in the project spec under `llm_as_judge_prompt_for_parser_fallback`.
pub fn parse_response(domain: &str, response: &str) -> ParseResult {
    let response_lower = response.to_lowercase();
    let domain_lower = domain.to_lowercase();
    let domain_base = strip_tld(&domain_lower);

    let mentioned = response_lower.contains(&domain_lower) || response_lower.contains(domain_base);

    let cited = mentioned && {
        let escaped = regex::escape(&domain_lower);
        let link_re = Regex::new(&format!(r"https?://[^\s)]*{}", escaped)).unwrap();
        let md_re = Regex::new(&format!(r"\[[^\]]*\]\([^)]*{}[^)]*\)", escaped)).unwrap();
        link_re.is_match(response) || md_re.is_match(response)
    };

    let position = if mentioned {
        detect_position(domain_base, &response_lower)
    } else {
        Position::NotMentioned
    };

    let sentiment = if mentioned {
        detect_sentiment(domain_base, &response_lower)
    } else {
        Sentiment::Unknown
    };

    let snippet = mentioned
        .then(|| extract_snippet(domain_base, response))
        .flatten();

    ParseResult {
        mentioned,
        cited,
        position,
        sentiment,
        snippet,
    }
}

/// LLM-as-judge: sends the raw response to a local model that returns structured
/// JSON. Falls back to rule-based on any error so it never blocks a run.
///
/// Judge prompt (from spec):
/// "You are an expert evaluator. Analyze the following LLM response for mentions
/// of the domain '{domain}'.\n\nResponse:\n{response}\n\nReturn ONLY valid JSON:
/// { \"domain_mentioned\": bool, \"link_cited\": bool, \"position\": \"Top|Middle|Bottom\",
///   \"sentiment\": \"Positive|Neutral|Negative\", \"snippet\": \"...\" }"
pub async fn parse_with_judge(
    domain: &str,
    response: &str,
    judge: &dyn crate::providers::LlmProvider,
) -> ParseResult {
    let prompt = format!(
        "You are an expert evaluator. Analyze the following LLM response for mentions of \
         the domain or brand '{domain}'.\n\nResponse:\n{response}\n\n\
         Return ONLY valid JSON, no prose:\n\
         {{\n  \"domain_mentioned\": true,\n  \"link_cited\": false,\n  \
         \"position\": \"Top|Middle|Bottom\",\n  \"sentiment\": \"Positive|Neutral|Negative\",\n  \
         \"snippet\": \"short relevant excerpt or null\"\n}}\nBe strict and factual.",
        domain = domain,
        response = &response[..response.len().min(2000)]
    );

    match judge.query(&prompt).await {
        Ok(raw) => parse_judge_json(&raw, domain, response),
        Err(_) => parse_response(domain, response), // silent fallback
    }
}

fn parse_judge_json(raw: &str, domain: &str, response: &str) -> ParseResult {
    // Extract the first JSON object from the output (judge may add prose around it)
    let start = raw.find('{').unwrap_or(0);
    let end = raw.rfind('}').map(|i| i + 1).unwrap_or(raw.len());
    let json_str = &raw[start..end];

    match serde_json::from_str::<serde_json::Value>(json_str) {
        Ok(v) => ParseResult {
            mentioned: v["domain_mentioned"].as_bool().unwrap_or(false),
            cited: v["link_cited"].as_bool().unwrap_or(false),
            position: match v["position"].as_str().unwrap_or("") {
                "Top" => Position::Top,
                "Middle" => Position::Middle,
                "Bottom" => Position::Bottom,
                _ => Position::NotMentioned,
            },
            sentiment: match v["sentiment"].as_str().unwrap_or("") {
                "Positive" => Sentiment::Positive,
                "Negative" => Sentiment::Negative,
                _ => Sentiment::Neutral,
            },
            snippet: v["snippet"]
                .as_str()
                .filter(|s| !s.is_empty() && *s != "null")
                .map(str::to_string),
        },
        Err(_) => parse_response(domain, response), // fallback
    }
}

fn strip_tld(domain: &str) -> &str {
    for tld in &[".com", ".io", ".dev", ".net", ".org", ".app", ".ai", ".co"] {
        if let Some(s) = domain.strip_suffix(tld) {
            return s;
        }
    }
    domain
}

fn detect_position(domain_base: &str, response_lower: &str) -> Position {
    let len = response_lower.len();
    if len == 0 {
        return Position::Middle;
    }
    let idx = match response_lower.find(domain_base) {
        Some(i) => i,
        None => return Position::NotMentioned,
    };
    let ratio = idx as f64 / len as f64;
    if ratio < 0.33 {
        Position::Top
    } else if ratio < 0.66 {
        Position::Middle
    } else {
        Position::Bottom
    }
}

fn detect_sentiment(domain_base: &str, response_lower: &str) -> Sentiment {
    // Split on sentence boundaries but NOT on '.' — domain names contain dots
    // and splitting there breaks context around "myproject.com is great".
    let relevant: Vec<&str> = response_lower
        .split(['!', '?', '\n'])
        .filter(|s| s.contains(domain_base))
        .collect();

    let context: String = if relevant.is_empty() {
        response_lower[..response_lower.len().min(600)].to_string()
    } else {
        relevant.join(" ")
    };

    const POS: &[&str] = &[
        "recommend",
        "excellent",
        "great",
        "best",
        "top",
        "popular",
        "useful",
        "powerful",
        "fast",
        "reliable",
        "easy",
        "good",
        "well",
        "favorite",
        "widely used",
        "well-known",
        "leading",
        "notable",
        "solid",
        "mature",
        "active",
        "maintained",
        "production-ready",
        "battle-tested",
    ];
    const NEG: &[&str] = &[
        "avoid",
        "poor",
        "bad",
        "deprecated",
        "abandoned",
        "slow",
        "buggy",
        "complex",
        "hard",
        "difficult",
        "outdated",
        "unmaintained",
        "not recommended",
        "limited",
        "lack",
        "missing",
        "unstable",
    ];

    let pos = POS.iter().filter(|w| context.contains(**w)).count();
    let neg = NEG.iter().filter(|w| context.contains(**w)).count();

    match pos.cmp(&neg) {
        std::cmp::Ordering::Greater => Sentiment::Positive,
        std::cmp::Ordering::Less => Sentiment::Negative,
        std::cmp::Ordering::Equal => Sentiment::Neutral,
    }
}

fn extract_snippet(domain_base: &str, response: &str) -> Option<String> {
    let lower = response.to_lowercase();
    let byte_idx = lower.find(domain_base)?;
    // Map the match position to character indices. Byte slicing would panic
    // on multibyte text (and lowercasing can shift byte offsets), so work
    // purely in chars and clamp defensively.
    let match_char = lower[..byte_idx].chars().count();
    let chars: Vec<char> = response.chars().collect();
    let center = match_char.min(chars.len().saturating_sub(1));
    let start = center.saturating_sub(80);
    let end = (center + domain_base.chars().count() + 120).min(chars.len());
    let raw: String = chars.get(start..end).unwrap_or(&[]).iter().collect();
    let raw = raw.trim();
    Some(if raw.chars().count() > 200 {
        crate::types::truncate_chars(raw, 200)
    } else {
        raw.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Position, Sentiment};

    #[test]
    fn detects_exact_domain() {
        let r = parse_response(
            "myproject.com",
            "I recommend myproject.com for this use case.",
        );
        assert!(r.mentioned);
        assert!(!r.cited);
        assert_eq!(r.position, Position::Top);
    }

    #[test]
    fn detects_base_without_tld() {
        let r = parse_response("myproject.com", "myproject is a great tool for developers.");
        assert!(r.mentioned);
    }

    #[test]
    fn not_mentioned() {
        let r = parse_response("myproject.com", "I recommend using ripgrep instead.");
        assert!(!r.mentioned);
        assert_eq!(r.position, Position::NotMentioned);
        assert_eq!(r.sentiment, Sentiment::Unknown);
        assert!(r.snippet.is_none());
    }

    #[test]
    fn detects_markdown_citation() {
        let r = parse_response(
            "myproject.com",
            "Check [myproject](https://myproject.com) for details.",
        );
        assert!(r.mentioned);
        assert!(r.cited);
    }

    #[test]
    fn detects_plain_url_citation() {
        let r = parse_response("myproject.com", "Visit https://myproject.com to install.");
        assert!(r.mentioned);
        assert!(r.cited);
    }

    #[test]
    fn positive_sentiment() {
        let r = parse_response(
            "myproject.com",
            "myproject.com is excellent and widely used by developers.",
        );
        assert!(r.mentioned);
        assert_eq!(r.sentiment, Sentiment::Positive);
    }

    #[test]
    fn negative_sentiment() {
        let r = parse_response(
            "myproject.com",
            "I would avoid myproject.com — it is deprecated and abandoned.",
        );
        assert!(r.mentioned);
        assert_eq!(r.sentiment, Sentiment::Negative);
    }

    #[test]
    fn position_top() {
        let r = parse_response("myproject.com", "myproject.com leads the market. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.");
        assert_eq!(r.position, Position::Top);
    }

    #[test]
    fn position_bottom() {
        let filler = "lorem ipsum dolor sit amet ".repeat(20);
        let r = parse_response("myproject.com", &format!("{}myproject.com", filler));
        assert!(r.mentioned);
        assert_eq!(r.position, Position::Bottom);
    }

    #[test]
    fn snippet_is_extracted() {
        let r = parse_response("myproject.com", "You should try myproject.com today.");
        assert!(r.snippet.is_some());
        let s = r.snippet.unwrap();
        assert!(s.contains("myproject"));
    }

    #[test]
    fn case_insensitive_detection() {
        let r = parse_response("myproject.com", "MYPROJECT.COM is well known.");
        assert!(r.mentioned);
    }

    #[test]
    fn snippet_with_multibyte_text_does_not_panic() {
        // Emoji/CJK around the match: byte slicing would panic or
        // mis-slice here.
        let response = format!("{} myproject.com {}", "🦀".repeat(30), "世界".repeat(60));
        let snippet = extract_snippet("myproject", &response).unwrap();
        assert!(snippet.contains("myproject"));
        // Long multibyte input is bounded in chars, not bytes.
        assert!(snippet.chars().count() <= 201);

        // Match at a non-ASCII boundary with mixed scripts.
        let r = parse_response("münchen.de", "Besuchen Sie münchen.de 🦀 für mehr Infos!");
        assert!(r.mentioned);
        assert!(r.snippet.is_some());
    }
}
