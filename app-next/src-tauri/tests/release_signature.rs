use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::{env, fs, path::PathBuf};

#[test]
#[ignore = "formal release artifact gate"]
fn formal_installer_matches_manifest_and_embedded_updater_key() {
    let release_root = PathBuf::from(
        env::var("AI_SKILLHUB_RELEASE_ROOT")
            .expect("AI_SKILLHUB_RELEASE_ROOT must point to the formal release directory"),
    );
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(release_root.join("latest.json"))
            .expect("latest.json should be readable"),
    )
    .expect("latest.json should parse");
    let version = manifest["version"]
        .as_str()
        .expect("manifest version should be present");
    let installer = release_root.join(format!("AI-SkillHub-{version}-setup.exe"));
    let signature_file = release_root.join(format!("AI-SkillHub-{version}-setup.exe.sig"));
    let manifest_signature = manifest["platforms"]["windows-x86_64"]["signature"]
        .as_str()
        .expect("manifest signature should be present");
    let file_signature =
        fs::read_to_string(&signature_file).expect("signature file should be readable");
    assert_eq!(manifest_signature.trim(), file_signature.trim());

    let config_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let config: Value = serde_json::from_str(
        &fs::read_to_string(config_path).expect("tauri.conf.json should be readable"),
    )
    .expect("tauri.conf.json should parse");
    let encoded_public_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .expect("updater public key should be present");
    let public_key_text = String::from_utf8(
        STANDARD
            .decode(encoded_public_key)
            .expect("updater public key should be base64"),
    )
    .expect("decoded updater public key should be UTF-8");
    let public_key = PublicKey::decode(&public_key_text).expect("updater public key should decode");
    let signature_text = String::from_utf8(
        STANDARD
            .decode(manifest_signature)
            .expect("release signature should be base64"),
    )
    .expect("decoded release signature should be UTF-8");
    let signature = Signature::decode(&signature_text).expect("release signature should decode");
    let installer_bytes = fs::read(installer).expect("release installer should be readable");

    public_key
        .verify(&installer_bytes, &signature, false)
        .expect("release installer signature should verify");
}
