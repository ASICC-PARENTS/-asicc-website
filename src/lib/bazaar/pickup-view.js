// Render only event-level pickup information, never buyer notes.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderPickupDetail(data,lang){
  const fr=lang==='fr';
  const note=String((fr?data?.pickupFr:data?.pickupKo)||'').trim();
  if(!note)return '';
  // Link only an identifiable street-address line explicitly provided by the administrator.
  const address=note.split(/\r?\n/).map(line=>line.trim()).find(line=>/^\d+(?:\s*(?:bis|ter))?\s+(?:rue|avenue|boulevard|place|allée|chemin|impasse|route|quai|passage)\b.*\b\d{5}\b/i.test(line));
  const link=address?'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(address):'';
  return '<div class="buyer-pickup-detail"><h3>'+(fr?'Adresse et informations de retrait':'상세 주소 및 주차 안내')+'</h3><p>'+esc(note)+'</p>'+
    (link?'<a class="buyer-pickup-map" href="'+esc(link)+'" target="_blank" rel="noopener noreferrer">'+(fr?'Voir sur Google Maps':'Google Maps에서 위치 확인')+' ↗</a>':'')+'</div>';
}
