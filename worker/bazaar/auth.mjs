import { BazaarError } from '../../firebase-functions-bazaar/bazaar/service.mjs';

const googleKeys = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const googleToken = 'https://oauth2.googleapis.com/token';
let keys;
let identity;

const base64url = value => Buffer.from(value).toString('base64url');
const parse = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

export async function authenticate(request, env) {
  const denied = () => new BazaarError('unauthenticated', '관리자 로그인이 필요합니다.');
  const token = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!token || token.length > 8192) throw denied();
  try {
    const [header, body, signature, extra] = token.split('.');
    const claims = parse(body);
    const meta = parse(header);
    const project = env.FIREBASE_PROJECT_ID;
    const now = Math.floor(Date.now() / 1000);
    if (extra !== undefined || claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}`
      || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128 || claims.sub.includes('/')
      || !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now
      || !Number.isFinite(claims.auth_time) || claims.auth_time > now) throw denied();
    if (env.BAZAAR_MODE === 'local' && env.AUTH_EMULATOR_URL && meta.alg === 'none' && signature === '') {
      return { uid: claims.sub, token: claims };
    }
    if (meta.alg !== 'RS256' || typeof meta.kid !== 'string' || !signature) throw denied();
    if (!keys || keys.expires <= Date.now()) {
      const response = await fetch(googleKeys);
      if (!response.ok) throw new Error('Firebase public keys unavailable');
      const age = Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1] ?? 300);
      const { keys: publicKeys } = await response.json();
      keys = { expires: Date.now() + Math.min(age, 3600) * 1000, publicKeys, imported: new Map() };
    }
    let publicKey = keys.imported.get(meta.kid);
    if (!publicKey) {
      const jwk = keys.publicKeys.find(item => item.kid === meta.kid && item.kty === 'RSA');
      if (!jwk) throw denied();
      publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      keys.imported.set(meta.kid, publicKey);
    }
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${body}`))) throw denied();
    return { uid: claims.sub, token: claims };
  } catch (error) {
    if (error instanceof BazaarError) throw error;
    throw denied();
  }
}

export async function serverToken(env) {
  if (env.BAZAAR_MODE === 'local' && env.FIRESTORE_EMULATOR_URL) return 'owner';
  const email = env.FIRESTORE_CLIENT_EMAIL;
  if (env.BAZAAR_MODE === 'production' && email !== 'asicc-bazaar-worker@asicc-member-space.iam.gserviceaccount.com') {
    throw new Error('Unexpected production Firestore service account');
  }
  if (!email?.endsWith(`@${env.FIREBASE_PROJECT_ID}.iam.gserviceaccount.com`) || !env.FIRESTORE_PRIVATE_KEY) {
    throw new Error('Firestore server identity unavailable');
  }
  if (!identity || identity.email !== email || identity.expires <= Date.now() + 120000) {
    const pem = env.FIRESTORE_PRIVATE_KEY.replaceAll('\\n', '\n');
    const key = await crypto.subtle.importKey('pkcs8',
      Buffer.from(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''), 'base64'),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const issued = Math.floor(Date.now() / 1000);
    const unsigned = [
      base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
      base64url(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/datastore',
        aud: googleToken, iat: issued, exp: issued + 3600 }))
    ].join('.');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const response = await fetch(googleToken, {
      method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${base64url(signature)}` })
    });
    if (!response.ok) throw new Error('Firestore server authentication failed');
    const result = await response.json();
    if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error('Invalid Google token response');
    identity = { email, token: result.access_token, expires: Date.now() + result.expires_in * 1000 };
  }
  return identity.token;
}
