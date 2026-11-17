// 공개 양식(문의, 설명회 신청, 소식지 구독)을 백엔드로 보냄
import { getBackend, type InboxCol } from './backend';

const ko = document.documentElement.lang !== 'fr';
const T = {
  required: ko ? '필수 항목을 입력해 주세요.' : 'Merci de remplir les champs obligatoires.',
  email: ko ? '올바른 이메일 주소를 입력해 주세요.' : 'Adresse e-mail invalide.',
  consent: ko ? '개인정보 수집 동의가 필요합니다.' : 'Votre accord est nécessaire.',
  ok: ko ? '접수되었습니다. 감사합니다.' : 'Merci, votre demande a bien été envoyée.',
  notReady: ko ? '온라인 접수 기능은 현재 준비 중입니다. 입력하신 내용은 전송되지 않습니다.' : 'Le formulaire en ligne est en préparation. Aucune donnée n’est envoyée.',
  fail: ko ? '전송하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' : 'Échec de l’envoi. Réessayez plus tard.',
};

document.querySelectorAll<HTMLFormElement>('form[data-public-form]').forEach((form) => {
  const msg = form.querySelector<HTMLElement>('[data-form-msg]')!;
  form.addEventListener('input', () => { msg.textContent = ''; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.style.color = '';
    const fd = new FormData(form);
    if (fd.get('website')) return; // 스팸 봇 함정
    for (const el of form.querySelectorAll<HTMLInputElement>('[required]')) {
      if (el.type === 'checkbox' ? !el.checked : !el.value.trim()) {
        msg.textContent = el.name === 'consent' ? T.consent : T.required; el.focus(); return;
      }
    }
    const email = String(fd.get('email') ?? '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = T.email; return; }

    const data: Record<string, any> = {};
    for (const [k, v] of fd.entries()) {
      if (k === 'website' || k === 'consent') continue;
      if (k === 'levels') (data.levels ??= []).push(v); else data[k] = String(v).trim();
    }
    data.consent = true;
    data.pageLang = ko ? 'ko' : 'fr';
    const btn = form.querySelector<HTMLButtonElement>('[type=submit]')!;
    btn.disabled = true;
    try {
      const b = await getBackend();
      if (b.mode === 'demo') {
        msg.textContent = T.notReady;
      } else {
        await b.submitPublic(form.dataset.publicForm as InboxCol, data);
        form.reset();
        msg.style.color = 'var(--ok)';
        msg.textContent = T.ok;
      }
    } catch {
      msg.textContent = T.fail;
    }
    btn.disabled = false;
  });
});

// 공식 접수 백엔드가 준비되기 전에는 실수로 개인정보를 입력하지 않도록
// 각 공개 양식에 준비 중 안내를 표시하고 제출 버튼을 비활성화합니다.
void getBackend().then((backend) => {
  if (backend.mode !== 'demo') return;
  document.querySelectorAll<HTMLFormElement>('form[data-public-form]').forEach((form) => {
    const note = document.createElement('p');
    note.className = 'notice notice-warn full';
    note.textContent = T.notReady;
    form.prepend(note);
    const submit = form.querySelector<HTMLButtonElement>('[type=submit]');
    if (submit) submit.disabled = true;
  });
}).catch(() => {});
