//! Order-preserving JSON documents for client configuration files.
//!
//! `serde_json::Value` sorts object keys in this crate (the `preserve_order`
//! feature is deliberately off, see docs/v3.3/mcp-contract.md §2.6), so a
//! parse/serialise round trip of `~/.claude.json` would reorder every key. This
//! module keeps keys in document order, detects the original indentation,
//! line endings, BOM and trailing newline, and renders the document back so a
//! one-entry change only touches that entry's lines.
//!
//! This module never starts a process and never logs values.

use indexmap::IndexMap;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use serde_json::Value as JsonValue;
use std::fmt;

/// An order-preserving JSON value.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Node>),
    Object(IndexMap<String, Node>),
}

impl Node {
    pub(crate) fn object() -> Self {
        Node::Object(IndexMap::new())
    }

    pub(crate) fn string(value: impl Into<String>) -> Self {
        Node::String(value.into())
    }

    pub(crate) fn string_array<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Node::Array(values.into_iter().map(|v| Node::String(v.into())).collect())
    }

    pub(crate) fn as_object(&self) -> Option<&IndexMap<String, Node>> {
        match self {
            Node::Object(map) => Some(map),
            _ => None,
        }
    }

    pub(crate) fn as_object_mut(&mut self) -> Option<&mut IndexMap<String, Node>> {
        match self {
            Node::Object(map) => Some(map),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Node::String(value) => Some(value),
            _ => None,
        }
    }

    pub(crate) fn as_bool(&self) -> Option<bool> {
        match self {
            Node::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub(crate) fn as_array(&self) -> Option<&Vec<Node>> {
        match self {
            Node::Array(items) => Some(items),
            _ => None,
        }
    }

    pub(crate) fn get(&self, key: &str) -> Option<&Node> {
        self.as_object().and_then(|map| map.get(key))
    }

    /// Converts to a `serde_json::Value` (keys become sorted). Used for
    /// canonical comparison only, never for writing files.
    pub(crate) fn to_value(&self) -> JsonValue {
        match self {
            Node::Null => JsonValue::Null,
            Node::Bool(value) => JsonValue::Bool(*value),
            Node::Number(value) => JsonValue::Number(value.clone()),
            Node::String(value) => JsonValue::String(value.clone()),
            Node::Array(items) => JsonValue::Array(items.iter().map(Node::to_value).collect()),
            Node::Object(map) => JsonValue::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), value.to_value()))
                    .collect(),
            ),
        }
    }

    pub(crate) fn from_value(value: &JsonValue) -> Self {
        match value {
            JsonValue::Null => Node::Null,
            JsonValue::Bool(value) => Node::Bool(*value),
            JsonValue::Number(value) => Node::Number(value.clone()),
            JsonValue::String(value) => Node::String(value.clone()),
            JsonValue::Array(items) => Node::Array(items.iter().map(Node::from_value).collect()),
            JsonValue::Object(map) => Node::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), Node::from_value(value)))
                    .collect(),
            ),
        }
    }
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Node::Null => serializer.serialize_unit(),
            Node::Bool(value) => serializer.serialize_bool(*value),
            Node::Number(value) => value.serialize(serializer),
            Node::String(value) => serializer.serialize_str(value),
            Node::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Node::Object(map) => {
                let mut out = serializer.serialize_map(Some(map.len()))?;
                for (key, value) in map {
                    out.serialize_entry(key, value)?;
                }
                out.end()
            }
        }
    }
}

struct NodeVisitor;

impl<'de> Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Node, E> {
        Ok(Node::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Node, E> {
        Ok(Node::Number(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Node, E> {
        Ok(Node::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Node, E> {
        serde_json::Number::from_f64(value)
            .map(Node::Number)
            .ok_or_else(|| E::custom("non-finite number"))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Node, E> {
        Ok(Node::String(value.to_string()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Node, E> {
        Ok(Node::String(value))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Node, D::Error> {
        Deserialize::deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Node>()? {
            items.push(item);
        }
        Ok(Node::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Node, A::Error> {
        let mut map = IndexMap::new();
        while let Some((key, value)) = access.next_entry::<String, Node>()? {
            map.insert(key, value);
        }
        Ok(Node::Object(map))
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Node, D::Error> {
        deserializer.deserialize_any(NodeVisitor)
    }
}

/// A strict-JSON document plus the formatting facts needed to write it back.
#[derive(Debug, Clone)]
pub(crate) struct JsonDoc {
    pub root: Node,
    indent: Option<Vec<u8>>,
    trailing_newline: bool,
    bom: bool,
    crlf: bool,
}

impl JsonDoc {
    /// An empty object document for a file that does not exist yet.
    pub(crate) fn new_empty() -> Self {
        Self {
            root: Node::object(),
            indent: Some(b"  ".to_vec()),
            trailing_newline: true,
            bom: false,
            crlf: false,
        }
    }

    /// Parses strict JSON only (no comments, no trailing commas).
    pub(crate) fn parse(text: &str) -> Result<Self, ()> {
        let bom = text.starts_with('\u{feff}');
        let body = text.trim_start_matches('\u{feff}');
        let root: Node = serde_json::from_str(body).map_err(|_| ())?;
        Ok(Self {
            root,
            indent: detect_indent(body),
            trailing_newline: body.ends_with('\n'),
            bom,
            crlf: body.contains("\r\n"),
        })
    }

    pub(crate) fn render(&self) -> Result<String, ()> {
        let mut out = Vec::new();
        match &self.indent {
            Some(indent) => {
                let formatter = serde_json::ser::PrettyFormatter::with_indent(indent);
                let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
                self.root.serialize(&mut serializer).map_err(|_| ())?;
            }
            None => {
                let mut serializer = serde_json::Serializer::new(&mut out);
                self.root.serialize(&mut serializer).map_err(|_| ())?;
            }
        }
        let mut text = String::from_utf8(out).map_err(|_| ())?;
        if self.trailing_newline {
            text.push('\n');
        }
        if self.crlf {
            text = text.replace('\n', "\r\n");
        }
        if self.bom {
            text.insert(0, '\u{feff}');
        }
        Ok(text)
    }
}

/// Finds the indentation unit from the first indented line. `None` means the
/// document is compact (single line) and is written back compact.
fn detect_indent(text: &str) -> Option<Vec<u8>> {
    let trimmed = text.trim();
    if !trimmed.contains('\n') {
        return if trimmed.len() <= 2 {
            Some(b"  ".to_vec())
        } else {
            None
        };
    }
    for line in text.lines().skip(1) {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let leading = line.len() - line.trim_start_matches([' ', '\t']).len();
        if leading == 0 {
            continue;
        }
        let unit = &line[..leading];
        if unit.starts_with('\t') {
            return Some(b"\t".to_vec());
        }
        return Some(vec![b' '; leading.min(8)]);
    }
    Some(b"  ".to_vec())
}

/// Parses JSONC (comments, trailing commas) into an order-preserving node.
/// Used for read-only views of files SkillHub refuses to write.
pub(crate) fn parse_jsonc_node(text: &str) -> Result<Node, ()> {
    let body = text.trim_start_matches('\u{feff}');
    let stripped = crate::mcp_center::strip_json_comments(body)?;
    let cleaned = crate::mcp_center::strip_json_trailing_commas(&stripped);
    serde_json::from_str(&cleaned).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_keeps_order_indent_and_newline() {
        let text = "{\n    \"zeta\": 1,\n    \"alpha\": {\n        \"b\": [\n            \"x\"\n        ],\n        \"a\": true\n    },\n    \"empty\": {},\n    \"list\": []\n}\n";
        let doc = JsonDoc::parse(text).unwrap();
        assert_eq!(doc.render().unwrap(), text);
    }

    #[test]
    fn compact_documents_stay_compact_and_crlf_and_bom_survive() {
        let compact = "{\"b\":1,\"a\":{\"z\":null,\"y\":\"s\"}}";
        assert_eq!(JsonDoc::parse(compact).unwrap().render().unwrap(), compact);
        let crlf = "\u{feff}{\r\n\t\"b\": 1,\r\n\t\"a\": 2\r\n}\r\n";
        assert_eq!(JsonDoc::parse(crlf).unwrap().render().unwrap(), crlf);
    }

    #[test]
    fn jsonc_is_rejected_by_strict_parse_but_readable_through_jsonc() {
        let text = "{\n // note\n \"a\": 1,\n}\n";
        assert!(JsonDoc::parse(text).is_err());
        let node = parse_jsonc_node(text).unwrap();
        assert_eq!(node.get("a"), Some(&Node::Number(1.into())));
    }
}
