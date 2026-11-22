const parisDate = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function formatParisDate(value?: {toDate?:()=>Date}|Date|null): string {
  try {
    const date=value instanceof Date?value:value?.toDate?.();
    if(!date||!Number.isFinite(date.getTime()))return '';
    const parts=Object.fromEntries(parisDate.formatToParts(date).map(p=>[p.type,p.value]));
    return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
  } catch {return '';}
}
