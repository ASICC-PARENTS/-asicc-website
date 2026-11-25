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
  if (!bazaarTestMode) {
    if (!local) return false;
    const warning=document.createElement('p');
    warning.setAttribute('role','alert');
    warning.textContent='바자회 테스트 설정이 활성화되지 않았습니다. 일반 회원 계정을 사용하지 마세요. 명령창에서 npm run dev:bazaar로 실행해 주세요.';
    container.replaceChildren(warning);
    return true;
  }
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
  let body: BodyInit;
  let contentType = 'application/json';
  if(name==='bazaarAdmin'&&payload.op==='storeEvidence'&&payload.content instanceof File){
    if(payload.content.size>4*1024*1024)throw new Error('증빙 파일의 크기는 최대 4MB입니다. / Chaque fichier est limité à 4 Mo.');
    body=payload.content;
    contentType='application/octet-stream';
    target.searchParams.set('upload','evidence');
    target.searchParams.set('eventId',payload.eventId);
    target.searchParams.set('name',payload.content.name);
  } else if (name === 'bazaarAdmin' && payload.op === 'storePhoto' && typeof payload.content === 'string' && payload.content) {
    if (payload.content.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) throw new Error('4MB 이하의 사진 파일을 선택해 주세요.');
    const raw = atob(payload.content);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    body = bytes;
    contentType = 'application/octet-stream';
    for (const key of ['eventId', 'id', 'draft', 'catalog', 'updatedAt']) {
      if (payload[key] != null) target.searchParams.set(key, String(payload[key]));
    }
  }else body=JSON.stringify({ data: payload });
  const response = await fetch(target, {
    method: 'POST', credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': contentType, ...(token && { Authorization: `Bearer ${token}` }) },
    body
  });
  if(response.ok&&name==='bazaarAdmin'&&payload.op==='getEvidence')return response.blob();
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(result.error?.message || '바자회 서버에 연결하지 못했습니다.'),
      { code: `functions/${result.error?.code || 'unavailable'}`, status: response.status, details: result.error?.details });
  }
  return result.data;
}
export const getShop=(eventId:string)=>invoke('bazaarPublic',{eventId});
export const getHomePopup=()=>invoke('bazaarPublic',{op:'homePopup'});
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
export function parisDeadline(value: string | undefined, lang: string) {
  const date = Date.parse(value ?? '');
  if (!Number.isFinite(date)) return '—';
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'ko-KR', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris',
  }).format(date) + (lang === 'fr' ? ' (heure de Paris)' : ' (파리 시간)');
}

export async function orderRequestId(eventId: string, payload: unknown) {
  const key = `asicc-bazaar-checkout:${eventId}`;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const fingerprint = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (saved?.fingerprint === fingerprint && saved.until > Date.now() && /^[a-f0-9]{32}$/.test(saved.id)) return saved.id;
    const id = crypto.randomUUID().replaceAll('-', '');
    sessionStorage.setItem(key, JSON.stringify({ id, fingerprint, until: Date.now() + 86400000 }));
    return id;
  } catch {
    return crypto.randomUUID().replaceAll('-', '');
  }
}
export const h=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
