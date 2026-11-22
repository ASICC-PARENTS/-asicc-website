/** ASICC event gallery: member self-publishing, optional review, admin moderation.
 * Gallery is CLOSED until an administrator explicitly changes siteSettings/gallery.
 * Files are always fetched through the authenticated private B2 Worker.
 */
import { getApps, initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, getIdToken } from 'firebase/auth';
import { getFirestore, doc, collection, getDoc, getDocs, query, where, setDoc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { firebaseConfig } from '../../firebase-config';
import {BOARD_PHOTO_API} from '../../config/board-photos';
import {displayAuthor,dmAllowed,syncOwnAlias,type PublicAuthor} from './member-access';

type School='kindergarten'|'elementary'|'middle'|'common';
type FileMeta={id:string;mime:string;size:number};
type Album={id:string;title:string;school:School;year:number;ownerUid:string;isShared:boolean;coverItemId?:string;createdAt?:{toDate?:()=>Date};updatedAt?:unknown};
type Photo={id:string;albumId:string;title:string;description:string;authorUid:string;status:'draft'|'published'|'pending'|'hidden'|'rejected';image:FileMeta;mediaType:'photo'|'video';originalName?:string;sortOrder?:number;reviewReason?:string;createdAt?:{toDate?:()=>Date};updatedAt?:unknown};
const root=document.querySelector<HTMLElement>('#gallery-root');
const by=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T|null;
const fr=root?.dataset.lang==='fr';const tr=(ko:string,french:string)=>fr?french:ko;
const t=(id:string,v:string)=>{const e=by<HTMLElement>(id);if(e)e.textContent=v;};
const show=(id:string,visible:boolean)=>{const e=by<HTMLElement>(id);if(e)e.hidden=!visible;};
const msg=(v:string,fail=false)=>{const n=by<HTMLElement>('gallery-status');if(n){n.hidden=false;n.textContent=v;n.style.color=fail?'#aa1d1d':'';}};
const node=(tag:string,content?:string)=>{const n=document.createElement(tag);if(content!==undefined)n.textContent=content;return n;};
const button=(label:string,handler:()=>void)=>{const b=node('button',label) as HTMLButtonElement;b.type='button';b.className='btn btn-ghost';b.addEventListener('click',handler);return b;};
const app=getApps().find(a=>a.name==='asicc-website')??initializeApp(firebaseConfig,'asicc-website');
const auth=getAuth(app),db=getFirestore(app),api=BOARD_PHOTO_API.trim().replace(/\/$/,'');
let uid='',role='',opened=false,albums:Album[]=[],photos:Photo[]=[],selected:Album|null=null;
let preview=false,viewerDM=false;let busy=false;const selectedPhotoIds=new Set<string>();const mediaCache=new Map<string,string>();
const authorCache=new Map<string,Promise<PublicAuthor>>();
const roleLabel=(value:string)=>({general:tr('일반회원','Membre général'),member:tr('정회원','Membre régulier'),special:tr('특별회원','Membre spécial'),admin:tr('운영진','Administrateur')} as Record<string,string>)[value]||tr('회원','Membre');
function authorName(id:string){
  if(!id)return Promise.resolve({nickname:tr('회원','Membre'),role:''});
  if(!authorCache.has(id))authorCache.set(id,getDoc(doc(db,'publicNames',id)).then(snapshot=>({
    nickname:String(snapshot.data()?.nickname||tr('회원','Membre')),
    role:String(snapshot.data()?.role||''),canReceiveDM:snapshot.data()?.canReceiveDM===true
  })).catch(()=>({nickname:tr('회원','Membre'),role:''})));
  return authorCache.get(id)!;
}

const canPost=()=>!preview&&['member','special','admin'].includes(role);
const admin=()=>role==='admin'&&!preview;
const visibleMedia=(p:Photo)=>preview?p.status==='published':admin()||p.status==='published'||p.authorUid===uid;
const paintAuthor=(target:HTMLElement,id:string,info:PublicAuthor)=>displayAuthor(target,info,id,uid,preview?'member':role,!preview&&viewerDM,fr,'../messages/');
const schoolName=(s:School)=>({kindergarten:tr('유치원','Maternelle'),elementary:tr('초등학교','Élémentaire'),middle:tr('중학교','Collège'),common:tr('공통 행사','Événements communs')})[s]||s;
const dateText=(ts?:{toDate?:()=>Date})=>ts?.toDate?.()?.toLocaleDateString(fr?'fr-FR':'ko-KR')||'';
const getMedia=async (path:string,method='GET',payload?:Blob,mime?:string)=>{
  if(!api)throw Error('Private file server missing');
  const user=auth.currentUser;if(!user)throw Error('Please sign in');
  const token=await getIdToken(user);
  const response=await fetch(api+path,{method,headers:{Authorization:`Bearer ${token}`,...(payload?{'Content-Type':mime||payload.type}:{})},body:payload,cache:'no-store'});
  if(!response.ok){const detail=await response.json().catch(()=>null) as {error?:string}|null;throw Error(`HTTP ${response.status}${detail?.error?' · '+String(detail.error).slice(0,120):''}`);}
  return response;
};
const filePath=(photo:Photo)=>`/api/gallery?itemId=${encodeURIComponent(photo.id)}`;
function locked(){show('gallery-closed',true);show('gallery-app',false);msg('');}
async function loadSettings(){
  const snapshot=await getDoc(doc(db,'siteSettings','gallery'));
  opened=snapshot.exists()&&snapshot.data()?.isOpen===true;
  if(!opened&&!admin()){locked();return false;}
  show('gallery-closed',false);show('gallery-app',true);show('gallery-admin-banner',admin()&&!opened);show('gallery-preview-controls',role==='admin');
  if(!opened)msg(tr('비공개 운영진 시험 모드입니다. 실제 아동 사진을 업로드하지 마세요.','Mode de test privé : ne publiez pas de véritables photos de mineurs.'));
  else msg('');
  return true;
}
const revoke=()=>{for(const x of mediaCache.values())URL.revokeObjectURL(x);mediaCache.clear();};
async function refresh(){
  if(!opened&&!admin()&&!preview)return;
  const snap=await getDocs(collection(db,'galleryAlbums'));
  albums=snap.docs.map(d=>({id:d.id,...d.data()} as Album));
  albums.sort((a,b)=>b.year-a.year||a.title.localeCompare(b.title));
  renderAlbums();
  if(selected){selected=albums.find(a=>a.id===selected?.id)||null;if(selected)await openAlbum(selected);else show('album-detail',false);}
}
function renderAlbums(){
  const list=by<HTMLElement>('album-list');if(!list)return;list.replaceChildren();
  const level=by<HTMLSelectElement>('album-school-filter')?.value||'all';
  const year=by<HTMLSelectElement>('album-year-filter')?.value||'all';
  const search=by<HTMLInputElement>('album-search')?.value.trim().toLocaleLowerCase()||'';
  const yearSelect=by<HTMLSelectElement>('album-year-filter');
  if(yearSelect){const current=yearSelect.value;yearSelect.replaceChildren();const all=node('option',tr('전체 연도','Toutes les années')) as HTMLOptionElement;all.value='all';yearSelect.append(all);
    for(let y=Math.max(2018,new Date().getFullYear());y>=2018;y--){const o=node('option',`${y}`) as HTMLOptionElement;o.value=String(y);yearSelect.append(o);}yearSelect.value=[...yearSelect.options].some(o=>o.value===current)?current:'all';}
  for(const album of albums.filter(a=>(level==='all'||a.school===level)&&(year==='all'||String(a.year)===year)&&a.title.toLocaleLowerCase().includes(search))){
    const card=node('article');card.className='gallery-album-card';
    const open=button(`📁 ${album.title}`,()=>void openAlbum(album));open.className='board-title-link';card.append(open,node('span',`${schoolName(album.school)} · ${album.year}`));
    if(album.coverItemId){
      const cover=node('img') as HTMLImageElement;cover.className='gallery-album-cover';cover.alt=album.title;
      cover.loading='lazy';cover.style.cursor='pointer';cover.addEventListener('click',()=>void openAlbum(album));card.prepend(cover);
      const cached=mediaCache.get(album.coverItemId);
      if(cached)cover.src=cached;
      else void (async()=>{if(preview){const coverRecord=await getDoc(doc(db,'galleryItems',album.coverItemId!));if(coverRecord.data()?.status!=='published')throw Error('Not published');}return getMedia(`/api/gallery?itemId=${encodeURIComponent(album.coverItemId)}`);})().then(r=>r.blob()).then(blob=>{
        if(!cover.isConnected)return;const url=URL.createObjectURL(blob);mediaCache.set(album.coverItemId!,url);cover.src=url;
      }).catch(()=>{cover.remove();});
    }
    const byWho=node('span',tr('앨범 생성자 확인 중','Chargement du créateur'));byWho.className='small muted';card.append(byWho);void authorName(album.ownerUid).then(label=>{if(card.isConnected)paintAuthor(byWho,album.ownerUid,label);});
    list.append(card);
  }
  if(!list.children.length)list.append(node('p',tr('아직 앨범이 없습니다.','Aucun album pour cette sélection.')));
}
async function openAlbum(album:Album){
  if(selected?.id!==album.id){clearUploadPreview();by<HTMLFormElement>('media-upload-form')?.reset();by<HTMLElement>('gallery-file-review')?.replaceChildren();}
  revoke();selected=album;show('album-list',false);show('album-detail',true);show('media-upload-form',canPost());
  t('album-active-title',album.title);t('album-active-meta',`${schoolName(album.school)} · ${album.year} · ${dateText(album.createdAt)}`);
  const actions=by<HTMLElement>('album-actions');actions?.replaceChildren();
  selectedPhotoIds.clear();show('gallery-bulk-tools',admin());
  const target=by<HTMLSelectElement>('gallery-target-album');
  if(target){target.replaceChildren();for(const a of albums){const o=node('option',`${a.year} / ${schoolName(a.school)} / ${a.title}`) as HTMLOptionElement;o.value=a.id;target.append(o);}}
  const owner=album.ownerUid===uid;
  if(!preview&&(admin()||owner&&!album.isShared)){
    actions?.append(button(tr('앨범 이름 변경','Renommer l’album'),()=>void renameAlbum(album)),button(tr('앨범 삭제','Supprimer l’album'),()=>void removeAlbum(album)));
  }
  if(admin()){
    if(actions){actions.append(albumSelect(album,'school'),albumSelect(album,'year'));}
    actions?.append(button(tr('앨범 합치기','Fusionner l’album'),()=>void mergeAlbum(album)));
    if(album.isShared)actions?.append(button(tr('공유 잠금 해제 확인','Vérifier le déverrouillage'),()=>void unlockAlbum(album)));
  }
  try{
    let snapshots;
    if(role==='admin'){const all=await getDocs(collection(db,'galleryItems'));snapshots={docs:all.docs.filter(d=>d.data().albumId===album.id)};}
    else{
      const published=await getDocs(query(collection(db,'galleryItems'),where('status','==','published')));
      const mine=await getDocs(query(collection(db,'galleryItems'),where('authorUid','==',uid)));
      const found=new Map([...published.docs.filter(d=>d.data().albumId===album.id),...mine.docs.filter(d=>d.data().albumId===album.id)].map(d=>[d.id,d]));
      snapshots={docs:[...found.values()]};
    }
    if(selected?.id!==album.id)return;
    photos=snapshots.docs.map(d=>({id:d.id,...d.data()} as Photo)).filter(visibleMedia);
    photos.sort((a,b)=>(a.sortOrder??100000)-(b.sortOrder??100000)||((a.createdAt?.toDate?.()?.getTime()||0)-(b.createdAt?.toDate?.()?.getTime()||0)));
    renderPhotos();
  }catch(e){console.error(e);msg(tr('사진 목록을 불러오지 못했습니다. Firebase 규칙을 확인하세요.','Impossible de charger les médias. Vérifiez les règles Firebase.'),true);}
}
async function renameAlbum(album:Album){
  if(!await noOtherMembers(album))return;
  const name=prompt(tr('새 앨범 이름을 입력하세요.','Nouveau nom de l’album'),album.title)?.trim();if(!name||name===album.title||name.length>120)return;
  try{await updateDoc(doc(db,'galleryAlbums',album.id),{title:name,updatedAt:serverTimestamp()});await refresh();}catch(e){console.error(e);msg(tr('앨범 이름을 변경할 권한이 없습니다.','Modification non autorisée.'),true);}
}
async function noOtherMembers(album:Album){
  if(admin())return true;
  if(album.ownerUid!==uid||album.isShared){msg(tr('다른 회원이 참여한 앨범은 운영진에게 변경을 요청해 주세요.','Un album partagé est modifiable uniquement par l’administration.'),true);return false;}
  // The client checks actual contributors too. The immutable isShared server flag
  // prevents a hostile client from bypassing this protection after collaboration.
  return true;
}
async function removeAlbum(album:Album){
  try{
    if(!await noOtherMembers(album))return;
    if(!confirm(tr('앨범과 본인이 올린 모든 사진·동영상을 삭제할까요?','Supprimer cet album et tous vos médias ?')))return;
    const snap=admin()?await getDocs(collection(db,'galleryItems')):await getDocs(query(collection(db,'galleryItems'),where('authorUid','==',uid)));
    if(admin()&&snap.docs.some(d=>d.data().albumId===album.id&&d.data().authorUid!==uid)){
      msg(tr('다른 회원의 자료가 있습니다. 운영진은 먼저 해당 사진을 다른 앨범으로 옮겨야 삭제할 수 있습니다.','Déplacez les médias des autres membres avant de supprimer cet album.'),true);return;
    }
    for(const d of snap.docs.filter(d=>d.data().albumId===album.id)){const item={id:d.id,...d.data()} as Photo;
      await getMedia(filePath(item),'DELETE');await deleteDoc(doc(db,'galleryItems',item.id));
    }
    await deleteDoc(doc(db,'galleryAlbums',album.id));selected=null;show('album-detail',false);await refresh();
  }catch(e){console.error(e);msg(tr('일부 파일 또는 앨범을 삭제하지 못했습니다. 관리자에게 문의해 주세요.','Suppression incomplète. Contactez un administrateur.'),true);}
}
async function mergeAlbum(album:Album){
  if(!admin())return;
  const destId=by<HTMLSelectElement>('gallery-target-album')?.value||'';
  const destination=albums.find(a=>a.id===destId);
  if(!destination||destination.id===album.id){msg(tr('이동할 다른 앨범을 선택한 후 다시 시도해 주세요.','Sélectionnez un autre album de destination.'),true);return;}
  try{
    const source=await getDocs(collection(db,'galleryItems'));
    const media=source.docs.filter(item=>item.data().albumId===album.id);
    if(!confirm(tr(`「${album.title}」 앨범의 ${media.length}개 파일을 「${destination.title}」로 옮기고 빈 앨범을 삭제할까요?`,`Déplacer ${media.length} fichiers de « ${album.title} » vers « ${destination.title} », puis supprimer l’album vide ?`)))return;
    if(media.some(item=>item.data().authorUid!==destination.ownerUid)&&!destination.isShared){
      await updateDoc(doc(db,'galleryAlbums',destination.id),{isShared:true,updatedAt:serverTimestamp()});destination.isShared=true;
    }
    for(const item of media)await updateDoc(doc(db,'galleryItems',item.id),{albumId:destination.id,updatedAt:serverTimestamp()});
    // Recheck before deletion to avoid orphaning newly added member media.
    const remaining=await getDocs(collection(db,'galleryItems'));
    if(remaining.docs.some(item=>item.data().albumId===album.id))throw Error('Source album changed during merge');
    await deleteDoc(doc(db,'galleryAlbums',album.id));selected=null;show('album-detail',false);
    await refresh();msg(tr('앨범 합치기를 완료했습니다.','Albums fusionnés.'));
  }catch(error){console.error(error);msg(tr('앨범 합치기가 일부 실패했습니다. 남아 있는 파일을 확인해 주세요.','Fusion incomplète : vérifiez les fichiers restants.'),true);}
}
async function unlockAlbum(album:Album){
  if(!admin()||!album.isShared)return;
  try{
    // Administrators may read all unpublished gallery items. The creator may not.
    const all=await getDocs(collection(db,'galleryItems'));
    if(all.docs.some(doc=>doc.data().albumId===album.id&&doc.data().authorUid!==album.ownerUid)){
      msg(tr('다른 회원의 사진 또는 동영상이 남아 있어 잠금을 해제할 수 없습니다.','Des médias déposés par d’autres membres sont encore présents.'),true);return;
    }
    if(!confirm(tr('다른 회원의 자료가 없는 것을 확인했습니다. 앨범 생성자의 이름 변경·삭제 권한을 되돌릴까요?','Aucun média d’un tiers : rétablir les droits du créateur ?')))return;
    await updateDoc(doc(db,'galleryAlbums',album.id),{isShared:false,updatedAt:serverTimestamp()});await refresh();
  }catch(e){console.error(e);msg(tr('공유 상태를 확인하지 못했습니다.','Impossible de vérifier le statut de partage.'),true);}
}
function albumSelect(album:Album,field:'school'|'year'){
  const group=node('label');group.className='stack gap-8';group.append(node('span',field==='school'?tr('학교 변경','Modifier l’établissement'):tr('연도 변경','Modifier l’année')));
  const select=node('select') as HTMLSelectElement;
  const values=field==='school'?['kindergarten','elementary','middle','common']:Array.from({length:Math.max(new Date().getFullYear(),album.year)-2018+1},(_,i)=>String(Math.max(new Date().getFullYear(),album.year)-i));
  for(const v of values){const opt=node('option',field==='school'?schoolName(v as School):v) as HTMLOptionElement;opt.value=v;select.append(opt);}select.value=String(album[field]);
  const save=button(tr('저장','Enregistrer'),async()=>{if(!admin())return;save.disabled=true;try{await updateDoc(doc(db,'galleryAlbums',album.id),{[field]:field==='year'?Number(select.value):select.value,updatedAt:serverTimestamp()});await refresh();}catch(e){console.error(e);msg(tr('앨범을 수정하지 못했습니다.','Modification impossible.'),true);}finally{save.disabled=false;}});
  group.append(select,save);return group;
}
const mediaBtn=(caption:string,onClick:()=>void)=>{const b=button(caption,onClick);b.classList.add('btn-sm');return b;};
function renderPhotos(){
  const list=by<HTMLElement>('gallery-items');if(!list)return;list.replaceChildren();
  for(const photo of photos){
    if(!visibleMedia(photo))continue;
    const card=node('article');card.className='gallery-media-card';
    if(admin()){const pick=node('label') as HTMLLabelElement;pick.style.cssText='display:flex;gap:7px;align-items:center;padding:8px';
      const input=node('input') as HTMLInputElement;input.type='checkbox';input.checked=selectedPhotoIds.has(photo.id);
      input.addEventListener('change',()=>{if(input.checked)selectedPhotoIds.add(photo.id);else selectedPhotoIds.delete(photo.id);});
      pick.append(input,node('span',tr('일괄 작업 선택','Sélectionner')));card.append(pick);}
    const media=photo.mediaType==='video'?node('video') as HTMLVideoElement:node('img') as HTMLImageElement;
    if(media instanceof HTMLImageElement){media.alt=photo.description||tr('갤러리 사진','Photo de galerie');media.loading='lazy';}else{media.controls=true;media.playsInline=true;media.setAttribute('controlsList','nodownload');media.preload='metadata';}
    card.append(media);const caption=node('div');caption.className='gallery-media-caption';
    if(photo.description)caption.append(node('p',photo.description));
    const author=node('span',tr('등록자 확인 중','Chargement de l’auteur'));author.className='small muted';caption.append(author);
    void authorName(photo.authorUid).then(label=>{if(card.isConnected)paintAuthor(author,photo.authorUid,label);});
    if(photo.status!=='published'){const tag=node('span',({pending:tr('승인 대기 · 비공개','En attente'),hidden:tr('비공개','Masqué'),rejected:tr('반려됨','Refusé'),draft:tr('업로드 중','En transfert')})[photo.status]||'');tag.className=photo.status==='pending'?'asicc-gallery-pending':'small muted';caption.append(tag);}
    const actions=node('div');actions.className='row gap-8';actions.style.flexWrap='wrap';
    if(!preview&&(photo.authorUid===uid||admin())){
      actions.append(mediaBtn(tr('설명 수정','Modifier'),()=>void editPhoto(photo)),mediaBtn(tr('삭제','Supprimer'),()=>void deletePhoto(photo)));
    }
    if(admin()){
      if(photo.status!=='published'&&photo.status!=='draft')actions.append(mediaBtn(tr('승인·공개','Approuver'),()=>void changePhotoStatus(photo,'published')));
      if(photo.status==='published')actions.append(mediaBtn(tr('비공개','Masquer'),()=>void changePhotoStatus(photo,'hidden')));
      if(photo.status==='pending')actions.append(mediaBtn(tr('반려','Refuser'),()=>void changePhotoStatus(photo,'rejected')));
      actions.append(mediaBtn(tr('저장된 파일 다운로드','Télécharger le fichier stocké'),()=>void downloadPhoto(photo)));
      if(photo.mediaType==='photo'&&photo.status==='published')actions.append(mediaBtn(tr('앨범 대표 사진으로 지정','Choisir comme couverture'),()=>void setAlbumCover(photo)));
      actions.append(mediaBtn(tr('앨범 이동','Déplacer'),()=>void movePhoto(photo)));
      actions.append(mediaBtn('↑',()=>void changeOrder(photo,-1)),mediaBtn('↓',()=>void changeOrder(photo,1)));
    }
    if(!preview&&!admin()&&selected?.ownerUid===uid&&photo.mediaType==='photo'&&photo.status==='published'){
      actions.append(mediaBtn(tr('앨범 대표 사진으로 지정','Choisir comme couverture'),()=>void setAlbumCover(photo)));
    }
    if(actions.children.length)caption.append(actions);
    card.append(caption);list.append(card);
    if(photo.status!=='draft')void getMedia(filePath(photo)).then(r=>r.blob()).then(b=>{
      if(!media.isConnected)return;const url=URL.createObjectURL(b);mediaCache.set(photo.id,url);media.addEventListener('error',()=>{if(!media.isConnected)return;const warning=node('p',tr('파일을 읽을 수 없습니다.','Fichier illisible.'));warning.className='asicc-gallery-error';media.replaceWith(warning);},{once:true});media.src=url;
      if(media instanceof HTMLImageElement)media.addEventListener('click',()=>lightbox(photo,url));
    }).catch((error)=>{if(!media.isConnected)return;const warning=node('p',tr('미리보기를 불러오지 못했습니다.','Aperçu indisponible.')+' '+String(error.message||error));warning.className='asicc-gallery-error';media.replaceWith(warning);});
    else{const warning=node('p',tr('업로드가 완료되지 않은 파일입니다.','Transfert incomplet.'));warning.className='asicc-gallery-error';media.replaceWith(warning);}
  }
  if(!list.children.length)list.append(node('p',tr('이 앨범에 공개된 사진이 없습니다.','Aucun média dans cet album.')));
}
let lightboxPosition=-1;
function lightbox(photo:Photo,url:string){
  const dialog=by<HTMLDialogElement>('gallery-lightbox'),holder=by<HTMLElement>('gallery-lightbox-media');
  if(!holder||!dialog)return;
  const visible=photos.filter(visibleMedia);
  lightboxPosition=visible.findIndex(p=>p.id===photo.id);
  holder.replaceChildren();
  const media=photo.mediaType==='video'?node('video') as HTMLVideoElement:node('img') as HTMLImageElement;
  media.src=url;if(media instanceof HTMLVideoElement){media.controls=true;media.setAttribute('controlsList','nodownload');}else media.alt=photo.description||tr('갤러리 사진','Photo de galerie');
  holder.append(media);if(!dialog.open)dialog.showModal();
  const prev=by<HTMLButtonElement>('gallery-lightbox-prev'),next=by<HTMLButtonElement>('gallery-lightbox-next');
  if(prev)prev.disabled=lightboxPosition<=0;
  if(next)next.disabled=lightboxPosition<0||lightboxPosition>=visible.length-1;
}
function stepLightbox(delta:number){
  const visible=photos.filter(visibleMedia);
  const photo=visible[lightboxPosition+delta];if(!photo)return;
  const url=mediaCache.get(photo.id);
  if(url)lightbox(photo,url);
  else void getMedia(filePath(photo)).then(r=>r.blob()).then(blob=>{
    const link=URL.createObjectURL(blob);mediaCache.set(photo.id,link);lightbox(photo,link);
  }).catch(()=>msg(tr('사진을 열 수 없습니다.','Impossible d’ouvrir le média.'),true));
}
async function clearCoverReference(photo:Photo){
  const album=albums.find(a=>a.id===photo.albumId);
  if(!album||album.coverItemId!==photo.id)return;
  await updateDoc(doc(db,'galleryAlbums',album.id),{coverItemId:'',updatedAt:serverTimestamp()});
  album.coverItemId='';
}
async function setAlbumCover(photo:Photo){
  if(!selected||(selected.ownerUid!==uid&&!admin())||photo.albumId!==selected.id||photo.mediaType!=='photo'||photo.status!=='published')return;
  try{await updateDoc(doc(db,'galleryAlbums',selected.id),{coverItemId:photo.id,updatedAt:serverTimestamp()});await refresh();}
  catch(error){console.error(error);msg(tr('대표 사진을 지정하지 못했습니다.','Impossible de choisir la couverture.'),true);}
}
async function downloadPhoto(photo:Photo){
  if(!admin())return;
  try{const response=await getMedia(filePath(photo)),blob=await response.blob();
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    const ext=photo.image.mime==='image/webp'?'.webp':photo.image.mime==='image/jpeg'?'.jpg':photo.image.mime==='video/webm'?'.webm':photo.image.mime==='video/mp4'?'.mp4':'';
    const base=(photo.originalName||photo.title||'asicc-gallery').replace(/\.[A-Za-z0-9]{2,8}$/,'').replace(/[^\p{L}\p{N}._-]/gu,'_').slice(0,120);
    link.href=url;link.download=base+ext;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),15000);
  }catch(e){console.error(e);msg(tr('파일 다운로드에 실패했습니다.','Téléchargement impossible.'),true);}
}
async function editPhoto(photo:Photo){const description=prompt(tr('사진 설명','Description'),photo.description||'');if(description===null||description.length>3000)return;
  try{await updateDoc(doc(db,'galleryItems',photo.id),{description,updatedAt:serverTimestamp()});if(selected)await openAlbum(selected);}catch(e){console.error(e);msg(tr('수정할 수 없습니다.','Modification refusée.'),true);}
}
async function changePhotoStatus(photo:Photo,state:Photo['status']){
  if(!admin()||state==='published'&&photo.status==='draft')return;if(!confirm(tr('사진 공개 상태를 변경할까요?','Modifier la visibilité du média ?')))return;
  try{if(state!=='published')await clearCoverReference(photo);await updateDoc(doc(db,'galleryItems',photo.id),{status:state,updatedAt:serverTimestamp()});if(selected)await openAlbum(selected);}catch(e){console.error(e);msg(tr('공개 상태를 변경하지 못했습니다.','Changement d’état refusé.'),true);}
}
async function deletePhoto(photo:Photo){if(!confirm(tr('이 파일을 삭제할까요? 보관 원본에 관한 별도 개인정보 요청은 운영진에게 전달해 주세요.','Supprimer ce fichier ? Pour l’archivage, contactez l’administration.')))return;
  try{await clearCoverReference(photo);await getMedia(filePath(photo),'DELETE');await deleteDoc(doc(db,'galleryItems',photo.id));if(selected)await openAlbum(selected);}catch(e){console.error(e);msg(tr('삭제에 실패했습니다.','Suppression impossible.'),true);}
}
async function movePhoto(photo:Photo){if(!admin())return;
  const dest=by<HTMLSelectElement>('gallery-target-album')?.value||'';
  if(!dest||dest===photo.albumId||!albums.some(a=>a.id===dest)){msg(tr('이동할 다른 앨범을 위의 목록에서 선택해 주세요.','Sélectionnez un autre album dans la liste.'),true);return;}
  try{
    const destination=albums.find(a=>a.id===dest)!;
    if(destination.ownerUid!==photo.authorUid&&!destination.isShared){
      await updateDoc(doc(db,'galleryAlbums',dest),{isShared:true,updatedAt:serverTimestamp()});destination.isShared=true;
    }
    await clearCoverReference(photo);
    await updateDoc(doc(db,'galleryItems',photo.id),{albumId:dest,updatedAt:serverTimestamp()});if(selected)await openAlbum(selected);
  }catch(e){console.error(e);msg(tr('사진을 이동하지 못했습니다.','Déplacement impossible.'),true);}
}
async function changeOrder(photo:Photo,step:number){if(!admin())return;const idx=photos.findIndex(x=>x.id===photo.id),other=photos[idx+step];if(idx<0||!other)return;
  try{const a=photo.sortOrder??idx,b=other.sortOrder??idx+step;
    await updateDoc(doc(db,'galleryItems',photo.id),{sortOrder:b,updatedAt:serverTimestamp()});
    await updateDoc(doc(db,'galleryItems',other.id),{sortOrder:a,updatedAt:serverTimestamp()});
    if(selected)await openAlbum(selected);
  }catch(e){console.error(e);msg(tr('순서를 변경하지 못했습니다.','Impossible de changer l’ordre.'),true);}
}
async function shrink(file:File){
  const image=await createImageBitmap(file);try{
    const scale=Math.min(1,1600/Math.max(image.width,image.height));const canvas=document.createElement('canvas');
    canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
    const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas unavailable');ctx.drawImage(image,0,0,canvas.width,canvas.height);
    let quality=.84,blob:Blob|null=null;
    for(let i=0;i<7;i++){blob=await new Promise(res=>canvas.toBlob(res,'image/webp',quality));if(blob&&blob.size<=1500000)break;quality-=.1;}
    if(!blob||blob.size>1500000)throw Error('Image too large after optimization');return blob;
  }finally{image.close();}
}
async function notifyReview(id:string){
  try{await getMedia(`/api/notify`, 'POST',new Blob([JSON.stringify({kind:'gallery',id})],{type:'application/json'}),'application/json');}
  catch(e){console.warn('Notification delivery not configured',e);}
}
async function upload(){if(!selected||busy||!canPost())return;
  const files=Array.from(by<HTMLInputElement>('gallery-files')?.files||[]);if(!files.length)return;
  if(files.length>40)return msg(tr('한 번에 최대 40개 파일을 선택해 주세요.','Maximum 40 fichiers par envoi.'),true);
  busy=true;const save=by<HTMLButtonElement>('gallery-submit');if(save)save.disabled=true;
  try{
    if(selected.ownerUid!==uid&&!selected.isShared){await updateDoc(doc(db,'galleryAlbums',selected.id),{isShared:true,updatedAt:serverTimestamp()});selected.isShared=true;}
    for(let i=0;i<files.length;i++){
      const file=files[i],isVideo=file.type==='video/mp4'||file.type==='video/webm';
      const review=by<HTMLInputElement>(`gallery-review-${i}`)?.checked===true;
      const description=by<HTMLTextAreaElement>(`gallery-description-${i}`)?.value.trim()||'';
      if(!isVideo&&!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Unsupported file type');
      if(file.size>20000000||file.size===0)throw Error(`${file.name}: maximum 20 MB`);
      const blob=isVideo?file:await shrink(file),mime=isVideo?file.type:'image/webp';
      const record=doc(collection(db,'galleryItems'));
      const image:FileMeta={id:crypto.randomUUID(),mime,size:blob.size};
      await setDoc(record,{albumId:selected.id,title:isVideo?tr('동영상','Vidéo'):tr('사진','Photo'),description,authorUid:uid,
        mediaType:isVideo?'video':'photo',originalName:file.name.slice(0,255),image,status:'draft',
        reviewReason:review?'consent_uncertain':'',sortOrder:Date.now()+i,createdAt:serverTimestamp()});
      msg(tr(`업로드 ${i+1}/${files.length}: ${file.name}`,`Transfert ${i+1}/${files.length}: ${file.name}`));
      await getMedia(`/api/gallery-upload?itemId=${encodeURIComponent(record.id)}`,'POST',blob,mime);
      await updateDoc(record,{status:review?'pending':'published',updatedAt:serverTimestamp()});
      if(review)void notifyReview(record.id);
    }
    by<HTMLFormElement>('media-upload-form')?.reset();clearUploadPreview();by<HTMLElement>('gallery-file-review')?.replaceChildren();
    msg(tr('파일 업로드가 완료되었습니다. 검토 요청한 사진은 운영진 승인 전까지 비공개입니다.','Transfert terminé. Les médias à examiner restent privés.'));
    if(selected)await openAlbum(selected);
  }catch(e){console.error(e);msg(tr('업로드가 일부 실패했습니다. 미완성 항목은 운영진에게 알려주세요.','Envoi partiellement échoué. Signalez les brouillons à l’administration.')+' '+String(e),true);}finally{busy=false;if(save)save.disabled=false;}
}
async function bulkUpdate(action:'move'|'approve'|'hide'){
  if(!admin()||!selected||busy)return;
  const current=photos.filter(x=>selectedPhotoIds.has(x.id));
  if(!current.length)return msg(tr('먼저 사진을 선택해 주세요.','Sélectionnez des photos.'),true);
  const dest=by<HTMLSelectElement>('gallery-target-album')?.value||'';
  if(action==='move'&&(!dest||!albums.some(x=>x.id===dest)))return;
  if(!confirm(tr(`${current.length}개 항목을 일괄 처리할까요?`,`Modifier ${current.length} fichiers ?`)))return;
  busy=true;
  try{
    for(const photo of current){
      if(action==='move'&&photo.albumId!==dest){
        const destination=albums.find(a=>a.id===dest)!;
        if(destination.ownerUid!==photo.authorUid&&!destination.isShared){
          await updateDoc(doc(db,'galleryAlbums',dest),{isShared:true,updatedAt:serverTimestamp()});destination.isShared=true;
        }
        await clearCoverReference(photo);
        await updateDoc(doc(db,'galleryItems',photo.id),{albumId:dest,updatedAt:serverTimestamp()});
      }
      if(action==='approve'&&photo.status!=='published'&&photo.status!=='draft')await updateDoc(doc(db,'galleryItems',photo.id),{status:'published',updatedAt:serverTimestamp()});
      if(action==='hide'&&photo.status!=='hidden'){await clearCoverReference(photo);await updateDoc(doc(db,'galleryItems',photo.id),{status:'hidden',updatedAt:serverTimestamp()});}
    }
    selectedPhotoIds.clear();await openAlbum(selected);msg(tr('일괄 작업을 완료했습니다.','Action groupée terminée.'));
  }catch(e){console.error(e);msg(tr('일부 항목을 수정하지 못했습니다. 목록을 새로고침해 주세요.','Certains fichiers n’ont pas été modifiés.'),true);}
  finally{busy=false;}
}
by<HTMLButtonElement>('gallery-bulk-move')?.addEventListener('click',()=>void bulkUpdate('move'));
by<HTMLButtonElement>('gallery-bulk-approve')?.addEventListener('click',()=>void bulkUpdate('approve'));
by<HTMLButtonElement>('gallery-bulk-hide')?.addEventListener('click',()=>void bulkUpdate('hide'));
by<HTMLButtonElement>('album-new-toggle')?.addEventListener('click',()=>show('album-new-form',true));
by<HTMLButtonElement>('album-new-cancel')?.addEventListener('click',()=>show('album-new-form',false));
by<HTMLFormElement>('album-new-form')?.addEventListener('submit',async e=>{e.preventDefault();if(!canPost()||busy)return;
  const title=by<HTMLInputElement>('album-title')?.value.trim()||'',school=by<HTMLSelectElement>('album-school')?.value as School;
  const year=Number(by<HTMLInputElement>('album-year')?.value);
  if(title.length<2||title.length>120||!['kindergarten','elementary','middle','common'].includes(school)||year<2018||year>2100||!Number.isInteger(year))return msg(tr('앨범 이름과 연도·학교를 확인해 주세요.','Vérifiez le nom, l’école et l’année.'),true);
  try{const record=doc(collection(db,'galleryAlbums'));await setDoc(record,{title,school,year,ownerUid:uid,isShared:false,coverItemId:'',createdAt:serverTimestamp(),updatedAt:serverTimestamp()});
    by<HTMLFormElement>('album-new-form')?.reset();show('album-new-form',false);await refresh();await openAlbum(albums.find(a=>a.id===record.id)!);
  }catch(e){console.error(e);msg(tr('앨범을 만들 수 없습니다.','Impossible de créer l’album.'),true);}
});
by<HTMLFormElement>('media-upload-form')?.addEventListener('submit',e=>{e.preventDefault();void upload();});
const uploadPreviewUrls:string[]=[];
function clearUploadPreview(){for(const url of uploadPreviewUrls)URL.revokeObjectURL(url);uploadPreviewUrls.length=0;}
by<HTMLInputElement>('gallery-files')?.addEventListener('change',()=>{
  const target=by<HTMLElement>('gallery-file-review');if(!target)return;clearUploadPreview();target.replaceChildren();
  const files=Array.from(by<HTMLInputElement>('gallery-files')?.files||[]);
  files.slice(0,40).forEach((file,i)=>{const row=node('div');row.className='gallery-review-line';
    const url=URL.createObjectURL(file);uploadPreviewUrls.push(url);
    const preview=file.type.startsWith('video/')?node('video') as HTMLVideoElement:node('img') as HTMLImageElement;preview.src=url;preview.className='asicc-upload-preview';if(preview instanceof HTMLVideoElement){preview.controls=true;preview.preload='metadata';}else preview.alt=tr(`사진 ${i+1}`,`Photo ${i+1}`);row.append(preview);
    const fields=node('div');fields.className='asicc-gallery-review-fields';
    fields.append(node('strong',`${i+1}. ${file.type.startsWith('video/')?tr('동영상','Vidéo'):tr('사진','Photo')} · ${(file.size/1e6).toFixed(1)} MB`));
    const desc=node('textarea') as HTMLTextAreaElement;desc.id=`gallery-description-${i}`;desc.rows=2;desc.maxLength=3000;desc.placeholder=tr('사진·동영상 설명 (선택)','Description (facultatif)');desc.setAttribute('aria-label',desc.placeholder);fields.append(desc);
    const choice=node('label');const input=node('input') as HTMLInputElement;input.type='checkbox';input.id=`gallery-review-${i}`;choice.append(input,node('span',tr(' 운영진 검토 요청 → 임시 비공개',' Demander un examen → privé')));fields.append(choice);row.append(fields);target.append(row);});
});
window.addEventListener('pagehide',clearUploadPreview);
by<HTMLButtonElement>('gallery-member-preview')?.addEventListener('click',async()=>{
  if(role!=='admin'||busy)return;preview=!preview;selected=null;revoke();clearUploadPreview();by<HTMLFormElement>('media-upload-form')?.reset();by<HTMLElement>('gallery-file-review')?.replaceChildren();
  show('album-detail',false);show('album-list',true);show('album-new-form',false);show('album-new-toggle',!preview);show('gallery-admin-banner',!preview&&!opened);show('gallery-preview-note',preview);
  t('gallery-member-preview',preview?tr('운영진 화면으로 돌아가기','Retour à la gestion'):tr('정회원 화면 미리보기','Aperçu membre'));await refresh();
});
for(const id of ['album-school-filter','album-year-filter','album-search'])by<HTMLElement>(id)?.addEventListener('input',renderAlbums);
by<HTMLButtonElement>('album-back')?.addEventListener('click',()=>{selected=null;show('album-detail',false);show('album-list',true);revoke();renderAlbums();});
by<HTMLButtonElement>('gallery-lightbox-close')?.addEventListener('click',()=>by<HTMLDialogElement>('gallery-lightbox')?.close());
by<HTMLButtonElement>('gallery-lightbox-prev')?.addEventListener('click',()=>stepLightbox(-1));
by<HTMLButtonElement>('gallery-lightbox-next')?.addEventListener('click',()=>stepLightbox(1));
if(import.meta.env.PUBLIC_ASICC_MEMBERS_ENABLED==='true')onAuthStateChanged(auth,async user=>{
  if(!user){location.replace(root?.dataset.loginUrl||'/');return;}
  try{await user.reload();await getIdToken(user,true);if(!user.emailVerified)throw Error('Email unverified');
    const p=await getDoc(doc(db,'members',user.uid));if(!p.exists()||p.data().status!=='approved')throw Error('Inactive membership');
    uid=user.uid;role=String(p.data().role||'general');viewerDM=dmAllowed(p.data());authorCache.set(uid,Promise.resolve({nickname:p.data().nickname||tr('회원','Membre'),role,canReceiveDM:viewerDM}));void syncOwnAlias(db,uid,p.data()).catch(console.warn);
    if(!await loadSettings())return;
    if(!canPost()){locked();return;}await refresh();
  }catch(e){console.error(e);locked();msg(tr('갤러리를 불러오지 못했습니다. 회원 권한을 확인해 주세요.','Galerie indisponible. Vérifiez votre compte.'),true);}
});
