import {getApps,initializeApp} from 'firebase/app';
import {connectAuthEmulator,getAuth,signInWithEmailAndPassword} from 'firebase/auth';
import {firebaseConfig} from '../../firebase-config';
const live = /^(www\.)?asicc-parents\.fr$/i.test(location.hostname);
const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
export const bazaarTestMode = !live && (import.meta.env.PUBLIC_ASICC_BAZAAR_TEST === 'true'
  || (local && import.meta.env.PUBLIC_ASICC_BAZAAR_EMULATOR === 'true'));
const emulator = local
  && import.meta.env.PUBLIC_ASICC_BAZAAR_EMULATOR === 'true';
const appName=emulator?'asicc-bazaar-emulator':'asicc-website';
const existing=getApps().find(a=>a.name===appName);
const app=existing??initializeApp(emulator?{apiKey:'demo-asicc-bazaar',projectId:'demo-asicc-bazaar'}:firebaseConfig,appName);
export const bazaarAuth=getAuth(app);
if(emulator&&!existing){
  connectAuthEmulator(bazaarAuth,'http://127.0.0.1:9099');
}

export function showBazaarTestLogin(container: HTMLElement) {
  if (!bazaarTestMode) return false;
  const form = document.createElement('form');
  form.innerHTML = '<label>테스트 관리자 이메일 <input name="email" type="email" autocomplete="username" required></label> '
    + '<label>비밀번호 <input name="password" type="password" autocomplete="current-password" required></label> '
    + '<button class="btn primary" type="submit">테스트 로그인</button><p role="status"></p>';
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const fields = new FormData(form);
    const feedback = form.querySelector('p')!;
    const submit = form.querySelector('button')!;
    submit.disabled = true;
    feedback.textContent = '';
    try {
      await signInWithEmailAndPassword(bazaarAuth, String(fields.get('email')).trim(), String(fields.get('password')));
    } catch {
      feedback.textContent = '테스트 관리자 로그인 정보를 확인해 주세요.';
    } finally {
      submit.disabled = false;
    }
  });
  container.replaceChildren(form);
  return true;
}
async function invoke(name:string,payload:any={}){
  const endpoint = emulator ? (import.meta.env.PUBLIC_ASICC_BAZAAR_WORKER_URL || 'http://127.0.0.1:8787')
    : import.meta.env.PUBLIC_ASICC_BAZAAR_WORKER_URL;
  if (!endpoint || !bazaarTestMode) {
    throw new Error('이 환경에서는 바자회에 연결할 수 없습니다. / Le bazar est indisponible dans cet environnement.');
  }
  const url = new URL(endpoint);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (url.protocol !== 'https:' && !(emulator && url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)))) {
    throw new Error('바자회 서버 주소를 확인해 주세요.');
  }
  const token = name === 'bazaarAdmin' ? await bazaarAuth.currentUser?.getIdToken() : undefined;
  const target = new URL(`/api/${name}`, url);
  let body: BodyInit = JSON.stringify({ data: payload });
  let contentType = 'application/json';
  if (name === 'bazaarAdmin' && payload.op === 'storePhoto' && typeof payload.content === 'string' && payload.content) {
    if (payload.content.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) throw new Error('4MB 이하의 사진 파일을 선택해 주세요.');
    const raw = atob(payload.content);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    body = bytes;
    contentType = 'application/octet-stream';
    for (const key of ['eventId', 'id', 'draft', 'catalog', 'updatedAt']) {
      if (payload[key] != null) target.searchParams.set(key, String(payload[key]));
    }
  }
  const response = await fetch(target, {
    method: 'POST', credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': contentType, ...(token && { Authorization: `Bearer ${token}` }) },
    body
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(result.error?.message || '바자회 서버에 연결하지 못했습니다.'),
      { code: `functions/${result.error?.code || 'unavailable'}` });
  }
  return result.data;
}
export const getShop=(eventId:string)=>invoke('bazaarPublic',{eventId});
export const createOrder=(buyer:any)=>invoke('bazaarCreateOrder',buyer);
export const buyerAction=(p:any)=>invoke('bazaarBuyerAction',p);
export async function adminAction(p:any) {
  if (p.op !== 'finalizeUnpaid') return invoke('bazaarAdmin', p);
  let canceled = 0;
  let pending;
  do {
    const result = await invoke('bazaarAdmin', p);
    canceled += result.canceled;
    pending = result.pending;
  } while (pending);
  return { ok: true, canceled };
}
export const eFormat=(c:number)=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(c/100);
export const h=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
