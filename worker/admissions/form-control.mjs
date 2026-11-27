import { CUTOFF, PURGE_AT, SESSION, InputError } from './validation.mjs';
export const ADMISSION_FORM='admissions-session-2026-12-04';
export const MEMBER_FORM='member-survey-2026-11';
export const CONTROL_KEY='form-control:v1';
export const FORMS=new Map([[ADMISSION_FORM,SESSION],[MEMBER_FORM,MEMBER_FORM]]);
export function statusFor(id,env,stored,now=Date.now()){
  const defaultSchedule=id===ADMISSION_FORM && env.ADMISSIONS_MODE==='production';
  const config=stored??{mode:defaultSchedule?'scheduled':'manual',closeAt:defaultSchedule?new Date(CUTOFF).toISOString():null,revision:0};
  const expired=id===ADMISSION_FORM && env.ADMISSIONS_MODE==='production' && now>=PURGE_AT;
  return {controlVersion:1,...config,open:!expired && config.mode!=='closed' && !(config.mode==='scheduled' && now>=Date.parse(config.closeAt)),serverNow:new Date(now).toISOString(),retentionExpired:expired};
}
export function nextControl(id,env,stored,body,now=Date.now()){
  const current=statusFor(id,env,stored,now);
  if(!body || !Number.isInteger(body.expectedRevision) || !['manual','scheduled','closed'].includes(body.mode))throw new InputError();
  if(body.expectedRevision!==current.revision)return {error:'conflict'};
  if(current.retentionExpired)return {error:'expired'};
  let closeAt=null;
  if(body.mode==='scheduled'){
    const timestamp=typeof body.closeAt==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body.closeAt)?Date.parse(body.closeAt):NaN;
    if(!Number.isFinite(timestamp)||timestamp<=now|| (id===ADMISSION_FORM && env.ADMISSIONS_MODE==='production' && timestamp>PURGE_AT))throw new InputError();
    closeAt=new Date(timestamp).toISOString();
  }else if(body.mode==='closed')closeAt=new Date(now).toISOString();
  return {mode:body.mode,closeAt,revision:current.revision+1};
}
