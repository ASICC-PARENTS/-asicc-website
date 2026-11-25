// Lengths from the SWIFT ISO 13616 registry for European refund accounts.
const lengths={
 AD:24,AL:28,AT:20,BA:20,BE:16,BG:22,BY:28,CH:21,CY:28,CZ:24,DE:22,DK:18,
 EE:20,ES:24,FI:18,FO:18,FR:27,GB:22,GI:23,GL:18,GR:27,HR:21,HU:28,IE:22,
 IS:26,IT:27,LI:21,LT:20,LU:20,LV:21,MC:27,MD:24,ME:22,MK:19,MT:31,NL:18,
 NO:15,PL:28,PT:25,RO:24,RS:22,SE:24,SI:19,SK:24,SM:27,TR:26,UA:29,VA:22,XK:20,
};

export function validRefundIban(iban){
 if(!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)||lengths[iban.slice(0,2)]!==iban.length)return false;
 let remainder=0;
 for(const char of iban.slice(4)+iban.slice(0,4)){
  const letter=char.charCodeAt(0)-55;
  remainder=char>='A'?(remainder*100+letter)%97:(remainder*10+Number(char))%97;
 }
 return remainder===1;
}
