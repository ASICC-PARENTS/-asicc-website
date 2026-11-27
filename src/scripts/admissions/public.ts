import { ADMISSIONS_API, GRADES } from './config';
const form=document.querySelector<HTMLFormElement>('#admission-session-form')!;
const ko=form.dataset.lang==='ko';
const childSection=document.querySelector<HTMLElement>('#session-children-section')!;
const list=document.querySelector<HTMLElement>('#session-children')!;
const city=form.elements.namedItem('city') as HTMLSelectElement;
const cityOther=form.elements.namedItem('cityOther') as HTMLInputElement;
const otherLabel=document.querySelector<HTMLElement>('#session-city-other')!;
const add=document.querySelector<HTMLButtonElement>('#session-add-child')!;
const submit=form.querySelector<HTMLButtonElement>('[type=submit]')!;
const message=document.querySelector<HTMLElement>('#session-form-message')!;
let sequence=0;
const text=(a:string,b:string)=>ko?a:b;
function updateCity(){
  const other=city.value==='other';
  otherLabel.hidden=!other;cityOther.required=other;cityOther.disabled=!other;
  if(!other)cityOther.value='';
}
city.addEventListener('change',updateCity);
function renumber(){
  const rows=[...list.querySelectorAll<HTMLElement>('.session-child')];
  rows.forEach((row,i)=>{
    row.querySelector('legend')!.textContent=text('입학 희망 자녀 ','Enfant ')+(i+1);
    (row.querySelector('.child-remove') as HTMLButtonElement).hidden=rows.length===1;
  });
  add.disabled=rows.length>=8;
}
function addChild(){
  if(list.children.length>=8)return;
  const id=++sequence;
  const row=document.createElement('fieldset');row.className='session-child';
  row.innerHTML=`<legend></legend><div class="child-header"><strong>${text('2027년 9월 입학 희망 학교 *','École souhaitée en septembre 2027 *')}</strong><button class="btn btn-ghost child-remove" type="button">${text('삭제','Retirer')}</button></div>
      <div class="child-options"><label><input type="radio" name="school-${id}" value="mat" required>${text('유치원','Maternelle')}</label><label><input type="radio" name="school-${id}" value="elem" required>${text('초등학교','Élémentaire')}</label></div>
      <label class="field">${text('입학 희망 학년 *','Classe souhaitée *')}<select class="child-grade" required disabled><option value="">${text('먼저 학교 선택','Sélectionner d’abord l’école')}</option></select></label>`;
  const select=row.querySelector<HTMLSelectElement>('select')!;
  row.addEventListener('change',e=>{
    const el=e.target as HTMLInputElement;
    if(el.type==='radio'){
      select.replaceChildren(new Option(text('학년 선택','Choisir la classe'),''));
      (GRADES[el.value]||[]).forEach(grade=>select.add(new Option(grade,grade)));
      select.disabled=false;
    }
  });
  row.querySelector('button')!.addEventListener('click',()=>{if(list.children.length>1){row.remove();renumber();}});
  list.appendChild(row);renumber();
}
add.addEventListener('click',addChild);
function updateInterest(){
  const needed=(form.querySelector<HTMLInputElement>('input[name="interest"]:checked')?.value==='next_year');
  childSection.hidden=!needed;
  if(needed && !list.children.length)addChild();
  if(!needed){list.replaceChildren();add.disabled=false;}
}
form.querySelectorAll('input[name="interest"]').forEach(el=>el.addEventListener('change',updateInterest));
form.addEventListener('submit',async e=>{
  e.preventDefault();
  if(!form.reportValidity())return;
  const data=new FormData(form);
  const children=[...list.querySelectorAll('.session-child')].map(row=>({school:row.querySelector<HTMLInputElement>('input:checked')?.value||'',grade:row.querySelector<HTMLSelectElement>('select')!.value}));
  submit.disabled=true;message.textContent=text('접수 중입니다…','Envoi en cours…');
  try {
    const response=await fetch(ADMISSIONS_API+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:data.get('name'),email:data.get('email'),city:data.get('city'),cityOther:data.get('cityOther'),interest:data.get('interest'),children,lang:form.dataset.lang,consent:data.get('consent')==='on',website:data.get('website')})});
    if(!response.ok){if(response.status===410){message.textContent=text('참가 신청이 마감되었습니다.','Les inscriptions sont closes.');return;}throw new Error();}
    const result=await response.json();if(result.ok!==true)throw new Error();
    form.reset();form.hidden=true;const thanks=document.querySelector<HTMLElement>('#session-thanks')!;thanks.hidden=false;thanks.focus();
  }catch{message.textContent=text('접수하지 못했습니다. 잠시 뒤 다시 시도해 주세요.','Échec de l’inscription. Veuillez réessayer.');}
  finally{if(!form.hidden)submit.disabled=false;}
});
fetch(ADMISSIONS_API+'/api/status').then(async r=>{
  if(!r.ok)throw new Error();const state=await r.json();
  submit.disabled=!state.open;if(!state.open)message.textContent=text('참가 신청이 마감되었습니다.','Les inscriptions sont closes.');
}).catch(()=>{message.textContent=text('접수 서비스를 불러오지 못했습니다. 페이지를 새로고침해 주세요.','Service indisponible. Actualisez cette page.');});
