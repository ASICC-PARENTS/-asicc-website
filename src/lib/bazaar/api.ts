import {getApps,initializeApp} from 'firebase/app';
import {connectFunctionsEmulator,getFunctions,httpsCallable} from 'firebase/functions';
import {connectAuthEmulator,getAuth} from 'firebase/auth';
import {firebaseConfig} from '../../firebase-config';
const live = /^(www\.)?asicc-parents\.fr$/i.test(location.hostname);
const emulator = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  && import.meta.env.PUBLIC_ASICC_BAZAAR_EMULATOR === 'true';
const appName=emulator?'asicc-bazaar-emulator':'asicc-website';
const existing=getApps().find(a=>a.name===appName);
const app=existing??initializeApp(emulator?{apiKey:'demo-asicc-bazaar',projectId:'demo-asicc-bazaar'}:firebaseConfig,appName);
const functions=getFunctions(app,'europe-west1');
export const bazaarAuth=getAuth(app);
if(emulator&&!existing){
  connectAuthEmulator(bazaarAuth,'http://127.0.0.1:9099');
  connectFunctionsEmulator(functions,'127.0.0.1',5001);
}
async function invoke(name:string,payload:any={}){
  if(!live&&!emulator)throw new Error('이 환경에서는 바자회에 연결할 수 없습니다. / Le bazar est indisponible dans cet environnement.');
  const result=await httpsCallable(functions,name)(payload);
  return result.data as any;
}
export const getShop=(eventId:string)=>invoke('bazaarPublic',{eventId});
export const createOrder=(buyer:any)=>invoke('bazaarCreateOrder',buyer);
export const buyerAction=(p:any)=>invoke('bazaarBuyerAction',p);
export const adminAction=(p:any)=>invoke('bazaarAdmin',p);
export const eFormat=(c:number)=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(c/100);
export const h=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
