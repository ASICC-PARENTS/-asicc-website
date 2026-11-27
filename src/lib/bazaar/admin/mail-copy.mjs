// Only the manual job receives these overrides; the event template is never mutated.
export function selectedMailCopy(mode,draft,defaults){
  if(mode!=='custom')return {};
  return Object.fromEntries(['subjectKo','introKo','subjectFr','introFr'].map(key=>
    [key,String(draft?.[key]??defaults[key]).trim()]));
}
