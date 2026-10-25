// The server's folders, in the order and with the Czech names Thunderbird uses

use async_imap::types::NameAttribute;
use base64::Engine;

#[derive(Debug, Clone, PartialEq)]
pub struct FolderInfo {
    // Stable ID used in the emails table: a role (inbox, sent, …) or "folder:<server name>"
    pub id: String,
    pub server_name: String,
    pub role: Option<&'static str>,
    pub label: String,
    pub depth: usize,
    pub position: i64,
}

// Special folders: role, Czech name, position (as in Thunderbird)
const ROLES: [(&str, &str, i64); 6] = [
    ("inbox", "Doručená pošta", 0),
    ("drafts", "Koncepty", 1),
    ("sent", "Odeslaná pošta", 2),
    ("archive", "Archiv", 3),
    ("spam", "Nevyžádaná pošta", 4),
    ("trash", "Koš", 5),
];

// Names of folders Seznam creates, for servers that don't mark folders by role
const SEZNAM_NAMES: [(&str, &str); 6] = [
    ("sent", "sent"),
    ("trash", "trash"),
    ("drafts", "drafts"),
    ("spam", "spam"),
    ("archive", "archive"),
    ("newsletters", "Hromadné"),
];

// IMAP folder names use "modified UTF-7": non-ASCII text is written as &<base64 of UTF-16>-
pub fn decode_folder_name(name: &str) -> String {
    let mut out = String::new();
    let mut rest = name;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('-') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let encoded = &after[..end];
        if encoded.is_empty() {
            out.push('&');
        } else {
            let decoded = base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(encoded.replace(',', "/"))
                .ok()
                .and_then(|bytes| {
                    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                    String::from_utf16(&units).ok()
                });
            match decoded {
                Some(text) => out.push_str(&text),
                None => out.push_str(&rest[start..start + 1 + end + 1]),
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn role_from_attributes(attributes: &[NameAttribute]) -> Option<&'static str> {
    attributes.iter().find_map(|a| match a {
        NameAttribute::Sent => Some("sent"),
        NameAttribute::Trash => Some("trash"),
        NameAttribute::Drafts => Some("drafts"),
        NameAttribute::Junk => Some("spam"),
        NameAttribute::Archive => Some("archive"),
        _ => None,
    })
}

// Build the folder list from LIST results: (server name, attributes, delimiter)
pub fn classify(folders: &[(String, Vec<NameAttribute<'_>>, Option<String>)]) -> Vec<FolderInfo> {
    let mut result: Vec<FolderInfo> = Vec::new();
    let mut taken: Vec<&str> = Vec::new();

    let selectable = folders.iter().filter(|(_, attributes, _)| {
        !attributes.iter().any(|a| {
            matches!(a, NameAttribute::NoSelect)
                || matches!(a, NameAttribute::Extension(e) if e.eq_ignore_ascii_case("\\NonExistent"))
        })
    });
    // Roles marked by the server win over guesses from names
    let mut ordered: Vec<_> = selectable.collect();
    ordered.sort_by_key(|(_, attributes, _)| role_from_attributes(attributes).is_none());

    for (server_name, attributes, delimiter) in ordered {
        let lower = server_name.to_lowercase();
        let named_role = SEZNAM_NAMES
            .iter()
            .find(|(name, _)| *name == lower)
            .and_then(|(name, _)| ROLES.iter().find(|(r, ..)| r == name).map(|(r, ..)| *r));
        let role = if lower == "inbox" {
            Some("inbox")
        } else {
            role_from_attributes(attributes).or(named_role)
        }
        .filter(|role| !taken.contains(role));

        let segments: Vec<&str> = match delimiter.as_deref().filter(|d| !d.is_empty()) {
            Some(d) => server_name.split(d).collect(),
            None => vec![server_name.as_str()],
        };
        let own_name = decode_folder_name(segments.last().copied().unwrap_or(server_name));
        let (id, label, position) = match role {
            Some(role) => {
                taken.push(role);
                let (_, label, position) = ROLES.iter().find(|(r, ..)| *r == role).unwrap();
                (role.to_string(), label.to_string(), *position)
            }
            None => {
                let label = SEZNAM_NAMES
                    .iter()
                    .find(|(name, _)| *name == lower)
                    .map_or(own_name, |(_, label)| label.to_string());
                (format!("folder:{server_name}"), label, 10)
            }
        };
        result.push(FolderInfo {
            id,
            server_name: server_name.clone(),
            role,
            label,
            depth: segments.len() - 1,
            position,
        });
    }

    // Special folders first, then the others by full path so subfolders follow their parent
    result.sort_by(|a, b| {
        a.position
            .cmp(&b.position)
            .then_with(|| decode_folder_name(&a.server_name).to_lowercase().cmp(&decode_folder_name(&b.server_name).to_lowercase()))
    });
    for (i, folder) in result.iter_mut().enumerate() {
        folder.position = i as i64;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(entries: &[(&str, Vec<NameAttribute<'static>>)]) -> Vec<(String, Vec<NameAttribute<'static>>, Option<String>)> {
        entries
            .iter()
            .map(|(name, attributes)| (name.to_string(), attributes.clone(), Some("|".to_string())))
            .collect()
    }

    #[test]
    fn seznam_folders_get_thunderbird_names_and_order() {
        let folders = classify(&list(&[
            ("INBOX", vec![]),
            ("sent", vec![NameAttribute::Sent]),
            ("drafts", vec![NameAttribute::Drafts]),
            ("newsletters", vec![]),
            ("archive", vec![NameAttribute::Archive]),
            ("spam", vec![NameAttribute::Junk]),
            ("trash", vec![NameAttribute::Trash]),
            ("Rodina", vec![]),
            ("Rodina|Vnoučata", vec![]),
            ("Nic", vec![NameAttribute::NoSelect]),
        ]));
        let shown: Vec<(&str, &str, usize)> = folders.iter().map(|f| (f.id.as_str(), f.label.as_str(), f.depth)).collect();
        assert_eq!(
            shown,
            vec![
                ("inbox", "Doručená pošta", 0),
                ("drafts", "Koncepty", 0),
                ("sent", "Odeslaná pošta", 0),
                ("archive", "Archiv", 0),
                ("spam", "Nevyžádaná pošta", 0),
                ("trash", "Koš", 0),
                ("folder:newsletters", "Hromadné", 0),
                ("folder:Rodina", "Rodina", 0),
                ("folder:Rodina|Vnoučata", "Vnoučata", 1),
            ]
        );
    }

    #[test]
    fn folders_without_role_flags_are_recognised_by_name() {
        let folders = classify(&list(&[("INBOX", vec![]), ("Sent", vec![]), ("Trash", vec![])]));
        let ids: Vec<&str> = folders.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["inbox", "sent", "trash"]);
    }

    #[test]
    fn non_ascii_folder_names_are_decoded() {
        assert_eq!(decode_folder_name("&AMk-ty"), "Éty");
        assert_eq!(decode_folder_name("&ANo-čty"), "Účty");
        assert_eq!(decode_folder_name("Faktury &- účtenky"), "Faktury & účtenky");
        assert_eq!(decode_folder_name("Pr&AOE-ce"), "Práce");
        assert_eq!(decode_folder_name("Pr&AW8-ce"), "Průce");
    }
}
