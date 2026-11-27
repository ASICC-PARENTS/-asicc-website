export const SCHOOL_GRADES = Object.freeze({
  mat: ['PS','MS','GS'],
  elem: ['CP','CE1','CE2','CM1','CM2'],
});
export const CITIES = ['Courbevoie','Asnières-sur-Seine','La Garenne-Colombes','Colombes','Puteaux','Gennevilliers','Bois-Colombes','Nanterre','Paris'];
export const SESSION = '2026-12-04-online';
export const CUTOFF = Date.parse('2026-12-04T20:00:00+01:00');
export const PURGE_AT = Date.parse('2027-03-04T00:00:00+01:00');
export class InputError extends Error {}
const clean = (value,max) => {
  if(typeof value !== 'string') throw new InputError();
  const v=value.trim().normalize('NFC');
  if(!v || v.length > max || /[\u0000-\u001f\u007f]/u.test(v)) throw new InputError();
  return v;
};
export function validateRegistration(data) {
  if(!data || typeof data !== 'object' || Array.isArray(data) || data.consent !== true ||
      !['ko','fr'].includes(data.lang) || data.website) throw new InputError();
  const name=clean(data.name,100);
  const email=clean(data.email,254).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError();
  const city=data.city==='other'?clean(data.cityOther,100):clean(data.city,100);
  if(data.city!=='other' && !CITIES.includes(city)) throw new InputError();
  if(!['next_year','future','general'].includes(data.interest)) throw new InputError();
  if(!Array.isArray(data.children) || data.children.length>8 || (data.interest==='next_year' ? data.children.length<1 : data.children.length!==0)) throw new InputError();
  const children=data.children.map(c=>{
    if(!c || !Object.hasOwn(SCHOOL_GRADES,c.school) || !SCHOOL_GRADES[c.school].includes(c.grade)) throw new InputError();
    return {school:c.school,grade:c.grade};
  });
  return {session:SESSION,name,email,city,interest:data.interest,children,lang:data.lang,consent:true};
}
