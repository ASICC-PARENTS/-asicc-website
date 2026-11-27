import { createBazaar, BazaarError } from '../../firebase-functions-bazaar/bazaar/service.mjs';
import { authenticate, serverToken } from './auth.mjs';
import { createFirestore, FieldValue } from './firestore.mjs';
import { createMail, mailFields } from './mail.mjs';
import { createMailAdmin } from './mail-admin.mjs';
import { createPhotos } from './photos.mjs';
import { timingSafeEqual } from 'node:crypto';
import privateMedia from '../asicc-media-worker-extended.js';

const codes = {
  'invalid-argument': 400, unauthenticated: 401, 'permission-denied': 403,
  'not-found': 404, 'already-exists': 409, 'failed-precondition': 412,
  'resource-exhausted': 429, 'checkout-busy': 503, unavailable: 503
};
const maxAdminJson = 1_000_000;
const maxPublicJson = 24_000;
const maxPhoto = 4 * 1024 * 1024;
const localUrl = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/;
const routeNames = new Set(['bazaarPublic', 'bazaarCreateOrder', 'bazaarBuyerAction', 'bazaarAdmin']);
const designOrigin = 'https://design-asicc-ui.asicc-integration-test.pages.dev';
const integrationOrigin = 'https://asicc-integration-test.pages.dev';
const baselineOrigin = 'https://asicc-test.pages.dev';
const memberMediaRoutes = new Set(['/api/upload','/api/photo','/api/resource-upload','/api/resource','/api/gallery-upload','/api/gallery']);
const productionSite = 'https://asicc-parents.fr';
const productionApi = 'https://asicc-bazaar-api.falling-hall-f390.workers.dev';
const productionDraft = 'bazaar-production-first-v1';
const pilotPrefix = 'bazaarPilot/rehearsal/';
const productionReads = new Set(['listEvents','dashboard','getCatalog','getDraft','eventFinancials','getEventProducts']);

function settings(env, origin) {
  const production = env.BAZAAR_MODE === 'production';
  if (production) {
    if (env.FIREBASE_PROJECT_ID !== 'asicc-member-space' || env.FIRESTORE_EMULATOR_URL || env.AUTH_EMULATOR_URL
      || env.BAZAAR_SITE_URL !== productionSite || origin && origin !== productionApi
      || (!['capture','api'].includes(env.MAIL_MODE) || env.MAIL_MODE === 'api' && (env.MAIL_PROVIDER !== 'brevo' || !env.BAZAAR_MAIL_API_KEY || !env.BAZAAR_MAIL_FROM)) || env.TEST_MAIL_TO || env.BAZAAR_TEST_MAIL_RECIPIENTS || env.BAZAAR_TEST_MAIL_SINCE
      || !['false','true'].includes(env.BAZAAR_PUBLIC_OPEN)) throw new Error('Invalid ASICC production configuration');
  } else if (env.BAZAAR_MODE === 'local') {
    if (env.FIREBASE_PROJECT_ID !== 'demo-asicc-bazaar' || !localUrl.test(env.FIRESTORE_EMULATOR_URL)
      || !localUrl.test(env.AUTH_EMULATOR_URL)) throw new Error('Local Worker requires loopback emulators');
  } else if (env.BAZAAR_MODE !== 'test' || env.FIREBASE_PROJECT_ID !== 'asicc-bazaar-test'
    || env.FIRESTORE_EMULATOR_URL || env.AUTH_EMULATOR_URL) {
    throw new Error('This Worker configuration is restricted to the isolated test project');
  }
  const site = new URL(env.BAZAAR_SITE_URL);
  if (site.username || site.password || site.search || site.hash
    || (site.protocol !== 'https:' && !localUrl.test(site.origin))
    || !production && ['asicc-parents.fr', 'www.asicc-parents.fr'].includes(site.hostname)) throw new Error('Invalid Bazaar site URL');
  return site;
}

function dependencies(env, origin, ctx, pilot = false) {
  const site = settings(env, origin);
  const firestore = createFirestore({ projectId: env.FIREBASE_PROJECT_ID, token: () => serverToken(env),
    emulator: env.FIRESTORE_EMULATOR_URL });
  const db = pilot ? { ...firestore,
    doc: path => firestore.doc(path === 'bazaarMeta/access' || path.startsWith('members/') ? path : pilotPrefix+path),
    collection: path => firestore.collection(path === 'members' ? path : pilotPrefix+path)
  } : firestore;
  const photos = createPhotos(env, db, origin, ctx);
  const mail = createMail(env, db);
  const mailManagement = createMailAdmin(db,mail);
  const service = createBazaar({
    db, FieldValue, eventPhoto: pilot ? async()=>({imageUrl:'',photoPath:''}) : photos.eventPhoto,
    storePhoto: pilot ? async()=>{throw new BazaarError('permission-denied','검수에서는 B2 쓰기가 차단됩니다.');} : photos.storePhoto,
    evidence:pilot?undefined:photos.evidence,
    siteUrl: () => site.href.replace(/\/$/, ''), canSendMail: mail.canSend,
    sendQueuedMail: (id, message) => {
      ctx.waitUntil(mail.deliver(id, message).catch(() => {}));
      return Promise.resolve(false);
    },
    queueFields: mailFields, mailAdmin:mailManagement.admin,
    batchFinalization: true, pilot,
    receiptCapture: env.MAIL_MODE === 'capture', emailPreviewTest: env.BAZAAR_MODE === 'test'
  });
  return { db, photos, mail, mailManagement, service, site };
}

function pilotEnabled(env) {
  return env.BAZAAR_MODE==='production'&&env.BAZAAR_PUBLIC_OPEN==='false'
    && Date.now()<Date.parse(env.BAZAAR_PILOT_EXPIRES_AT)
    && /^[a-f0-9]{64}$/.test(env.BAZAAR_PILOT_ACCESS_CODE??'');
}

function buyerCanPilot(env, header) {
  return pilotEnabled(env)&&/^[a-f0-9]{64}$/.test(header??'')
    &&timingSafeEqual(Buffer.from(env.BAZAAR_PILOT_ACCESS_CODE),Buffer.from(header));
}

function permitsDraftSetup(data) {
  return productionReads.has(data.op)
    || data.op==='saveDraft'&&data.id===productionDraft
    || data.op==='saveProductDetail'&&data.scope==='draft'&&data.eventId===productionDraft
    || data.op==='storePhoto'&&data.draft===true&&!data.catalog&&data.eventId===productionDraft;
}

function allowsReadProbe(request, env) {
  if (env.BAZAAR_MODE !== 'production' || env.BAZAAR_PUBLIC_OPEN !== 'false'
    || env.BAZAAR_PRELAUNCH_READ_ONLY !== 'true' || request.method !== 'HEAD'
    || !/^\d{13}$/.test(env.BAZAAR_READ_PROBE_EXPIRES ?? '')
    || Date.now() >= Number(env.BAZAAR_READ_PROBE_EXPIRES)) return false;
  const secret = env.BAZAAR_READ_PROBE_TOKEN;
  const supplied = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  return /^[a-f0-9]{64}$/.test(secret ?? '') && !!supplied
    && timingSafeEqual(Buffer.from(secret), Buffer.from(supplied));
}

const shopKey=(origin,id)=>new Request(`${origin}/cached-bazaar-catalog/${id||'current'}`);
const shopMutations=new Set(['endEvent','setOrderIntake','publishDraft','saveEvent','saveEventProducts','archiveProduct','setProductSales','saveProduct','addProduct','reorder','finalizeUnpaid','createRefund','voidRefund','correctOrder','cancelOrder']);

function json(data, status, headers) {
  return Response.json(data, { status, headers: { ...headers, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}

async function readBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) {
    throw new BazaarError('invalid-argument', '요청 파일이 너무 큽니다.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new BazaarError('invalid-argument', '요청 내용이 없습니다.');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BazaarError('invalid-argument', '요청 파일이 너무 큽니다.');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

async function readData(request, name, url) {
  const type = request.headers.get('Content-Type') ?? '';
  if (name === 'bazaarAdmin' && type === 'application/octet-stream') {
    if(url.searchParams.get('upload')==='evidence')return {op:'storeEvidence',eventId:url.searchParams.get('eventId'),
      name:url.searchParams.get('name'),content:await readBody(request,maxPhoto)};
    return { op: 'storePhoto', eventId: url.searchParams.get('eventId'), id: url.searchParams.get('id'),
      draft: url.searchParams.get('draft') === 'true', catalog: url.searchParams.get('catalog') === 'true',
      updatedAt: url.searchParams.get('updatedAt'), content: await readBody(request, maxPhoto) };
  }
  if (/^application\/json(?:;|$)/i.test(type)) {
    const body = await readBody(request, name === 'bazaarAdmin' ? maxAdminJson : maxPublicJson);
    try {
      const data = JSON.parse(body.toString('utf8')).data;
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch { /* Invalid JSON is reported below. */ }
  }
  throw new BazaarError('invalid-argument', '요청 형식을 확인해 주세요.');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let cors = {};
    try {
      const site=settings(env,url.origin);
      const publicOpen=env.BAZAAR_MODE!=='production'||env.BAZAAR_PUBLIC_OPEN==='true';
      const prelaunchReadOnly=env.BAZAAR_MODE==='production'&&env.BAZAAR_PRELAUNCH_READ_ONLY==='true';
      if (url.pathname==='/_ops/firestore-readiness') {
        if (!allowsReadProbe(request,env)) return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}});
        const {db}=dependencies(env,url.origin,ctx);
        await db.doc('bazaarMeta/access').get();
        return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
      }
      if (request.method === 'GET' && url.pathname.startsWith('/photo/'))
        return await dependencies(env,url.origin,ctx).photos.serve(url,publicOpen);
      if (env.BAZAAR_MODE === 'test' && memberMediaRoutes.has(url.pathname)) {
        return await privateMedia.fetch(request, {...env, ALLOWED_ORIGINS: [site.origin,designOrigin,baselineOrigin,integrationOrigin].join(',')});
      }
      const name = url.pathname.slice('/api/'.length);
      if (!url.pathname.startsWith('/api/') || !routeNames.has(name)) return json({}, 404, cors);
      const origin = request.headers.get('Origin');
      if (origin && origin !== site.origin && !(env.BAZAAR_MODE === 'test' && [designOrigin,baselineOrigin,integrationOrigin,'http://127.0.0.1:4321'].includes(origin))) return json({}, 403, cors);
      if (origin) cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-ASICC-Pilot', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({}, 405, cors);
      const pilotHeader=request.headers.get('X-ASICC-Pilot');
      const pilot=name==='bazaarAdmin' ? pilotHeader==='admin'&&pilotEnabled(env) : buyerCanPilot(env,pilotHeader);
      if (pilotHeader&&env.BAZAAR_MODE==='production'&&!pilot || !publicOpen&&name!=='bazaarAdmin'&&!pilot)
        return json({},404,cors);
      const {service,photos}=dependencies(env,url.origin,ctx,pilot);
      const auth = name === 'bazaarAdmin' ? await authenticate(request, env) : undefined;
      const data = await readData(request, name, url);
      if(prelaunchReadOnly&&name==='bazaarAdmin'&&!pilot&&!permitsDraftSetup(data))
        return json({error:{code:'failed-precondition',message:'운영 데이터는 현재 읽기 전용입니다.'}},412,cors);
      if(env.BAZAAR_MODE==='production'&&name==='bazaarAdmin'&&(data.op==='seed'||!publicOpen&&!pilot&&data.op==='publishDraft'))
        return json({error:{code:'failed-precondition',message:'운영 공개 설정을 확인해 주세요.'}},412,cors);
      const edge=env.BAZAAR_MODE==='local'?undefined:globalThis.caches?.default;
      const shopId=typeof data.eventId==='string'?data.eventId.trim():'';
      const key=edge&&!pilot&&name==='bazaarPublic'&&!data.op&&(!shopId||/^[a-z0-9-]{12,60}$/.test(shopId))?shopKey(url.origin,shopId):null;
      const cached=key?await edge.match(key).catch(()=>null):null;
      if(cached)return json({data:await cached.json()},200,cors);
      const result = await service[name]({ auth, data, rawRequest: { ip: request.headers.get('CF-Connecting-IP') } });
      if(name==='bazaarAdmin'&&data.op==='getEvidence'&&result instanceof Response)
        return new Response(result.body,{status:result.status,headers:{...cors,...Object.fromEntries(result.headers)}});
      if(key)ctx.waitUntil(edge.put(key,Response.json(result,{headers:{'Cache-Control':'public, max-age=10'}})).catch(()=>{}));
      if(edge&&!pilot&&name==='bazaarAdmin'&&(shopMutations.has(data.op)||data.op==='saveProductDetail'&&data.scope==='event')){
        const affected=data.eventId??result?.eventId??data.id;
        ctx.waitUntil(Promise.allSettled(['',affected].filter(id=>typeof id==='string'&&(!id||/^[a-z0-9-]{12,60}$/.test(id)))
          .map(id=>edge.delete(shopKey(url.origin,id)))));
      }
      return json({ data: name === 'bazaarAdmin' ? photos.preview(result) : result }, 200, cors);
    } catch (error) {
      const checkoutBusy = error.status === 'CHECKOUT_CONTENTION';
      const code = error instanceof BazaarError ? error.code : checkoutBusy ? 'checkout-busy' : 'unavailable';
      if (!(error instanceof BazaarError) && !checkoutBusy) console.error('Bazaar Worker request failed', error.status || error.name);
      return json({ error: { code, message: error instanceof BazaarError ? error.message
        : '서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        ...(error instanceof BazaarError && error.details && { details: error.details }) } }, codes[code] ?? 500, cors);
    }
  },
  async scheduled(_event, env, ctx) {
    if(env.BAZAAR_MODE==='production'&&env.BAZAAR_PRELAUNCH_READ_ONLY==='true')return;
    const { mail, service } = dependencies(env, '', ctx);
    await mail.run(service.message);
  }
};
