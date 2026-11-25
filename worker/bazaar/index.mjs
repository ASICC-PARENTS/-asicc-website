import { createBazaar, BazaarError } from '../../firebase-functions-bazaar/bazaar/service.mjs';
import { authenticate, serverToken } from './auth.mjs';
import { createFirestore, FieldValue } from './firestore.mjs';
import { createMail, mailFields } from './mail.mjs';
import { createMailAdmin } from './mail-admin.mjs';
import { createPhotos } from './photos.mjs';
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
const memberMediaRoutes = new Set(['/api/upload','/api/photo','/api/resource-upload','/api/resource','/api/gallery-upload','/api/gallery']);

function settings(env) {
  if (env.BAZAAR_MODE === 'local') {
    if (env.FIREBASE_PROJECT_ID !== 'demo-asicc-bazaar' || !localUrl.test(env.FIRESTORE_EMULATOR_URL)
      || !localUrl.test(env.AUTH_EMULATOR_URL)) throw new Error('Local Worker requires loopback emulators');
  } else if (env.BAZAAR_MODE !== 'test' || env.FIREBASE_PROJECT_ID !== 'asicc-bazaar-test'
    || env.FIRESTORE_EMULATOR_URL || env.AUTH_EMULATOR_URL) {
    throw new Error('This Worker configuration is restricted to the isolated test project');
  }
  const site = new URL(env.BAZAAR_SITE_URL);
  if (site.username || site.password || site.search || site.hash
    || (site.protocol !== 'https:' && !localUrl.test(site.origin))
    || ['asicc-parents.fr', 'www.asicc-parents.fr'].includes(site.hostname)) throw new Error('Invalid test site URL');
  return site;
}

function dependencies(env, origin, ctx) {
  const site = settings(env);
  const db = createFirestore({ projectId: env.FIREBASE_PROJECT_ID, token: () => serverToken(env),
    emulator: env.FIRESTORE_EMULATOR_URL });
  const photos = createPhotos(env, db, origin, ctx);
  const mail = createMail(env, db);
  const mailManagement = createMailAdmin(db,mail);
  const service = createBazaar({
    db, FieldValue, eventPhoto: photos.eventPhoto, storePhoto: photos.storePhoto, evidence:photos.evidence,
    siteUrl: () => site.href.replace(/\/$/, ''), canSendMail: mail.canSend,
    sendQueuedMail: (id, message) => {
      ctx.waitUntil(mail.deliver(id, message).catch(() => {}));
      return Promise.resolve(false);
    },
    queueFields: mailFields, mailAdmin:mailManagement.admin,
    batchFinalization: true, receiptCapture: env.MAIL_MODE === 'capture', emailPreviewTest: env.BAZAAR_MODE === 'test'
  });
  return { photos, mail, mailManagement, service, site };
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
      const { site, service, photos } = dependencies(env, url.origin, ctx);
      if (env.BAZAAR_MODE === 'test' && memberMediaRoutes.has(url.pathname)) {
        return await privateMedia.fetch(request, {...env, ALLOWED_ORIGINS: [site.origin,designOrigin].join(',')});
      }
      if (request.method === 'GET' && url.pathname.startsWith('/photo/')) return await photos.serve(url);
      const name = url.pathname.slice('/api/'.length);
      if (!url.pathname.startsWith('/api/') || !routeNames.has(name)) return json({}, 404, cors);
      const origin = request.headers.get('Origin');
      if (origin && origin !== site.origin && !(env.BAZAAR_MODE === 'test' && [designOrigin,'http://127.0.0.1:4321'].includes(origin))) return json({}, 403, cors);
      if (origin) cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') return json({}, 405, cors);
      const auth = name === 'bazaarAdmin' ? await authenticate(request, env) : undefined;
      const data = await readData(request, name, url);
      const edge=env.BAZAAR_MODE==='local'?undefined:globalThis.caches?.default;
      const shopId=typeof data.eventId==='string'?data.eventId.trim():'';
      const key=edge&&name==='bazaarPublic'&&(!shopId||/^[a-z0-9-]{12,60}$/.test(shopId))?shopKey(url.origin,shopId):null;
      const cached=key?await edge.match(key).catch(()=>null):null;
      if(cached)return json({data:await cached.json()},200,cors);
      const result = await service[name]({ auth, data, rawRequest: { ip: request.headers.get('CF-Connecting-IP') } });
      if(name==='bazaarAdmin'&&data.op==='getEvidence'&&result instanceof Response)
        return new Response(result.body,{status:result.status,headers:{...cors,...Object.fromEntries(result.headers)}});
      if(key)ctx.waitUntil(edge.put(key,Response.json(result,{headers:{'Cache-Control':'public, max-age=10'}})).catch(()=>{}));
      if(edge&&name==='bazaarAdmin'&&(shopMutations.has(data.op)||data.op==='saveProductDetail'&&data.scope==='event')){
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
    const { mail, service } = dependencies(env, '', ctx);
    await mail.run(service.message);
  }
};
