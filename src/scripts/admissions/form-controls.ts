import type { User } from 'firebase/auth';
import {ADMISSIONS_API} from './config';
type Status={open:boolean;mode:'manual'|'scheduled'|'closed';closeAt:string|null;revision:number;controlVersion:number;retentionExpired:boolean};
const paris=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const localParis=(date:Date)=>paris.format(date).replace(' ','T');
// Find the UTC instant matching the Paris civil time: DST gap/fold must be explicit.
function fromParis(value:string){
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value))return null;
  const naive=Date.parse(value+'Z');
  if(!Number.isFinite(naive))return null;
  const matches=[60,120].map(offset=>new Date(naive-offset*60000)).filter(date=>localParis(date)===value);
  return matches.length===1?matches[0].toISOString():null;
}
export function setupFormControls(root:HTMLElement,user:User,ko:boolean){
  const t=(a:string,b:string)=>ko?a:b;
  const rows=Array.from(root.querySelectorAll<HTMLElement>('[data-form-id]'));
  const dialog=root.querySelector<HTMLDialogElement>('#form-control-dialog')!;
  const editor=root.querySelector<HTMLFormElement>('#form-control-editor')!;
  const mode=editor.elements.namedItem('mode') as HTMLSelectElement;
  const closeAt=editor.elements.namedItem('closeAt') as HTMLInputElement;
  const field=root.querySelector<HTMLElement>('#form-control-time')!;
  const message=root.querySelector<HTMLElement>('#form-control-message')!;
  const save=editor.querySelector<HTMLButtonElement>('[type=submit]')!;
  const cancel=root.querySelector<HTMLButtonElement>('#form-control-cancel')!;
  const controller=new AbortController(),signal=controller.signal;
  const values=new Map<string,Status>();
  let selected:{id:string;status:Status}|null=null;
  const rowId=(row:HTMLElement)=>row.dataset.formId!;
  const render=(row:HTMLElement,status:Status|null)=>{
    const id=rowId(row),label=row.querySelector<HTMLElement>('[data-form-state]')!,button=row.querySelector<HTMLButtonElement>('[data-form-edit]')!;
    if(!status){values.delete(id);label.textContent=t('상태 확인 실패','État indisponible');button.disabled=true;return;}
    values.set(id,status);
    label.textContent=(status.open?t('접수 중','Ouvert'):t('종료','Clos'))+
      (status.mode==='scheduled'&&status.closeAt?'\n'+t('예약: ','Prévue : ')+localParis(new Date(status.closeAt)).replace('T',' ')+' Paris':status.mode==='closed'&&status.closeAt?'\n'+localParis(new Date(status.closeAt)).replace('T',' ')+' Paris':'\n'+t('수동 종료','Manuelle'));
    button.disabled=status.retentionExpired;
  };
  const refresh=async()=>{
    await Promise.all(rows.map(async row=>{
      try{
        const response=await fetch(ADMISSIONS_API+'/api/forms/'+rowId(row)+'/status',{cache:'no-store',signal});
        if(!response.ok)throw Error();
        const status=await response.json() as Status;
        if(status.controlVersion!==1||typeof status.open!=='boolean')throw Error();
        if(!signal.aborted)render(row,status);
      }catch{if(!signal.aborted)render(row,null);}
    }));
  };
  const updateMode=()=>{field.hidden=mode.value!=='scheduled';closeAt.required=!field.hidden;};
  mode.addEventListener('change',updateMode,{signal});
  cancel.addEventListener('click',()=>dialog.close(),{signal});
  rows.forEach(row=>{
    row.querySelector<HTMLButtonElement>('[data-form-edit]')!.addEventListener('click',()=>{
      const id=rowId(row),status=values.get(id);
      if(!status||status.retentionExpired)return;
      selected={id,status};
      root.querySelector<HTMLElement>('#form-control-title')!.textContent=row.dataset.formTitle||'';
      mode.value=status.open?status.mode:'closed';
      closeAt.value=status.mode==='scheduled'&&status.closeAt?localParis(new Date(status.closeAt)):'';
      message.textContent='';save.disabled=false;
      updateMode();dialog.showModal();
    },{signal});
  });
  editor.addEventListener('submit',async e=>{
    e.preventDefault();if(!selected||save.disabled||!editor.reportValidity())return;
    const {id,status}=selected;
    let deadline:string|null=null;
    if(mode.value==='scheduled'){
      deadline=fromParis(closeAt.value);
      if(!deadline||Date.parse(deadline)<=Date.now()){
        message.textContent=t('미래의 유효한 파리 시각을 선택해 주세요. 서머타임 변경 시각은 피해주세요.','Choisissez une heure future valide à Paris, hors heures de changement d’heure.');return;
      }
    }
    if(mode.value==='closed'&&status.open&&!confirm(t('지금 공개 접수를 종료하시겠습니까? 기존 응답은 보관됩니다.','Clôturer les inscriptions maintenant ? Les réponses sont conservées.')))return;
    if(mode.value!=='closed'&&!status.open&&!confirm(t('공개 접수를 다시 시작하시겠습니까?','Rouvrir les inscriptions ?')))return;
    save.disabled=true;message.textContent=t('저장 중…','Enregistrement…');
    try{
      const token=await user.getIdToken(true);
      const response=await fetch(ADMISSIONS_API+'/api/admin/forms/'+id+'/settings',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({mode:mode.value,closeAt:deadline,expectedRevision:status.revision}),signal});
      if(response.status===409){message.textContent=t('설정이 변경되었거나 보관 기한이 지났습니다. 창을 닫고 다시 확인해 주세요.','Réglage modifié ou conservation expirée. Fermez puis vérifiez.');void refresh();return;}
      if(!response.ok)throw Error();
      const updated=await response.json() as Status;
      const row=rows.find(r=>rowId(r)===id);
      if(row)render(row,updated);
      dialog.close();
      void refresh();
    }catch{if(!signal.aborted)message.textContent=t('저장 결과를 확인하지 못했습니다. 목록을 새로고침해 주세요.','Impossible de confirmer l’enregistrement. Actualisez la liste.');}
    finally{save.disabled=false;}
  },{signal});
  void refresh();
  const interval=setInterval(refresh,30000);
  return ()=>{controller.abort();clearInterval(interval);dialog.close();rows.forEach(r=>render(r,null));};
}
