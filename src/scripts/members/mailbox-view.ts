export type MailboxRow = {id:string;recipientDeletedAt?:unknown;createdAt?:{toDate?:()=>Date}};
export const MAIL_PAGE_SIZE=20;
export function mailboxOrder<T extends MailboxRow>(items:T[],incoming:boolean):T[]{
  return items.filter(x=>!incoming||!x.recipientDeletedAt).sort((l,r)=>(r.createdAt?.toDate?.()?.getTime()||0)-(l.createdAt?.toDate?.()?.getTime()||0)||l.id.localeCompare(r.id));
}
export function mailboxPage<T>(items:T[],requested:number){
  const count=Math.max(1,Math.ceil(items.length/MAIL_PAGE_SIZE));
  const page=Math.min(Math.max(0,requested),count-1);
  return {page,count,rows:items.slice(page*MAIL_PAGE_SIZE,(page+1)*MAIL_PAGE_SIZE)};
}
