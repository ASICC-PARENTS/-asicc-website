import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BazaarError } from '../../firebase-functions-bazaar/bazaar/service.mjs';

const maxBytes = 4 * 1024 * 1024;
const pathPattern = /^bazaar-photos\/([a-z0-9-]{12,60})\/([a-z0-9-]{2,50})\/([a-f0-9]{64})$/;
const types = ['image/jpeg', 'image/png', 'image/webp'];
const hash = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data);

function typeOf(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return types[0];
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return types[1];
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return types[2];
  throw new BazaarError('invalid-argument', 'JPEG, PNG 또는 WebP 사진을 선택해 주세요.');
}

export function createPhotos(env, db, origin, ctx, fetcher = fetch) {
  const storagePrefix = env.BAZAAR_MODE === 'production' ? 'bazaar/production/photos' : 'bazaar/test/photos';
  const makeUrl = path => `${origin}/photo/${path}`;
  const previewSignature = (path, expires) => hmac(env.BAZAAR_PHOTO_SIGNING_KEY, `${path}:${expires}`).digest('hex');

  async function storage(method, digest, bytes, contentType) {
    const endpoint = new URL(env.B2_S3_ENDPOINT);
    if (endpoint.protocol !== 'https:' || !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(endpoint.host)
      || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search
      || !/^[A-Za-z0-9-]{6,63}$/.test(env.B2_BUCKET) || !env.B2_KEY_ID || !env.B2_APPLICATION_KEY) {
      throw new Error('Invalid B2 settings');
    }
    const path = `/${env.B2_BUCKET}/${storagePrefix}/${digest}`;
    const region = endpoint.host.split('.')[1];
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const scope = `${day}/${region}/s3/aws4_request`;
    const payload = bytes ? digest : hash('');
    const headers = { host: endpoint.host, 'x-amz-date': date, 'x-amz-content-sha256': payload };
    if (contentType) headers['content-type'] = contentType;
    const names = Object.keys(headers).sort();
    const canonical = names.map(key => `${key}:${headers[key]}\n`).join('');
    const signed = [method, path, '', canonical, names.join(';'), payload].join('\n');
    const signingKey = [day, region, 's3', 'aws4_request'].reduce((key, value) => hmac(key, value).digest(), `AWS4${env.B2_APPLICATION_KEY}`);
    const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', date, scope, hash(signed)].join('\n')).digest('hex');
    delete headers.host;
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${env.B2_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    return fetcher(endpoint.origin + path, { method, headers, body: bytes, redirect: 'error' });
  }

  function preview(value) {
    if (!env.BAZAAR_PHOTO_SIGNING_KEY || !value || typeof value !== 'object') return value;
    const expires = Math.floor(Date.now() / 1000) + 3600;
    function decorate(item) {
      if (Array.isArray(item)) return item.map(decorate);
      if (!item || typeof item !== 'object') return item;
      const result = Object.fromEntries(Object.entries(item).map(([key, child]) => [key, decorate(child)]));
      if (typeof item.photoPath === 'string' && pathPattern.test(item.photoPath)) {
        result.imageUrl = `${makeUrl(item.photoPath)}?expires=${expires}&preview=${previewSignature(item.photoPath, expires)}`;
      }
      return result;
    }
    return decorate(value);
  }

  return {
    preview,
    async storePhoto(eventId, productId, { content, sourcePath }) {
      const source = typeof sourcePath === 'string' && pathPattern.exec(sourcePath);
      let digest;
      if (source) {
        if (source[2] !== productId) throw new BazaarError('invalid-argument', '선택한 상품의 사진을 확인해 주세요.');
        digest = source[3];
      } else {
        if (!(content instanceof Uint8Array) && (typeof content !== 'string' || content.length > Math.ceil(maxBytes / 3) * 4
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(content))) throw new BazaarError('invalid-argument', '4MB 이하의 사진 파일을 선택해 주세요.');
        const bytes = content instanceof Uint8Array
          ? Buffer.from(content.buffer, content.byteOffset, content.byteLength) : Buffer.from(content, 'base64');
        if (!bytes.length || bytes.length > maxBytes) throw new BazaarError('invalid-argument', '4MB 이하의 사진 파일을 선택해 주세요.');
        const contentType = typeOf(bytes);
        digest = hash(bytes);
        const existing = await storage('HEAD', digest);
        if (!existing.ok && (existing.status !== 404 || !(await storage('PUT', digest, bytes, contentType)).ok)) {
          throw new Error('B2 photo upload failed');
        }
      }
      const photoPath = `bazaar-photos/${eventId}/${productId}/${digest}`;
      return { photoPath, imageUrl: makeUrl(photoPath) };
    },
    async eventPhoto(eventId, productId, product) {
      if (!product?.imageUrl && !product?.photoPath) return { imageUrl: '', photoPath: '' };
      const key = typeof product.photoPath === 'string' && pathPattern.exec(product.photoPath);
      if (key?.[1] !== eventId || key?.[2] !== productId) {
        throw new BazaarError('failed-precondition', '이 행사에 사진을 복사하지 못했습니다. 사진 파일을 다시 선택해 주세요.');
      }
      return { photoPath: product.photoPath, imageUrl: makeUrl(product.photoPath) };
    },
    async serve(url) {
      const missing = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      const path = url.pathname.slice('/photo/'.length);
      const key = pathPattern.exec(path);
      if (!key) return missing();
      const [, eventId, productId, digest] = key;
      const expires = Number(url.searchParams.get('expires'));
      const signature = url.searchParams.get('preview') ?? '';
      const privateView = !!env.BAZAAR_PHOTO_SIGNING_KEY && Number.isSafeInteger(expires)
        && expires > Date.now() / 1000 && /^[a-f0-9]{64}$/.test(signature)
        && timingSafeEqual(Buffer.from(signature), Buffer.from(previewSignature(path, expires)));
      const cacheKey = new Request(`${origin}/cached-bazaar-photo/${digest}`);
      const edge = globalThis.caches?.default;
      if (!privateView) {
        const [event, product] = await db.getAll(db.doc('bazaarMeta/event'), db.doc(`bazaarProducts/${productId}`));
        const active = event.data();
        const item = product.data();
        if (active?.eventId !== eventId || active.status !== 'published' || active.finalizedAt
          || !item?.visible || item.archivedAt || item.photoPath !== path
          || (active.scopedProducts && item.bazaarEventId !== eventId)
          || !Number.isSafeInteger(item.retailCents) || item.retailCents < 0) return missing();
      }
      const cached = await edge?.match(cacheKey);
      const publicHeaders = { 'Cache-Control': privateView ? 'private, no-store' : 'public, max-age=0, must-revalidate',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
      if (cached) return new Response(cached.body, { headers: { ...publicHeaders, 'Content-Type': cached.headers.get('Content-Type') } });
      const upstream = await storage('GET', digest);
      const contentType = upstream.headers.get('Content-Type');
      if (!upstream.ok || !types.includes(contentType)) return missing();
      const response = new Response(upstream.body, { headers: {
        ...publicHeaders, 'Content-Type': contentType
      } });
      if (edge && ctx) {
        const stored = new Response(response.clone().body, { headers: { 'Content-Type': contentType,
          'Cache-Control': 'public, max-age=86400' } });
        ctx.waitUntil(edge.put(cacheKey, stored).catch(() => {}));
      }
      return response;
    }
  };
}
