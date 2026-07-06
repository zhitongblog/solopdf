// One-shot App Store Connect release for SoloPDF — BOTH platforms (iOS + macOS).
//   node release.mjs [--no-submit] [--skip-screenshots]
// Idempotent: applies all metadata every run, patches version strings to match the
// build trains in metadata.platforms, attaches builds, uploads screenshots into empty
// sets, ensures free pricing + "Data Not Collected" privacy, then submits one review
// submission per platform.
import { CONFIG, api, uploadScreenshot } from './asc.mjs';
import * as M from './metadata.mjs';

const NO_SUBMIT = process.argv.includes('--no-submit');
const SKIP_SHOTS = process.argv.includes('--skip-screenshots');
const APP = CONFIG.appId;
const log = (...a) => console.log('•', ...a);

// ---------- app-level (shared) ----------
const appInfo = (await api('GET', `/v1/apps/${APP}/appInfos`)).data
  .find((d) => (d.attributes.appStoreState || d.attributes.state) === 'PREPARE_FOR_SUBMISSION')
  || (await api('GET', `/v1/apps/${APP}/appInfos`)).data[0];
const ilocs = (await api('GET', `/v1/appInfos/${appInfo.id}/appInfoLocalizations?limit=50`)).data;
for (const [locale, a] of Object.entries(M.appInfoLocalizations)) {
  const ex = ilocs.find((l) => l.attributes.locale === locale);
  if (ex) await api('PATCH', `/v1/appInfoLocalizations/${ex.id}`, { data: { type: 'appInfoLocalizations', id: ex.id, attributes: a } });
  else await api('POST', '/v1/appInfoLocalizations', { data: { type: 'appInfoLocalizations', attributes: { locale, ...a },
    relationships: { appInfo: { data: { type: 'appInfos', id: appInfo.id } } } } });
  log('appInfo loc', locale);
}
await api('PATCH', `/v1/appInfos/${appInfo.id}`, { data: { type: 'appInfos', id: appInfo.id,
  relationships: { primaryCategory: { data: { type: 'appCategories', id: M.appFields.primaryCategory } } } } });
await api('PATCH', `/v1/apps/${APP}`, { data: { type: 'apps', id: APP, attributes: { contentRightsDeclaration: M.appFields.contentRightsDeclaration } } });
log('category / content rights set');

const decl = (await api('GET', `/v1/appInfos/${appInfo.id}/ageRatingDeclaration`)).data;
if (decl) { await api('PATCH', `/v1/ageRatingDeclarations/${decl.id}`, { data: { type: 'ageRatingDeclarations', id: decl.id, attributes: M.ageRating } }); log('age rating 4+'); }

// ---------- free pricing (one-time; skips if a schedule already exists) ----------
try {
  const sched = await api('GET', `/v1/appPriceSchedules/${APP}/manualPrices?include=appPricePoint&limit=1`);
  log('price schedule already present (', sched.data.length, 'manual price(s) ) — skip');
} catch {
  const pts = (await api('GET', `/v1/apps/${APP}/appPricePoints?filter[territory]=USA&limit=3&include=territory`)).data;
  const free = pts.find((p) => Number(p.attributes.customerPrice) === 0);
  if (!free) throw new Error('no free price point found');
  await api('POST', '/v1/appPriceSchedules', {
    data: { type: 'appPriceSchedules',
      relationships: {
        app: { data: { type: 'apps', id: APP } },
        baseTerritory: { data: { type: 'territories', id: 'USA' } },
        manualPrices: { data: [{ type: 'appPrices', id: '${price0}' }] } } },
    included: [{ type: 'appPrices', id: '${price0}', attributes: { startDate: null },
      relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } } }],
  });
  log('price schedule created: FREE (base USA)');
}

// ---------- availability: all territories (one-time) ----------
try {
  const avail = await api('GET', `/v2/appAvailabilities/${APP}?include=territoryAvailabilities&limit[territoryAvailabilities]=1`);
  log('availability already configured:', avail.data.attributes.availableInNewTerritories ? 'auto-new-territories' : 'manual');
} catch {
  const terrs = (await api('GET', '/v1/territories?limit=200')).data.map((t) => t.id);
  await api('POST', '/v2/appAvailabilities', {
    data: { type: 'appAvailabilities', attributes: { availableInNewTerritories: true },
      relationships: {
        app: { data: { type: 'apps', id: APP } },
        territoryAvailabilities: { data: terrs.map((_, i) => ({ type: 'territoryAvailabilities', id: `\${t${i}}` })) } } },
    included: terrs.map((t, i) => ({ type: 'territoryAvailabilities', id: `\${t${i}}`, attributes: { available: true },
      relationships: { territory: { data: { type: 'territories', id: t } } } })),
  });
  log('availability created: all', terrs.length, 'territories');
}

// ---------- per-platform ----------
const allVers = (await api('GET', `/v1/apps/${APP}/appStoreVersions?limit=20`)).data;
const verIds = {};
for (const [platform, plan] of Object.entries(M.platforms)) {
  let ver = allVers.find((v) => v.attributes.platform === platform && v.attributes.appStoreState === 'PREPARE_FOR_SUBMISSION');
  if (!ver) {
    ver = (await api('POST', '/v1/appStoreVersions', { data: { type: 'appStoreVersions',
      attributes: { platform, versionString: plan.versionString },
      relationships: { app: { data: { type: 'apps', id: APP } } } } })).data;
    log(platform, 'created version', plan.versionString);
  } else if (ver.attributes.versionString !== plan.versionString) {
    await api('PATCH', `/v1/appStoreVersions/${ver.id}`, { data: { type: 'appStoreVersions', id: ver.id, attributes: { versionString: plan.versionString } } });
    log(platform, 'version string ->', plan.versionString);
  }
  const verId = verIds[platform] = ver.id;

  await api('PATCH', `/v1/appStoreVersions/${verId}`, { data: { type: 'appStoreVersions', id: verId,
    attributes: { copyright: M.appFields.copyright, releaseType: M.appFields.releaseType } } });

  // localizations
  const vlocs = (await api('GET', `/v1/appStoreVersions/${verId}/appStoreVersionLocalizations?limit=50`)).data;
  for (const [locale, a] of Object.entries(M.versionLocalizations)) {
    const ex = vlocs.find((l) => l.attributes.locale === locale);
    if (ex) await api('PATCH', `/v1/appStoreVersionLocalizations/${ex.id}`, { data: { type: 'appStoreVersionLocalizations', id: ex.id, attributes: a } });
    else await api('POST', '/v1/appStoreVersionLocalizations', { data: { type: 'appStoreVersionLocalizations', attributes: { locale, ...a },
      relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: verId } } } } });
    log(platform, 'version loc', locale);
  }

  // review contact
  const rd = (await api('GET', `/v1/appStoreVersions/${verId}/appStoreReviewDetail`)).data;
  if (rd) await api('PATCH', `/v1/appStoreReviewDetails/${rd.id}`, { data: { type: 'appStoreReviewDetails', id: rd.id, attributes: M.reviewContact } });
  else await api('POST', '/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: M.reviewContact,
    relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: verId } } } } });
  log(platform, 'review contact set');

  // attach build
  const builds = (await api('GET', `/v1/builds?filter[app]=${APP}&filter[version]=${plan.buildVersion}&filter[processingState]=VALID&limit=5`)).data;
  const build = builds.find((b) => !b.attributes.expired);
  if (!build) throw new Error(`${platform}: build ${plan.buildVersion} not found/VALID`);
  await api('PATCH', `/v1/appStoreVersions/${verId}/relationships/build`, { data: { type: 'builds', id: build.id } });
  log(platform, 'attached build', plan.buildVersion, build.id);

  // screenshots — only into empty sets
  if (!SKIP_SHOTS) {
    const shots = M.screenshots[platform];
    const vlocs2 = (await api('GET', `/v1/appStoreVersions/${verId}/appStoreVersionLocalizations?limit=50`)).data;
    for (const vl of vlocs2) {
      if (!M.versionLocalizations[vl.attributes.locale]) continue;
      const allSets = (await api('GET', `/v1/appStoreVersionLocalizations/${vl.id}/appScreenshotSets`)).data;
      for (const plan2 of shots.sets) {
        let set = allSets.find((s) => s.attributes.screenshotDisplayType === plan2.displayType);
        if (!set) set = (await api('POST', '/v1/appScreenshotSets', { data: { type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: plan2.displayType },
          relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: vl.id } } } } })).data;
        const existing = (await api('GET', `/v1/appScreenshotSets/${set.id}/appScreenshots`)).data.length;
        if (existing > 0) { log(platform, plan2.displayType, vl.attributes.locale, '— already has', existing, '(skip)'); continue; }
        for (const f of plan2.files) { await uploadScreenshot(set.id, shots.dir + f); log(' ', platform, plan2.displayType, vl.attributes.locale, 'uploaded', f); }
      }
    }
  }
}

// ---------- submit (one review submission per platform) ----------
if (NO_SUBMIT) { log('--no-submit: everything staged but NOT submitted.'); process.exit(0); }
for (const platform of Object.keys(M.platforms)) {
  const subs = (await api('GET', `/v1/apps/${APP}/reviewSubmissions?filter[platform]=${platform}&filter[state]=READY_FOR_REVIEW&limit=1`)).data || [];
  let sub = subs[0] || (await api('POST', '/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform },
    relationships: { app: { data: { type: 'apps', id: APP } } } } })).data;
  const items = (await api('GET', `/v1/reviewSubmissions/${sub.id}/items`)).data || [];
  if (!items.length) {
    await api('POST', '/v1/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems',
      relationships: { reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: verIds[platform] } } } } });
  }
  await api('PATCH', `/v1/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } });
  const after = (await api('GET', `/v1/reviewSubmissions/${sub.id}`)).data;
  log(platform, 'SUBMITTED —', sub.id, 'state:', after.attributes.state);
}
console.log('\n✅ Both platforms submitted for review. Auto-release after approval.');
