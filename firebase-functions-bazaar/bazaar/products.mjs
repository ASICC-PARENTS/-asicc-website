// ASICC initial catalogue, 2026-11-23. Admin may edit every field before launch.
// Costs from supplied supplier lists, in euro cents; K-COMMERCE original HT is retained.
const k='K커머셜', n='누리커넥트';
const ko=(id,name,fr,supplier,price,pack,boxTTC,extra={})=>({
  id,titleKo:name,titleFr:fr,descriptionKo:'',descriptionFr:'',supplier,
  retailCents:price==null?null:Math.round(price*100),
  packQty:pack,boxPriceTtcCents:Math.round(boxTTC*100),boxPriceHtCents:null,
  plannedBoxes:null,limitMode:'manual',manualLimit:null,visible:true,
  storage:'ambient',imageUrl:'',soldQty:0,...extra
});
export const catalogue=[
ko('nuri-pogi8','부뚜막 포기김치 8kg (4kg×2)','Kimchi de chou Bbutumak 8 kg',n,65,1,56,{limitMode:'manual',manualLimit:20,storage:'chilled',descriptionKo:'4kg 포장 2개로 구성된 8kg 상품입니다.'}),
ko('nuri-seok8','부뚜막 석박지 8kg (4kg×2)','Kimchi de radis Bbutumak 8 kg',n,72,1,68,{limitMode:'manual',manualLimit:30,storage:'chilled',descriptionKo:'4kg 포장 2개로 구성된 8kg 상품입니다.'}),
ko('k-pogi10','종가집 포기김치 10kg','Kimchi de chou Jongga 10 kg',k,85,1,89.77,{visible:false,storage:'chilled',boxPriceHtCents:8509,descriptionKo:'공급가격 협의 중: 판매가격을 관리자에서 최종 확인해 주세요.'}),
ko('k-alt500','종가집 총각김치 500g','Kimchi de radis jeune Jongga 500 g',k,5.5,10,52.32,{limitMode:'manual',manualLimit:20,storage:'chilled',boxPriceHtCents:4959}),
ko('k-rice','이천쌀 Rhee Cheon Rice 9.07kg','Riz Rhee Cheon 9,07 kg',k,24,1,25.43,{visible:false,boxPriceHtCents:2410,descriptionKo:'10포 이상 25% 추가 할인 여부와 최종 공급가격 확인 중.'}),
ko('nuri-ricecake','부뚜막 떡볶이떡 1kg','Gâteaux de riz tteokbokki 1 kg',n,5.5,10,39,{storage:'chilled'}),
ko('nuri-gimmari','냉동 김말이 500g','Rouleaux d’algue frits 500 g',n,5.2,20,60,{storage:'frozen'}),
ko('nuri-hotteok','냉동 한국 호떡 10개입','Hotteok coréens (10 pièces)',n,15,12,132,{limitMode:'manual',manualLimit:36,storage:'frozen'}),
ko('k-mandu','비비고 갈비왕교자 525g','Raviolis Bibigo Galbi 525 g',k,8,15,101.47,{limitMode:'manual',manualLimit:34,storage:'frozen',boxPriceHtCents:9618}),
ko('nuri-hotdog','냉동 비건 핫도그 10개입','Hot-dogs vegan (10 pièces)',n,22,10,182,{limitMode:'manual',manualLimit:20,storage:'frozen'}),
ko('nuri-oriental','오리엔탈 샐러드 소스 2kg','Sauce salade orientale 2 kg',n,8,1,7),
ko('nuri-dakgalbi','닭갈비 소스 2kg','Sauce dakgalbi 2 kg',n,14,1,12.5),
ko('k-tofu','종가집 부침용 두부 300g','Tofu Jongga à poêler 300 g',k,2.2,12,26.25,{boxPriceHtCents:2488,limitMode:'manual',manualLimit:24,storage:'chilled'}),
ko('k-homerun','해태 홈런볼 46g','Biscuits Haitai Homerun Ball 46 g',k,2.05,30,61.05,{boxPriceHtCents:5787,limitMode:'manual',manualLimit:30}),
ko('k-pogi1','종가집 포기김치 1kg','Kimchi de chou Jongga 1 kg',k,null,5,53.96,{visible:false,storage:'chilled',boxPriceHtCents:5115})
].map((p,i)=>({...p,displayOrder:i+1}));
export const initialEvent={
  eventId:'bazaar-2026-11',
  serial:1,status:'draft',createdAt:'2026-11-23T12:00:00.000Z',
  nameKo:'ASICC 온라인 바자회',nameFr:'Boutique solidaire ASICC',
  introKo:'한국어 국제섹션 학생들의 교육·문화 활동을 응원하는 바자회입니다.',
  introFr:'Vente solidaire au profit des projets éducatifs et culturels de la section coréenne.',
  orderCutoff:'2026-11-27T11:00:00.000Z', // Friday 12:00 Europe/Paris
  transferCutoff:'2026-11-27T17:00:00.000Z', // Friday 18:00 Europe/Paris
  pickupKo:'12월 1일(화) 16:10–16:30, 베콩 초등학교 앞 (세부 위치 별도 안내)',
  pickupFr:'Mardi 1er décembre, 16h10–16h30, devant l’école primaire à Bécon (précisions à suivre)',
  beneficiary:'Association de la Section Internationale Coréenne à Courbevoie',
  iban:'',finalizedAt:null,finalizeNotBefore:'2026-11-30T08:00:00.000Z',
  contactEmail:'contact@asicc-parents.fr'
};
