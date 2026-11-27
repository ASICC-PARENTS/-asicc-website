import { getApps, initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import {firebaseConfig} from '../../firebase-config';
import {ADMISSIONS_API,GRADES} from './config';
type RecordRow={name:string,email:string,city:string,interest:string,children:{school:string,grade:string}[],lang:string,createdAt:string};
const root=document.querySelector<HTMLElement>('#session-admin')!;
const ko=root.dataset.lang==='ko';
const text=(a:string,b:string)=>ko?a:b;
const body=document.querySelector<HTMLElement>('#session-admin-body')!;
const status=document.querySelector<HTMLElement>('#session-admin-status')!;
const message=document.querySelector<HTMLElement>('#session-admin-message')!;
const records=document.querySelector<HTMLElement>('#session-records')!;
const search=document.querySelector<HTMLInputElement>('#session-search')!;
const app=getApps().find(a=>a.name==='asicc-website')??initializeApp(firebaseConfig,'asicc-website');
const auth=getAuth(app);
let rows:RecordRow[]=[];
let loadSequence=0;
const interestLabel=(value:string)=>({
  next_year:text('2027–2028학년도 입학','Rentrée 2027–2028'),
  future:text('향후 학년도 입학 관심','Admission ultérieure'),
  general:text('국제섹션 일반 관심','Découverte de la section')
}[value]||value);
const date=(v:string)=>new Intl.DateTimeFormat(ko?'ko-KR':'fr-FR',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Paris'}).format(new Date(v));
const school=(c:{school:string,grade:string})=>(c.school==='mat'?text('유치원','Maternelle'):text('초등학교','Élémentaire'))+' '+c.grade;
const excelSafe=(v:unknown)=>{const s=String(v??'');return /^[=+\-@\t\r]/.test(s)?"'"+s:s;};
function summaries(){
  const stats=document.querySelector<HTMLElement>('#session-stats')!;stats.replaceChildren();
  const count=(key:string)=>rows.filter(r=>r.interest===key).length;
  const allChildren=rows.flatMap(r=>r.children||[]);
  const entries:[[string,number],[string,number],[string,number],[string,number],[string,number],[string,number]]=[
    [text('전체 신청자','Inscrits'),rows.length],
    [text('2027 입학 희망','Rentrée 2027'),count('next_year')],
    [text('향후 입학 관심','Admission ultérieure'),count('future')],
    [text('일반 관심','Découverte'),count('general')],
    [text('유치원 희망 자녀','Enfants · maternelle'),allChildren.filter(c=>c.school==='mat').length],
    [text('초등학교 희망 자녀','Enfants · élémentaire'),allChildren.filter(c=>c.school==='elem').length]
  ];
  for(const [label,value] of entries){const box=document.createElement('div');box.className='session-stat';const span=document.createElement('span');span.textContent=label;const b=document.createElement('b');b.textContent=String(value);box.append(span,b);stats.append(box);}
  function renderSummary(id:string,items:[string,number][]){
    const el=document.querySelector<HTMLElement>(id)!;el.replaceChildren();
    for(const [name,value] of items){const item=document.createElement('span');item.className='session-summary';item.textContent=name+' · '+value;el.append(item);}
    if(!items.length)el.textContent=text('신청자 없음','Aucune inscription');
  }
  renderSummary('#session-grade-summary',Object.entries(GRADES).flatMap(([level,grades])=>grades.map(grade=>[grade,allChildren.filter(c=>c.school===level&&c.grade===grade).length] as [string,number])));
  const cities=new Map<string,number>();rows.forEach(r=>cities.set(r.city,(cities.get(r.city)||0)+1));
  renderSummary('#session-city-summary',[...cities].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])));
}
function visibleRows(){const q=search.value.trim().toLocaleLowerCase();return rows.filter(r=>!q||[r.name,r.email,r.city,interestLabel(r.interest),r.children.map(school).join(' ')].some(x=>x.toLocaleLowerCase().includes(q)));}
function render(){
  records.replaceChildren();const visible=visibleRows();
  for(const item of visible){
    const row=document.createElement('tr');
    for(const value of [date(item.createdAt),item.name,item.email,item.city,interestLabel(item.interest),item.children.map(school).join(' · ')||'—',item.lang.toUpperCase()]){
      const td=document.createElement('td');td.textContent=value;row.append(td);
    } records.append(row);
  }
  if(!visible.length){const row=document.createElement('tr');const td=document.createElement('td');td.colSpan=7;td.textContent=text('신청자가 없습니다.','Aucune inscription.');row.append(td);records.append(row);}
  document.querySelector<HTMLElement>('#session-visible-count')!.textContent=text('표시','Affichés')+' '+visible.length+' / '+rows.length;
  (document.querySelector('#session-copy') as HTMLButtonElement).disabled=visible.length===0;
  (document.querySelector('#session-export') as HTMLButtonElement).disabled=visible.length===0;
}
async function load(){
  const seq=++loadSequence;
  if(!auth.currentUser){body.hidden=true;rows=[];status.hidden=false;status.textContent=text('관리자 로그인이 필요합니다.','Connexion administrateur requise.');return;}
  status.hidden=false;status.textContent=text('신청자 목록을 불러오는 중…','Chargement des inscriptions…');
  try{
    const token=await auth.currentUser.getIdToken(true);
    const response=await fetch(ADMISSIONS_API+'/api/admin/list',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});
    if(seq!==loadSequence)return;
    if(!response.ok)throw new Error(response.status===403?'forbidden':'request');
    const data=await response.json();
    rows=data.registrations||[];summaries();render();body.hidden=false;status.hidden=true;
    const availability=await fetch(ADMISSIONS_API+'/api/status').then(r=>r.json()).catch(()=>({}));
    document.querySelector<HTMLElement>('#session-mail-state')!.textContent=availability.confirmationEmail?text('자동 접수 확인 메일 활성화','Confirmation automatique activée'):text('자동 접수 확인 메일 미설정 · 접속 링크는 별도로 안내할 수 있습니다.','Confirmation automatique non configurée · Envoyez les informations de connexion séparément.');
  }catch(e){if(seq!==loadSequence)return;rows=[];records.replaceChildren();body.hidden=true;status.hidden=false;status.textContent=(e as Error).message==='forbidden'?text('관리자 권한이 필요합니다.','Accès réservé aux administrateurs.'):text('신청자 목록을 불러오지 못했습니다. 다시 시도해 주세요.','Impossible de charger les inscriptions. Réessayez.');}
}
onAuthStateChanged(auth,u=>{
  if(!u){++loadSequence;body.hidden=true;rows=[];records.replaceChildren();status.hidden=false;status.replaceChildren();const link=document.createElement('a');link.href=root.dataset.login+'?next='+encodeURIComponent(location.pathname);link.textContent=text('관리자 로그인','Connexion administrateur');status.append(link);}
  else void load();
});
document.querySelector('#session-reload')!.addEventListener('click',()=>void load());
search.addEventListener('input',render);
document.querySelector('#session-copy')!.addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText([...new Set(visibleRows().map(r=>r.email))].join('; '));message.textContent=text('이메일 목록을 복사했습니다. 숨은참조에 붙여 넣으세요.','Adresses copiées. Collez-les en CCI.');}catch{message.textContent=text('복사하지 못했습니다.','Impossible de copier les adresses.');}
});
document.querySelector('#session-export')!.addEventListener('click',()=>{
  const xlsx=(window as Window&{XLSX?:any}).XLSX;
  if(!xlsx){message.textContent=text('Excel 기능을 불러오지 못했습니다.','Export Excel indisponible.');return;}
  const data=visibleRows(),max=Math.max(1,...data.map(r=>r.children.length));
  const headings=[text('신청일','Inscription'),text('성명','Nom'),text('이메일','E-mail'),text('거주 도시','Commune'),text('참가 목적','Motif'),text('언어','Langue'),...Array.from({length:max},(_,i)=>text('자녀 ','Enfant ')+(i+1))];
  const table=[headings,...data.map(r=>[date(r.createdAt),r.name,r.email,r.city,interestLabel(r.interest),r.lang,...Array.from({length:max},(_,i)=>r.children[i]?school(r.children[i]):'')])].map(r=>r.map(excelSafe));
  const sheet=xlsx.utils.aoa_to_sheet(table);sheet['!cols']=headings.map((_,i)=>({wch:i===2?34:i===4?32:20}));
  const workbook=xlsx.utils.book_new();xlsx.utils.book_append_sheet(workbook,sheet,'ASICC');xlsx.writeFile(workbook,'ASICC-admissions-2026-12-04.xlsx');
});
