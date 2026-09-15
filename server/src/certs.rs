/// Self-signed certificate generation for development.
///
/// WebTransport requires TLS. For local development, we generate
/// self-signed certificates at startup and output the SHA-256 hash
/// so the browser client can use `serverCertificateHashes`.
use rcgen::{CertificateParams, KeyPair, SanType};
use ring::digest;
use std::path::Path;

/// Generated certificate and key material.
pub struct CertificateInfo {
    /// PEM-encoded certificate.
    pub cert_pem: String,
    /// PEM-encoded private key.
    pub key_pem: String,
    /// DER-encoded certificate (for hash computation).
    pub cert_der: Vec<u8>,
    /// SHA-256 hash of the DER-encoded certificate.
    pub cert_hash: Vec<u8>,
    /// Base64-encoded SHA-256 hash (for display/config).
    pub cert_hash_base64: String,
}

/// Generate a self-signed certificate for local development.
pub fn generate_self_signed_cert() -> Result<CertificateInfo, Box<dyn std::error::Error>> {
    let mut params = CertificateParams::new(vec!["localhost".to_string()])?;

    // Add SANs
    params.subject_alt_names = vec![
        SanType::DnsName("localhost".try_into()?),
        SanType::IpAddress(std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))),
        SanType::IpAddress(std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)),
    ];

    // Short validity for dev certs (14 days — WebTransport spec limit for hash-pinned certs)
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::minutes(5);
    params.not_after = now + time::Duration::days(13);

    let key_pair = KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    let cert_pem = cert.pem();
    let key_pem = key_pair.serialize_pem();
    let cert_der = cert.der().to_vec();

    // Compute SHA-256 hash
    let hash = digest::digest(&digest::SHA256, &cert_der);
    let cert_hash = hash.as_ref().to_vec();
    let cert_hash_base64 =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &cert_hash);

    Ok(CertificateInfo {
        cert_pem,
        key_pem,
        cert_der,
        cert_hash,
        cert_hash_base64,
    })
}

/// Save certificate files to disk.
pub fn save_certs(info: &CertificateInfo, dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("cert.pem"), &info.cert_pem)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut key = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(dir.join("key.pem"))?;
        key.write_all(info.key_pem.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(dir.join("key.pem"), &info.key_pem)?;
    std::fs::write(dir.join("cert.der"), &info.cert_der)?;

    tracing::info!("Certificates saved to {}", dir.display());
    tracing::info!(
        "Certificate SHA-256 hash (base64): {}",
        info.cert_hash_base64
    );
    tracing::info!(
        "Certificate SHA-256 hash (hex): {}",
        info.cert_hash
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<Vec<_>>()
            .join(":")
    );

    Ok(())
}
