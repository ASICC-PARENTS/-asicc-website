export type AccountAccess={status?:string;accountType?:string;birthDate?:string;adultAt?:{toMillis?:()=>number}|null;dmMode?:string;role?:string;nickname?:string;memberKind?:string;memberRelation?:string};
// The administrator's explicit override wins over age checks. General and
// inactive accounts are excluded from private messaging at the role boundary.
export function dmAllowed(p:AccountAccess,now=Date.now()):boolean {
  if(p.status!=='approved'||!['member','special','admin'].includes(p.role||'')||p.dmMode==='off')return false;
  if(p.dmMode==='on'||p.role==='admin')return true;
  if(p.accountType==='student'||p.memberKind==='alumnus'||p.memberRelation==='student'||p.birthDate){
    return validBirthDate(p.birthDate||'')&&adulthoodDate(p.birthDate!).getTime()<=now;
  }
  return p.accountType==='adult'||['parent','alumni-parent','teacher','contributor'].includes(p.memberKind||'');
}
export function validBirthDate(v:string):boolean {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||v<'1900-01-01')return false;
  const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v&&d.getTime()<=Date.now();
}
// At the latest boundary of the birthday in metropolitan France (UTC midnight).
// Feb 29 births use March 1 in a non-leap year; access never opens early.
export function adulthoodDate(v:string):Date {const [y,m,d]=v.split('-').map(Number);return new Date(Date.UTC(y+18,m-1,d));}
export function ageOn(v:string):number|null {if(!validBirthDate(v))return null;const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=(t:string)=>Number(today.find(x=>x.type===t)?.value);const [y,m,d]=v.split('-').map(Number);return get('year')-y-(get('month')<m||get('month')===m&&get('day')<d?1:0);}
