import { doc, getDoc, updateDoc, serverTimestamp, type Firestore } from 'firebase/firestore';

// Record visits by verified, active account, not anonymous pageviews.
// Single field update; compatible only with reviewed Firestore PROPOSED_ONLY rules.
const INACTIVITY_WINDOW_MS = 10 * 60 * 1000;
// A Paris calendar-day change must count even if the last visit was 1 minute ago.
const parisDay = (ms:number) => new Intl.DateTimeFormat('sv-SE',{
  timeZone:'Europe/Paris', year:'numeric',month:'2-digit',day:'2-digit'
}).format(new Date(ms));
const inFlight = new Map<string,Promise<boolean>>();
export async function recordMemberActivity(db:Firestore, uid:string):Promise<boolean> {
  if(!uid) return false;
  const pending=inFlight.get(uid);
  if(pending)return pending;
  const key=`asicc-member-last-seen:${uid}`;
  const now=Date.now();
  try{
    const last=Number(localStorage.getItem(key)||0);
    if(last>0&&now-last<INACTIVITY_WINDOW_MS&&last<=now&&parisDay(last)===parisDay(now))return true;
  }catch{ /* browser storage may be unavailable */ }
  const work=(async()=>{
    try{
      const member=await getDoc(doc(db,'members',uid));
      if(!member.exists()||member.data().status!=='approved')return false;
      await updateDoc(member.ref,{lastSeenAt:serverTimestamp()});
      try{localStorage.setItem(key,String(Date.now()));}catch{ /* optional cache */ }
      return true;
    }catch(error){
      console.warn('ASICC member activity not recorded (check deployed Firestore rules):',error);
      return false;
    }
  })();
  inFlight.set(uid,work);
  try{return await work;}finally{if(inFlight.get(uid)===work)inFlight.delete(uid);}
}
