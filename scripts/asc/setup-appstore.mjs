// SoloPDF: register bundle id + create MAS & iOS provisioning profiles via ASC API.
// Reuses the FreeID "asc.mjs" JWT pattern (Admin key H85Q4NJPVD).
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY_ID = process.env.ASC_KEY_ID || 'H85Q4NJPVD';
const ISSUER = process.env.ASC_ISSUER || '21dd1b35-fb04-42f1-8ec0-d847838fa7b6';
const KEY_PATH = `${process.env.HOME}/.appstoreconnect/private_keys/AuthKey_${KEY_ID}.p8`;
const BUNDLE = 'app.solopdf';

const b64u = (b) => Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function token() {
  const p8 = fs.readFileSync(KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ iss: ISSUER, iat: now, exp: now + 1080, aud: 'appstoreconnect-v1' }));
  const key = crypto.createPrivateKey(p8);
  const sig = crypto.sign('SHA256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64u(sig)}`;
}
const JWT = token();
async function api(method, path, body) {
  const r = await fetch('https://api.appstoreconnect.apple.com' + path, {
    method, headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status}: ${json?.errors?.[0]?.detail || json?.errors?.[0]?.title || ''}`);
  return json;
}

// 1. bundle id (UNIVERSAL covers macOS + iOS)
let bundleId;
const existing = await api('GET', `/v1/bundleIds?filter[identifier]=${BUNDLE}`);
const hit = (existing.data || []).find(b => b.attributes.identifier === BUNDLE);
if (hit) { bundleId = hit.id; console.log('bundleId exists:', hit.id, hit.attributes.platform); }
else {
  const res = await api('POST', '/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: BUNDLE, name: 'SoloPDF', platform: 'UNIVERSAL' } } });
  bundleId = res.data.id; console.log('bundleId created:', bundleId);
}

// 2. certificates
const certs = await api('GET', '/v1/certificates?limit=200');
const macAppCert = certs.data.filter(c => ['MAC_APP_DISTRIBUTION','DISTRIBUTION'].includes(c.attributes.certificateType) && new Date(c.attributes.expirationDate) > new Date());
const iosCert = certs.data.filter(c => ['IOS_DISTRIBUTION','DISTRIBUTION'].includes(c.attributes.certificateType) && new Date(c.attributes.expirationDate) > new Date());
console.log('certs:', certs.data.map(c => `${c.attributes.certificateType}:${c.id.slice(0,6)}(${c.attributes.name})`).join(' | '));

async function makeProfile(name, type, certIds) {
  const ex = await api('GET', `/v1/profiles?filter[name]=${encodeURIComponent(name)}`);
  for (const p of ex.data || []) {
    console.log(`profile "${name}" exists (${p.attributes.profileState}) — deleting to recreate`);
    await api('DELETE', `/v1/profiles/${p.id}`);
  }
  const res = await api('POST', '/v1/profiles', { data: {
    type: 'profiles',
    attributes: { name, profileType: type },
    relationships: {
      bundleId: { data: { type: 'bundleIds', id: bundleId } },
      certificates: { data: certIds.map(id => ({ type: 'certificates', id })) },
    },
  }});
  const content = Buffer.from(res.data.attributes.profileContent, 'base64');
  return { id: res.data.id, content };
}

// 3. MAS profile
if (macAppCert.length) {
  const p = await makeProfile('SoloPDF MAS', 'MAC_APP_STORE', [macAppCert[0].id]);
  fs.writeFileSync('/Volumes/Dev/code/pdf/app/src-tauri/SoloPDF.provisionprofile', p.content);
  console.log('MAS profile written -> app/src-tauri/SoloPDF.provisionprofile');
} else console.log('NO mac distribution cert found in ASC!');

// 4. iOS App Store profile
if (iosCert.length) {
  const p = await makeProfile('SoloPDF iOS', 'IOS_APP_STORE', [iosCert[0].id]);
  fs.writeFileSync('/Volumes/Dev/code/pdf/app/src-tauri/SoloPDF-iOS.mobileprovision', p.content);
  console.log('iOS profile written -> app/src-tauri/SoloPDF-iOS.mobileprovision');
} else console.log('NO ios distribution cert found in ASC!');
