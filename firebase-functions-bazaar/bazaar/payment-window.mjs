export const defaultPaymentHours=24;

export const transferIdentification=lang=>lang==='fr'
 ? 'Afin de faciliter l’identification de votre paiement, veuillez indiquer votre numéro de commande ou le nom du client dans le libellé du virement. Si le virement est effectué depuis le compte d’une autre personne, cette information doit impérativement figurer dans le libellé du virement.'
 : '입금 확인을 위해 송금 시 입금자명 또는 송금 메모에 주문번호 혹은 주문자 이름을 정확하게 기재해 주세요. 다른 사람의 명의로 송금하시는 경우 반드시 송금 메모에 주문번호 또는 주문자 이름을 입력해 주세요.';

export function personalTransferDeadline(createdAt,event){
 const start=Date.parse(createdAt),overall=Date.parse(event.transferCutoff);
 const hours=event.paymentHours??defaultPaymentHours;
 if(!Number.isFinite(start))return event.transferCutoff||null;
 const personal=start+hours*3600000;
 return new Date(Number.isFinite(overall)?Math.min(personal,overall):personal).toISOString();
}

export function paymentGuidance(lang,hours=defaultPaymentHours){
 if(lang==='fr')return [
  'Modalités de paiement et de confirmation de commande',
  'Merci d’effectuer votre virement dans les '+hours+' heures suivant votre commande, ou avant la date limite générale de paiement du bazar si celle-ci intervient plus tôt.',
  'Afin de faciliter la confirmation de votre paiement, nous vous recommandons d’utiliser le virement instantané.',
  'Une fois le virement effectué, veuillez impérativement cliquer sur « Signaler mon virement » depuis votre page de suivi de commande.',
  'Certains produits étant disponibles en quantité limitée, toute commande dont le virement n’a pas été signalé dans le délai imparti pourra être annulée afin de permettre à d’autres acheteurs d’en bénéficier.',
  'Merci de votre compréhension et de votre coopération.',
 ];
 return [
  '송금 및 주문 확정 안내',
  '주문 후 '+hours+'시간 이내에 송금해 주시기 바랍니다. 단, 행사 전체 송금 마감이 더 빠른 경우에는 해당 마감 시간이 적용됩니다.',
  '신속한 입금 확인을 위해 즉시 계좌이체(Virement instantané)를 권장합니다.',
  '송금 후 반드시 주문관리 페이지에서 ‘송금 완료 알리기’ 버튼을 눌러주시기 바랍니다.',
  '일부 상품은 한정수량으로 판매되므로 다른 구매자의 구매 기회를 보장하기 위해 기한 내 송금 완료 신고가 이루어지지 않은 주문은 취소될 수 있습니다.',
  '여러분의 이해와 협조에 감사드립니다.',
 ];
}
