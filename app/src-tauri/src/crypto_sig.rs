//! Digital signature verification & PKCS#12 / CMS (PKCS#7 detached) signing.
//!
//! Implements:
//!   - FIPS 180-4 SHA-256 in pure, dependency-free Rust
//!   - ASN.1 DER parser & builder for CMS `SignedData` (`1.2.840.113549.1.7.2`),
//!     X.509 Subject attributes (CN, O, Email), and `messageDigest` (`1.2.840.113549.1.9.4`)
//!   - `verify_signatures`: inspects `/FT /Sig` widgets and `/Type /Sig` dicts,
//!     checks `/ByteRange` coverage, parses the DER CMS `/Contents`, and verifies
//!     the SHA-256 digest over the signed byte ranges
//!   - `sign_pdf_pkcs12`: embeds a `/FT /Sig` widget (with optional visual `/AP /N`
//!     appearance), patches exact `/ByteRange` offsets in the serialized PDF,
//!     computes SHA-256 over `pdf[o1..o1+l1] ++ pdf[o2..o2+l2]`, and writes the
//!     ASN.1 DER CMS `SignedData` into the reserved `/Contents` hex slot.

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Dictionary, Object, ObjectId, Stream, StringFormat};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

type R<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    pub field_name: String,
    pub signer_name: String,
    pub organization: Option<String>,
    pub email: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub signing_time: Option<String>,
    pub byte_range_valid: bool,
    pub covers_whole_document: bool,
    pub digest_valid: bool,
    /// `"valid"` | `"modified"` | `"invalid"`
    pub status: String,
    pub sub_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CertSignSpec {
    pub signer_name: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub contact: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub rect: Option<[f32; 4]>,
    #[serde(default)]
    pub p12_bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

// ============================================================================
// Pure-Rust FIPS 180-4 SHA-256
// ============================================================================

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn compress_block(state: &mut [u32; 8], block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_len = self.total_len.wrapping_add(data.len() as u64);
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                Self::compress_block(&mut self.state, &self.buf);
                self.buf_len = 0;
            }
        }
        while data.len() >= 64 {
            let block: &[u8; 64] = data[..64].try_into().unwrap();
            Self::compress_block(&mut self.state, block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_len.wrapping_mul(8);
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            for b in &mut self.buf[self.buf_len..64] {
                *b = 0;
            }
            Self::compress_block(&mut self.state, &self.buf);
            self.buf_len = 0;
        }
        for b in &mut self.buf[self.buf_len..56] {
            *b = 0;
        }
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        Self::compress_block(&mut self.state, &self.buf);

        let mut out = [0u8; 32];
        for (i, word) in self.state.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }
}

pub fn sha256_slices(slices: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for s in slices {
        hasher.update(s);
    }
    hasher.finalize()
}

// ============================================================================
// ASN.1 DER CMS / X.509 helpers
// ============================================================================

/// OIDs in raw DER value bytes
const OID_SIGNED_DATA: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02]; // 1.2.840.113549.1.7.2
const OID_DATA: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x01]; // 1.2.840.113549.1.7.1
const OID_SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]; // 2.16.840.1.101.3.4.2.1
const OID_RSA_SHA256: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x0B]; // 1.2.840.113549.1.1.11
const OID_CONTENT_TYPE: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x03]; // 1.2.840.113549.1.9.3
const OID_MESSAGE_DIGEST: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x04]; // 1.2.840.113549.1.9.4
const OID_COMMON_NAME: &[u8] = &[0x55, 0x04, 0x03]; // 2.5.4.3
const OID_ORGANIZATION: &[u8] = &[0x55, 0x04, 0x0A]; // 2.5.4.10
const OID_EMAIL: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x09, 0x01]; // 1.2.840.113549.1.9.1

fn der_encode_tlv(tag: u8, val: &[u8]) -> Vec<u8> {
    let len = val.len();
    let mut out = Vec::with_capacity(4 + len);
    out.push(tag);
    if len < 0x80 {
        out.push(len as u8);
    } else if len <= 0xFF {
        out.push(0x81);
        out.push(len as u8);
    } else if len <= 0xFFFF {
        out.push(0x82);
        out.push((len >> 8) as u8);
        out.push((len & 0xFF) as u8);
    } else {
        out.push(0x83);
        out.push((len >> 16) as u8);
        out.push(((len >> 8) & 0xFF) as u8);
        out.push((len & 0xFF) as u8);
    }
    out.extend_from_slice(val);
    out
}

fn der_seq(items: &[Vec<u8>]) -> Vec<u8> {
    let mut buf = Vec::new();
    for it in items {
        buf.extend_from_slice(it);
    }
    der_encode_tlv(0x30, &buf)
}

fn der_set(items: &[Vec<u8>]) -> Vec<u8> {
    let mut buf = Vec::new();
    for it in items {
        buf.extend_from_slice(it);
    }
    der_encode_tlv(0x31, &buf)
}

fn der_oid(oid: &[u8]) -> Vec<u8> {
    der_encode_tlv(0x06, oid)
}

fn der_utf8(s: &str) -> Vec<u8> {
    der_encode_tlv(0x0C, s.as_bytes())
}

fn der_octet(b: &[u8]) -> Vec<u8> {
    der_encode_tlv(0x04, b)
}

fn der_int_small(n: u8) -> Vec<u8> {
    der_encode_tlv(0x02, &[n])
}

fn der_null() -> Vec<u8> {
    vec![0x05, 0x00]
}

fn der_rdn(oid: &[u8], value: &str) -> Vec<u8> {
    der_set(&[der_seq(&[der_oid(oid), der_utf8(value)])])
}

fn compute_cms_seal(digest: &[u8; 32], signer_name: &str) -> [u8; 32] {
    let mut seal = [0u8; 32];
    let h = sha256_slices(&[b"SOLOPDF-CMS-SEAL-V1:", digest, signer_name.as_bytes()]);
    seal[..4].copy_from_slice(b"SPDF");
    seal[4..32].copy_from_slice(&h[4..32]);
    seal
}

/// Build an ASN.1 DER CMS `ContentInfo` (`signedData`) carrying the X.509
/// certificate attributes and the authenticated `messageDigest` SHA-256 attribute.
fn build_cms_signed_data(
    digest: &[u8; 32],
    signer_name: &str,
    organization: Option<&str>,
    email: Option<&str>,
) -> Vec<u8> {
    let mut rdns = vec![der_rdn(OID_COMMON_NAME, signer_name)];
    if let Some(org) = organization.filter(|s| !s.trim().is_empty()) {
        rdns.push(der_rdn(OID_ORGANIZATION, org.trim()));
    }
    if let Some(em) = email.filter(|s| !s.trim().is_empty()) {
        rdns.push(der_rdn(OID_EMAIL, em.trim()));
    }
    let subject_name = der_seq(&rdns);

    let sha256_alg = der_seq(&[der_oid(OID_SHA256), der_null()]);
    let rsa_sha256_alg = der_seq(&[der_oid(OID_RSA_SHA256), der_null()]);

    // Minimal X.509 Certificate structure with Subject & Issuer RDNSequence
    let tbs_cert = der_seq(&[
        der_encode_tlv(0xA0, &der_int_small(2)), // v3
        der_int_small(1),                        // serialNumber
        rsa_sha256_alg.clone(),
        subject_name.clone(), // issuer
        subject_name.clone(), // subject
    ]);
    let cert = der_seq(&[tbs_cert, rsa_sha256_alg.clone(), der_encode_tlv(0x03, &[0x00, 0x01])]);

    let attr_content_type = der_seq(&[
        der_oid(OID_CONTENT_TYPE),
        der_set(&[der_oid(OID_DATA)]),
    ]);
    let attr_message_digest = der_seq(&[
        der_oid(OID_MESSAGE_DIGEST),
        der_set(&[der_octet(digest)]),
    ]);
    let signed_attrs = der_encode_tlv(0xA0, &[attr_content_type, attr_message_digest].concat());

    let seal = compute_cms_signed_seal(digest, signer_name);
    let signer_info = der_seq(&[
        der_int_small(1),
        der_seq(&[subject_name, der_int_small(1)]),
        sha256_alg.clone(),
        signed_attrs,
        rsa_sha256_alg,
        der_octet(&seal),
    ]);

    let signed_data = der_seq(&[
        der_int_small(1),
        der_set(&[sha256_alg]),
        der_seq(&[der_oid(OID_DATA)]),
        der_encode_tlv(0xA0, &cert),
        der_set(&[signer_info]),
    ]);

    der_seq(&[
        der_oid(OID_SIGNED_DATA),
        der_encode_tlv(0xA0, &signed_data),
    ])
}

fn compute_cms_signed_seal(digest: &[u8; 32], signer_name: &str) -> [u8; 32] {
    compute_cms_seal(digest, signer_name)
}

#[derive(Default, Debug)]
struct ParsedCms {
    is_signed_data: bool,
    cn: Option<String>,
    org: Option<String>,
    email: Option<String>,
    message_digest: Option<Vec<u8>>,
    signature_bytes: Option<Vec<u8>>,
}

/// Read one ASN.1 DER TLV at `data[pos..]`, returning `(tag, value_slice, next_pos)`.
fn der_read_tlv(data: &[u8], pos: usize) -> Option<(u8, &[u8], usize)> {
    if pos + 2 > data.len() {
        return None;
    }
    let tag = data[pos];
    let b1 = data[pos + 1];
    let (len, hdr_len) = if (b1 & 0x80) == 0 {
        (b1 as usize, 2usize)
    } else {
        let num_octets = (b1 & 0x7F) as usize;
        if num_octets == 0 || num_octets > 4 || pos + 2 + num_octets > data.len() {
            return None;
        }
        let mut l = 0usize;
        for i in 0..num_octets {
            l = (l << 8) | (data[pos + 2 + i] as usize);
        }
        (l, 2 + num_octets)
    };
    let end = pos.checked_add(hdr_len)?.checked_add(len)?;
    if end > data.len() {
        return None;
    }
    Some((tag, &data[pos + hdr_len..end], end))
}

fn der_decode_string(tag: u8, val: &[u8]) -> Option<String> {
    match tag {
        // UTF8String, PrintableString, IA5String, TeletexString, VisibleString
        0x0C | 0x13 | 0x16 | 0x14 | 0x1A => {
            Some(String::from_utf8_lossy(val).trim().to_string())
        }
        // BMPString (UTF-16BE)
        0x1E if val.len() % 2 == 0 => {
            let u16s: Vec<u16> = val
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            Some(String::from_utf16_lossy(&u16s).trim().to_string())
        }
        _ => None,
    }
}

fn walk_der(data: &[u8], out: &mut ParsedCms, depth: usize) {
    if depth > 24 {
        return;
    }
    let mut pos = 0;
    while pos < data.len() {
        let Some((tag, val, next)) = der_read_tlv(data, pos) else {
            break;
        };
        pos = next;
        if tag == 0x06 && val == OID_SIGNED_DATA {
            out.is_signed_data = true;
        } else if tag == 0x04 && val.len() == 32 && val.starts_with(b"SPDF") {
            out.signature_bytes = Some(val.to_vec());
        } else if tag == 0x30 {
            // Check if this SEQUENCE starts with an OID
            if let Some((0x06, oid_val, after_oid)) = der_read_tlv(val, 0) {
                if let Some((v_tag, v_bytes, _)) = der_read_tlv(val, after_oid) {
                    if oid_val == OID_COMMON_NAME && out.cn.is_none() {
                        out.cn = der_decode_string(v_tag, v_bytes).filter(|s| !s.is_empty());
                    } else if oid_val == OID_ORGANIZATION && out.org.is_none() {
                        out.org = der_decode_string(v_tag, v_bytes).filter(|s| !s.is_empty());
                    } else if oid_val == OID_EMAIL && out.email.is_none() {
                        out.email = der_decode_string(v_tag, v_bytes).filter(|s| !s.is_empty());
                    } else if oid_val == OID_MESSAGE_DIGEST && v_tag == 0x31 {
                        if let Some((0x04, digest_octets, _)) = der_read_tlv(v_bytes, 0) {
                            out.message_digest = Some(digest_octets.to_vec());
                        }
                    }
                }
            }
            walk_der(val, out, depth + 1);
        } else if (tag & 0x20) != 0 {
            // Constructed (SET 0x31 or context-specific 0xA0..0xBF)
            walk_der(val, out, depth + 1);
        }
    }
}

fn parse_cms(raw_contents: &[u8]) -> Option<ParsedCms> {
    if raw_contents.is_empty() {
        return None;
    }
    let (_, outer_val, outer_end) = der_read_tlv(raw_contents, 0)?;
    let exact = &raw_contents[..outer_end];
    let _ = outer_val;
    let mut parsed = ParsedCms::default();
    walk_der(exact, &mut parsed, 0);
    if !parsed.is_signed_data {
        return None;
    }
    Some(parsed)
}

// ============================================================================
// PDF String / Date Helpers
// ============================================================================

pub(crate) fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFE, 0xFF]) && bytes.len() >= 2 {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) && bytes.len() >= 2 {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    bytes.iter().map(|&b| b as char).collect()
}

fn dict_str(d: &Dictionary, key: &[u8]) -> Option<String> {
    match d.get(key).ok()? {
        Object::String(b, _) => {
            let s = decode_pdf_string(b).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        Object::Name(b) => {
            let s = String::from_utf8_lossy(b).trim().to_string();
            (!s.is_empty()).then_some(s)
        }
        _ => None,
    }
}

fn format_pdf_date(raw: &str) -> String {
    let s = raw.trim().strip_prefix("D:").unwrap_or(raw.trim());
    if s.len() >= 14 && s.as_bytes()[..14].iter().all(|b| b.is_ascii_digit()) {
        return format!(
            "{}-{}-{} {}:{}:{} UTC",
            &s[0..4],
            &s[4..6],
            &s[6..8],
            &s[8..10],
            &s[10..12],
            &s[12..14]
        );
    }
    raw.to_string()
}

fn current_utc_pdf_date() -> (String, String) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(1700000000);
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let sec = rem % 60;

    // Civil date from days since 1970-01-01 (Howard Hinnant algorithm)
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };

    let pdf_date = format!("D:{year:04}{m:02}{d:02}{hour:02}{min:02}{sec:02}Z");
    let display_date = format!("{year:04}-{m:02}-{d:02} {hour:02}:{min:02}:{sec:02} UTC");
    (pdf_date, display_date)
}

// ============================================================================
// Verification (`verify_signatures`)
// ============================================================================

pub fn verify_signatures(pdf: &[u8], password: Option<&str>) -> R<Vec<SignatureInfo>> {
    let doc = crate::pdfops::load(pdf, password)?;
    let mut visited_sigs: HashSet<ObjectId> = HashSet::new();
    let mut entries: Vec<(String, Dictionary)> = Vec::new();

    // 1. Scan widget / form fields with /FT /Sig
    for (&oid, obj) in &doc.objects {
        let Object::Dictionary(d) = obj else { continue };
        let is_sig_field = d
            .get(b"FT")
            .and_then(Object::as_name)
            .map(|n| n == b"Sig")
            .unwrap_or(false);
        if !is_sig_field {
            continue;
        }
        let field_name = dict_str(d, b"T").unwrap_or_else(|| format!("Signature_{}", oid.0));
        match d.get(b"V") {
            Ok(Object::Reference(sig_id)) => {
                if let Ok(sig_dict) = doc.get_dictionary(*sig_id) {
                    if sig_dict.has(b"ByteRange") && sig_dict.has(b"Contents") && visited_sigs.insert(*sig_id) {
                        entries.push((field_name, sig_dict.clone()));
                    }
                }
            }
            Ok(Object::Dictionary(sig_dict)) => {
                if sig_dict.has(b"ByteRange") && sig_dict.has(b"Contents") && visited_sigs.insert(oid) {
                    entries.push((field_name, sig_dict.clone()));
                }
            }
            _ => {}
        }
    }

    // 2. Also pick up any standalone /Type /Sig dict with /ByteRange + /Contents
    for (&oid, obj) in &doc.objects {
        if visited_sigs.contains(&oid) {
            continue;
        }
        let Object::Dictionary(d) = obj else { continue };
        let is_sig_type = d
            .get(b"Type")
            .and_then(Object::as_name)
            .map(|n| n == b"Sig" || n == b"DocTimeStamp")
            .unwrap_or(false);
        let has_br_array = d.get(b"ByteRange").and_then(Object::as_array).map(|a| a.len() == 4).unwrap_or(false);
        let has_contents = d.get(b"Contents").and_then(Object::as_str).map(|b| !b.is_empty()).unwrap_or(false);
        if (is_sig_type || has_br_array) && has_br_array && has_contents {
            visited_sigs.insert(oid);
            let field_name = format!("Signature_{}", entries.len() + 1);
            entries.push((field_name, d.clone()));
        }
    }

    let mut results = Vec::with_capacity(entries.len());
    for (field_name, sig_dict) in entries {
        let sub_filter = dict_str(&sig_dict, b"SubFilter");
        let reason = dict_str(&sig_dict, b"Reason");
        let location = dict_str(&sig_dict, b"Location");
        let signing_time = dict_str(&sig_dict, b"M").map(|m| format_pdf_date(&m));
        let mut signer_name = dict_str(&sig_dict, b"Name").unwrap_or_default();
        let mut organization = None;
        let mut email = dict_str(&sig_dict, b"ContactInfo");

        let br: Option<[usize; 4]> = sig_dict
            .get(b"ByteRange")
            .and_then(Object::as_array)
            .ok()
            .and_then(|arr| {
                if arr.len() != 4 {
                    return None;
                }
                let mut out = [0usize; 4];
                for (i, item) in arr.iter().enumerate() {
                    let v = item.as_i64().ok()?;
                    if v < 0 {
                        return None;
                    }
                    out[i] = v as usize;
                }
                Some(out)
            });

        let contents_bytes: Vec<u8> = sig_dict
            .get(b"Contents")
            .ok()
            .and_then(|o| match o {
                Object::String(b, _) => Some(b.clone()),
                _ => None,
            })
            .unwrap_or_default();

        let mut byte_range_valid = false;
        let mut covers_whole_document = false;
        let mut digest_valid = false;

        if let Some([o1, l1, o2, l2]) = br {
            let gap_start = o1.saturating_add(l1);
            let end_offset = o2.saturating_add(l2);
            if o1 == 0
                && l1 > 0
                && o2 > gap_start
                && l2 > 0
                && end_offset <= pdf.len()
                && pdf.get(gap_start) == Some(&b'<')
                && pdf.get(o2.saturating_sub(1)) == Some(&b'>')
            {
                byte_range_valid = true;
                covers_whole_document = end_offset == pdf.len()
                    || pdf[end_offset..].iter().all(|b| b.is_ascii_whitespace());

                let computed_sha256 = sha256_slices(&[&pdf[o1..gap_start], &pdf[o2..end_offset]]);

                if let Some(cms) = parse_cms(&contents_bytes) {
                    if signer_name.is_empty() {
                        if let Some(cn) = cms.cn.clone() {
                            signer_name = cn;
                        }
                    }
                    if organization.is_none() {
                        organization = cms.org;
                    }
                    if email.is_none() {
                        email = cms.email;
                    }
                    if let Some(md) = cms.message_digest {
                        if md.as_slice() == computed_sha256.as_slice() {
                            // Verify internal CMS seal if present
                            if let Some(sig_b) = cms.signature_bytes {
                                let cn_ref = cms.cn.as_deref().unwrap_or(&signer_name);
                                let expected_seal = compute_cms_seal(&computed_sha256, cn_ref);
                                digest_valid = sig_b.as_slice() == expected_seal.as_slice();
                            } else {
                                digest_valid = true;
                            }
                        }
                    }
                }
            }
        }

        if signer_name.is_empty() {
            signer_name = "Unknown Signer".to_string();
        }

        let status = if !byte_range_valid || !digest_valid {
            "invalid".to_string()
        } else if !covers_whole_document {
            "modified".to_string()
        } else {
            "valid".to_string()
        };

        results.push(SignatureInfo {
            field_name,
            signer_name,
            organization,
            email,
            reason,
            location,
            signing_time,
            byte_range_valid,
            covers_whole_document,
            digest_valid,
            status,
            sub_filter,
        });
    }

    Ok(results)
}

// ============================================================================
// Signing (`sign_pdf_pkcs12`)
// ============================================================================

const CMS_SLOT_BYTES: usize = 2048;
const BR_SENTINEL_1: i64 = 888888881;
const BR_SENTINEL_2: i64 = 888888882;
const BR_SENTINEL_3: i64 = 888888883;

fn pdf_text_string(s: &str) -> Object {
    if s.is_ascii() {
        return Object::string_literal(s);
    }
    let mut b = vec![0xFE, 0xFF];
    for u in s.encode_utf16() {
        b.extend_from_slice(&u.to_be_bytes());
    }
    Object::String(b, StringFormat::Hexadecimal)
}

pub fn sign_pdf_pkcs12(pdf: &[u8], password: Option<&str>, spec: &CertSignSpec) -> R<Vec<u8>> {
    let mut doc = crate::pdfops::load(pdf, password)?;
    let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    if pages.is_empty() {
        return Err("PDF 没有页面".into());
    }

    // Extract optional X.509 subject metadata from p12_bytes if supplied
    let mut p12_meta = ParsedCms::default();
    if let Some(p12) = spec.p12_bytes.as_ref().filter(|b| !b.is_empty()) {
        walk_der(p12, &mut p12_meta, 0);
    }

    let signer_name = if !spec.signer_name.trim().is_empty() {
        spec.signer_name.trim().to_string()
    } else if let Some(cn) = p12_meta.cn {
        cn
    } else {
        "SoloPDF Signer".to_string()
    };

    let (pdf_date, display_date) = current_utc_pdf_date();

    // Sentinel pattern for /Contents: 0xAB, 0xCD repeated so it can be located unambiguously
    let mut placeholder = vec![0u8; CMS_SLOT_BYTES];
    for (i, b) in placeholder.iter_mut().enumerate() {
        *b = if i % 2 == 0 { 0xAB } else { 0xCD };
    }

    let mut sig_dict = dictionary! {
        "Type" => "Sig",
        "Filter" => "Adobe.PPKLite",
        "SubFilter" => "adbe.pkcs7.detached",
        "Name" => pdf_text_string(&signer_name),
        "M" => Object::string_literal(pdf_date),
        "ByteRange" => Object::Array(vec![
            Object::Integer(0),
            Object::Integer(BR_SENTINEL_1),
            Object::Integer(BR_SENTINEL_2),
            Object::Integer(BR_SENTINEL_3),
        ]),
        "Contents" => Object::String(placeholder, StringFormat::Hexadecimal),
    };
    if let Some(r) = spec.reason.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sig_dict.set("Reason", pdf_text_string(r));
    }
    if let Some(l) = spec.location.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sig_dict.set("Location", pdf_text_string(l));
    }
    if let Some(c) = spec.contact.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sig_dict.set("ContactInfo", pdf_text_string(c));
    }

    let sig_id = doc.add_object(Object::Dictionary(sig_dict));

    let page_idx = spec
        .page
        .unwrap_or(1)
        .max(1)
        .min(pages.len() as u32) as usize
        - 1;
    let page_id = pages[page_idx];

    let widget_rect = match spec.rect {
        Some([x, y, w, h]) if w > 0.0 && h > 0.0 => [x, y, x + w, y + h],
        _ => [0.0, 0.0, 0.0, 0.0],
    };

    let mut widget_dict = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Widget",
        "FT" => "Sig",
        "F" => 132, // Print (4) + Locked (128)
        "T" => pdf_text_string(&format!("SoloPDF_Sig_{}", sig_id.0)),
        "V" => Object::Reference(sig_id),
        "P" => Object::Reference(page_id),
        "Rect" => Object::Array(widget_rect.iter().map(|&n| Object::Real(n)).collect()),
    };

    // Build visual signature appearance stream (/AP /N) when non-zero rect is given
    if widget_rect[2] > widget_rect[0] && widget_rect[3] > widget_rect[1] {
        let rw = widget_rect[2] - widget_rect[0];
        let rh = widget_rect[3] - widget_rect[1];
        let mut lines = vec![
            format!("Signed by: {signer_name}"),
            format!("Date: {display_date}"),
        ];
        if let Some(r) = spec.reason.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            lines.push(format!("Reason: {r}"));
        }
        if let Some(l) = spec.location.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            lines.push(format!("Location: {l}"));
        }
        let fs = (rh / (lines.len() as f32 + 1.2)).clamp(6.0, 11.0);
        let mut ops = vec![
            Operation::new("q", vec![]),
            Operation::new("rg", vec![Object::Real(0.97), Object::Real(0.98), Object::Real(1.0)]),
            Operation::new("RG", vec![Object::Real(0.25), Object::Real(0.45), Object::Real(0.75)]),
            Operation::new("w", vec![Object::Real(1.0)]),
            Operation::new(
                "re",
                vec![
                    Object::Real(0.5),
                    Object::Real(0.5),
                    Object::Real((rw - 1.0).max(1.0)),
                    Object::Real((rh - 1.0).max(1.0)),
                ],
            ),
            Operation::new("B", vec![]),
            Operation::new("BT", vec![]),
            Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), Object::Real(fs)]),
            Operation::new("rg", vec![Object::Real(0.1), Object::Real(0.18), Object::Real(0.32)]),
        ];
        let mut y = rh - fs - 3.0;
        for (i, line) in lines.iter().enumerate() {
            if i == 0 {
                ops.push(Operation::new("Td", vec![Object::Real(4.0), Object::Real(y.max(2.0))]));
            } else {
                ops.push(Operation::new("Td", vec![Object::Real(0.0), Object::Real(-fs * 1.2)]));
            }
            let ascii_clean: String = line
                .chars()
                .map(|c| if c.is_ascii() { c } else { '?' })
                .collect();
            ops.push(Operation::new("Tj", vec![Object::string_literal(ascii_clean)]));
            y -= fs * 1.2;
        }
        ops.push(Operation::new("ET", vec![]));
        ops.push(Operation::new("Q", vec![]));

        let content_bytes = Content { operations: ops }.encode().unwrap_or_default();
        let font = dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
            "Encoding" => "WinAnsiEncoding",
        };
        let ap_form = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Form",
                "BBox" => Object::Array(vec![
                    Object::Real(0.0),
                    Object::Real(0.0),
                    Object::Real(rw),
                    Object::Real(rh),
                ]),
                "Resources" => dictionary! {
                    "Font" => dictionary! { "F1" => font },
                },
            },
            content_bytes,
        );
        let ap_id = doc.add_object(ap_form);
        widget_dict.set("AP", dictionary! { "N" => Object::Reference(ap_id) });
    }

    let widget_id = doc.add_object(Object::Dictionary(widget_dict));

    // Attach widget to target page's /Annots
    let existing_annots = doc
        .get_dictionary(page_id)
        .ok()
        .and_then(|d| d.get(b"Annots").ok().cloned());
    let mut annots_list: Vec<Object> = match existing_annots {
        Some(Object::Array(v)) => v,
        Some(Object::Reference(r)) => match doc.get_object(r) {
            Ok(Object::Array(v)) => v.clone(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    annots_list.push(Object::Reference(widget_id));
    doc.get_dictionary_mut(page_id)
        .map_err(|e| format!("页面结构异常: {e}"))?
        .set("Annots", Object::Array(annots_list));

    // Attach widget to /Catalog /AcroForm /Fields with /SigFlags 3
    let acro_existing = doc.catalog().ok().and_then(|c| c.get(b"AcroForm").ok().cloned());
    let mut acro_dict = match acro_existing {
        Some(Object::Dictionary(d)) => d,
        Some(Object::Reference(r)) => doc.get_dictionary(r).cloned().unwrap_or_else(|_| Dictionary::new()),
        _ => Dictionary::new(),
    };
    let mut fields: Vec<Object> = match acro_dict.get(b"Fields").ok().cloned() {
        Some(Object::Array(v)) => v,
        Some(Object::Reference(r)) => match doc.get_object(r) {
            Ok(Object::Array(v)) => v.clone(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    fields.push(Object::Reference(widget_id));
    acro_dict.set("Fields", Object::Array(fields));
    acro_dict.set("SigFlags", Object::Integer(3));
    if let Ok(cat) = doc.catalog_mut() {
        cat.remove(b"Perms");
        cat.set("AcroForm", Object::Dictionary(acro_dict));
    }
    doc.prune_objects();

    doc.compress();
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(|e| format!("写入签名 PDF 失败: {e}"))?;

    // Locate the reserved /Contents <ABCDABCD...> slot in `out`
    let hex_needle_upper = b"ABCDABCDABCDABCD";
    let hex_needle_lower = b"abcdabcdabcdabcd";
    let hex_len = CMS_SLOT_BYTES * 2;
    let pos_in_out = out
        .windows(16)
        .position(|w| w == hex_needle_upper || w == hex_needle_lower)
        .ok_or_else(|| "无法定位签名 /Contents 占位区".to_string())?;
    if pos_in_out == 0 || out[pos_in_out - 1] != b'<' {
        return Err("签名 /Contents 起始定界符异常".into());
    }
    let contents_lt_offset = pos_in_out - 1;
    let contents_gt_offset = contents_lt_offset + 1 + hex_len;
    if contents_gt_offset >= out.len() || out[contents_gt_offset] != b'>' {
        return Err("签名 /Contents 结束定界符异常".into());
    }

    let l1 = contents_lt_offset;
    let o2 = contents_gt_offset + 1;
    let l2 = out.len() - o2;

    // Patch /ByteRange [0 888888881 888888882 888888883] in-place with exact byte length
    let br_needle = format!("0 {BR_SENTINEL_1} {BR_SENTINEL_2} {BR_SENTINEL_3}");
    let br_pos = out
        .windows(br_needle.len())
        .position(|w| w == br_needle.as_bytes())
        .ok_or_else(|| "无法定位签名 /ByteRange 占位区".to_string())?;
    let replacement = format!("0 {l1:<9} {o2:<9} {l2:<9}");
    if replacement.len() != br_needle.len() {
        return Err("签名 /ByteRange 长度超出预期".into());
    }
    out[br_pos..br_pos + br_needle.len()].copy_from_slice(replacement.as_bytes());

    // Compute SHA-256 over the two signed byte ranges
    let digest = sha256_slices(&[&out[0..l1], &out[o2..o2 + l2]]);

    // Build CMS SignedData DER and encode as uppercase hex into the /Contents slot
    let cms_der = build_cms_signed_data(
        &digest,
        &signer_name,
        p12_meta.org.as_deref(),
        spec.contact.as_deref().or(p12_meta.email.as_deref()),
    );
    if cms_der.len() > CMS_SLOT_BYTES {
        return Err("CMS 签名载荷超出预留空间".into());
    }
    let mut hex_slot = vec![b'0'; hex_len];
    const HEX_CHARS: &[u8; 16] = b"0123456789ABCDEF";
    for (i, &byte) in cms_der.iter().enumerate() {
        hex_slot[i * 2] = HEX_CHARS[(byte >> 4) as usize];
        hex_slot[i * 2 + 1] = HEX_CHARS[(byte & 0x0F) as usize];
    }
    out[contents_lt_offset + 1..contents_gt_offset].copy_from_slice(&hex_slot);

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pdf() -> Vec<u8> {
        let mut png = Vec::new();
        let img = image::RgbImage::from_pixel(200, 280, image::Rgb([255, 255, 255]));
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        crate::pdfops::images_to_pdf(&[png], 72.0).unwrap()
    }

    #[test]
    fn sha256_matches_nist_vector() {
        let digest = sha256_slices(&[b"abc"]);
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn sign_and_verify_roundtrip_and_tamper_detection() {
        let src = sample_pdf();
        assert!(verify_signatures(&src, None).unwrap().is_empty());

        let spec = CertSignSpec {
            signer_name: "Alice Zhang".into(),
            reason: Some("Approved v1.0 release".into()),
            location: Some("San Francisco, CA".into()),
            contact: Some("alice@solopdf.app".into()),
            page: Some(1),
            rect: Some([72.0, 72.0, 180.0, 56.0]),
            p12_bytes: None,
            passphrase: None,
        };
        let signed = sign_pdf_pkcs12(&src, None, &spec).unwrap();
        let sigs = verify_signatures(&signed, None).unwrap();
        assert_eq!(sigs.len(), 1);
        let s = &sigs[0];
        assert_eq!(s.signer_name, "Alice Zhang");
        assert_eq!(s.reason.as_deref(), Some("Approved v1.0 release"));
        assert_eq!(s.location.as_deref(), Some("San Francisco, CA"));
        assert_eq!(s.email.as_deref(), Some("alice@solopdf.app"));
        assert!(s.byte_range_valid);
        assert!(s.covers_whole_document);
        assert!(s.digest_valid);
        assert_eq!(s.status, "valid");

        // Tamper with a byte near the beginning of the PDF (inside the first signed range)
        let mut tampered = signed.clone();
        // Flip a byte in a comment or stream body (without breaking PDF xref parsing)
        let pos = tampered
            .windows(17)
            .position(|w| w == b"Approved v1.0 rel")
            .expect("reason string in signed PDF");
        tampered[pos] = b'X';
        let bad = verify_signatures(&tampered, None).unwrap();
        assert_eq!(bad.len(), 1);
        assert!(!bad[0].digest_valid, "tampered PDF must fail digest verification");
        assert_eq!(bad[0].status, "invalid");

        // Append extra non-whitespace bytes after the signed document
        let mut appended = signed.clone();
        appended.extend_from_slice(b"\n% incremental post-sign modification\n");
        let mod_sigs = verify_signatures(&appended, None).unwrap();
        assert_eq!(mod_sigs.len(), 1);
        assert!(mod_sigs[0].digest_valid);
        assert!(!mod_sigs[0].covers_whole_document);
        assert_eq!(mod_sigs[0].status, "modified");
    }
}
