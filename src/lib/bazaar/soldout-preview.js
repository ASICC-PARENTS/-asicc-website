import {renderShopProducts} from './shop-view.js';
import {langPaths} from '../../i18n/ui';
export const previewPaths = () => process.env.ASICC_DESIGN_PREVIEW === 'true' ? langPaths() : [];
const samples=[
 {id:'test-sold',titleKo:'부뚜막 포기김치 8kg(4kg x 2ea)',titleFr:'Kimchi de chou Bbutumak 8 kg',descriptionKo:'강원도 배추로 만든 한국 직수입 김치입니다. 품절 상품의 상세 설명은 눌러서 펼칠 수 있습니다.',descriptionFr:'Kimchi de chou importé de Corée. Touchez pour afficher le détail du produit.',priceCents:6800,storage:'chilled',stockRemaining:0,imageUrl:'https://asicc-bazaar-test-api.falling-hall-f390.workers.dev/photo/bazaar-photos/bazaar-1795637217624-e68e66bc8716/nuri-pogi8/424651017e49606566468e228dd5072e79b913ba4711da5a6d1d434b784b0b4b'},
 {id:'test-available',titleKo:'부뚜막 석박지 8kg (4kg×2)',titleFr:'Kimchi de radis Bbutumak 8 kg',descriptionKo:'한국 직수입 석박지입니다. 판매 중인 상품은 기존 디자인 그대로입니다.',descriptionFr:'Kimchi de radis importé de Corée. Comparaison avec un produit disponible.',priceCents:7200,storage:'chilled',stockRemaining:24,imageUrl:'https://asicc-bazaar-test-api.falling-hall-f390.workers.dev/photo/bazaar-photos/bazaar-1795637217624-e68e66bc8716/nuri-seok8/adca7d81af2b8d79a666c7562f085800db5a9047dd490d48194813c11cbd26ef'}
];
export const renderSoldoutPreview = lang => renderShopProducts(samples,lang,{quantity:()=>0,price:n=>new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(n/100),controls:()=>'<div class="bz-qty"><button type="button" disabled>−</button><span>0</span><button type="button" disabled>+</button></div>'});
