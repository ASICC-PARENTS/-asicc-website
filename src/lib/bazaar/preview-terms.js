import {orderTerms,pickupTerms,pickupContact,refundAccountNotice} from '../../../firebase-functions-bazaar/bazaar/order-terms.mjs';
import {paymentGuidance,transferIdentification} from '../../../firebase-functions-bazaar/bazaar/payment-window.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

// Preview-only markup; reuse the real checkout's policy source and payment guidance.
export function renderPreviewTerms(lang,paymentHours=24,checked=false){
  const locale=lang==='fr'?'fr':'ko';
  const t=(ko,fr)=>locale==='fr'?fr:ko;
  const [heading,...notes]=paymentGuidance(locale,paymentHours);
  const paragraphs=rows=>rows.map(line=>'<p>'+escape(line)+'</p>').join('');
  const rules=orderTerms[locale],pickup=pickupTerms[locale];
  return '<p class="buyer-hint">'+escape(t('기한 안에 송금하고 송금 완료를 알려 주세요. 송금 신고 또는 입금 확인 후에는 온라인에서 직접 취소할 수 없습니다.','Effectuez et signalez votre virement avant la date limite. Après le signalement ou la confirmation du paiement, l’annulation en ligne n’est plus possible.'))+'</p>'+
    '<details class="buyer-terms" data-bz-disclosure="checkout-terms"><summary>'+escape(t('주문·송금·취소·환불·수령 상세 규정','Conditions de commande, de paiement, d’annulation, de remboursement et de retrait'))+'</summary>'+
    '<div class="buyer-terms-content"><h4>'+escape(heading)+'</h4>'+paragraphs(notes.concat(transferIdentification(locale)))+
    '<h3>'+escape(rules.title)+'</h3>'+paragraphs(rules.lines)+paragraphs([refundAccountNotice[locale]])+
    '<h3>'+escape(pickup.title)+'</h3>'+paragraphs(pickup.lines)+
    '<p>'+escape(pickup.contact)+' · <a href="mailto:'+escape(pickupContact)+'">'+escape(pickupContact)+'</a></p></div></details>'+
    '<label class="bz-consent"><input type="checkbox" data-preview-consent'+(checked?' checked':'')+'> <span>'+escape(t('주문 변경·취소·환불 및 상품 수령 안내를 확인했으며, 주문 처리와 연락을 위한 개인정보 이용에 동의합니다.','J’ai lu les conditions de modification, d’annulation, de remboursement et de retrait. J’accepte l’utilisation de mes données pour traiter ma commande et me contacter.'))+'</span></label>';
}
