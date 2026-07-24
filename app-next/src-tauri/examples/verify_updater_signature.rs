use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().collect::<Vec<_>>();
    if args.len() != 4 {
        return Err("usage: verify_updater_signature <artifact> <signature> <public-key>".into());
    }

    let artifact = fs::read(Path::new(&args[1]))?;
    let encoded_signature = fs::read_to_string(Path::new(&args[2]))?;
    let encoded_public_key = fs::read_to_string(Path::new(&args[3]))?;
    let signature_text = String::from_utf8(STANDARD.decode(encoded_signature.trim())?)?;
    let public_key_text = String::from_utf8(STANDARD.decode(encoded_public_key.trim())?)?;
    let public_key_line = public_key_text
        .lines()
        .nth(1)
        .ok_or("encoded public key is missing its key line")?;

    let public_key = PublicKey::from_base64(public_key_line)?;
    let signature = Signature::decode(&signature_text)?;
    public_key.verify(&artifact, &signature, false)?;

    println!("Updater signature verified.");
    Ok(())
}
