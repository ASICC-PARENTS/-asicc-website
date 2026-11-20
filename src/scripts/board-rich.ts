/** ASICC board rich text, sanitized into a strict allowlist before rendering/saving.\n * New posts retain the existing Firestore field `body` (<=5000 characters).\n */
export const RICH_PREFIX = 'asicc-rich-v1:';
export const PHOTO_KEY_RE = /^board\/\d{8}\/[A-Za-z0-9_-]{1,128}\/[0-9a-f-]{36}\.(?:webp|jpg)$/;
const allowed = new Set(['P','DIV','BR','STRONG','B','EM','I','U','UL','OL','LI','BLOCKQUOTE','H2','H3','A','SPAN','FONT','IMG']);
function filterNode(node:Node):Node|null {
  if (node.nodeType===Node.TEXT_NODE) return document.createTextNode(node.textContent||'');
  if (node.nodeType!==Node.ELEMENT_NODE) return null;
  const orig=node as HTMLElement;const tag=orig.tagName.toUpperCase();
  if (!allowed.has(tag)) { // Preserve safe text without preserving scripts/unsafe markup.
    if(['SCRIPT','STYLE','IFRAME','OBJECT','SVG','FORM','VIDEO','AUDIO'].includes(tag)) return null;
    const span=document.createDocumentFragment();
    for(const child of Array.from(orig.childNodes)){const clean=filterNode(child);if(clean)span.appendChild(clean);}
    return span;
  }
  const name=tag==='DIV'?'p':tag==='B'?'strong':tag==='I'?'em':tag==='FONT'?'span':tag.toLowerCase();
  if(name==='img'){
    const key=orig.getAttribute('data-b2-key')||'';
    if(!PHOTO_KEY_RE.test(key))return null;
    const img=document.createElement('img');img.dataset.b2Key=key;
    img.alt=(orig.getAttribute('alt')||'사진').slice(0,100);
    // Preserve ONLY constrained size and alignment metadata, not arbitrary HTML styles.
    const rawWidth=orig.getAttribute('data-photo-width')||'';
    const width=Number(rawWidth);
    if(rawWidth && Number.isInteger(width) && width>=25 && width<=100 && width%5===0){
      img.dataset.photoWidth=String(width);
      img.style.width=`${width}%`;
    }
    const align=orig.getAttribute('data-photo-align')||'';
    if(['left','center','right'].includes(align))img.dataset.photoAlign=align;
    img.loading='lazy';return img;
  }
  const dest=document.createElement(name);
  if(name==='br')return dest;
  if(name==='a'){
    try {const url=new URL(orig.getAttribute('href')||'',window.location.origin);
      if(url.protocol==='https:'||url.protocol==='http:'){
        dest.setAttribute('href',url.href);dest.setAttribute('rel','noopener noreferrer nofollow');dest.setAttribute('target','_blank');
      }
    }catch{/* invalid link */}
  }
  if(name==='span'){
    const color=tag==='FONT'?orig.getAttribute('color')||'':orig.style.color;
    if(/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color.trim())) (dest as HTMLElement).style.color=color.trim();
  }
  if(['p','h2','h3'].includes(name)){
    const align=orig.style.textAlign;if(align==='center'||align==='right')(dest as HTMLElement).style.textAlign=align;
  }
  for(const child of Array.from(orig.childNodes)){const clean=filterNode(child);if(clean)dest.appendChild(clean);}
  return dest;
}
function safeFragment(from:ParentNode):DocumentFragment{
  const fragment=document.createDocumentFragment();
  for(const child of Array.from(from.childNodes)){const clean=filterNode(child);if(clean)fragment.appendChild(clean);}
  return fragment;
}
function decode(body:string):DocumentFragment{
  if(!body.startsWith(RICH_PREFIX)){
    const fragment=document.createDocumentFragment();const p=document.createElement('p');
    p.style.whiteSpace='pre-wrap';p.textContent=body;fragment.append(p);return fragment;
  }
  const doc=new DOMParser().parseFromString(body.slice(RICH_PREFIX.length),'text/html');
  return safeFragment(doc.body);
}
export function renderBoardBody(node:HTMLElement, body:string){node.replaceChildren(decode(body));}
export function setEditorBody(node:HTMLElement, body:string){node.replaceChildren(decode(body));}
export function boardText(body:string):string{
  if(!body.startsWith(RICH_PREFIX))return body;
  const div=document.createElement('div');div.append(decode(body));return div.textContent||'';
}
export function serializeEditor(node:HTMLElement):string{
  const copy=document.createElement('div');copy.append(safeFragment(node));
  return RICH_PREFIX+copy.innerHTML;
}
export function photoKeys(node:HTMLElement):string[]{
  return Array.from(new Set(Array.from(node.querySelectorAll<HTMLImageElement>('img[data-b2-key]'))
    .map(img=>img.dataset.b2Key||'').filter(key=>PHOTO_KEY_RE.test(key))));
}
/** Insert the image just after the paragraph containing the original caret. */
export function insertPhoto(editor:HTMLElement,key:string,blobUrl:string, caret:Range|null=null){
  if(!PHOTO_KEY_RE.test(key))throw new Error('Invalid photo key');
  const img=document.createElement('img');img.dataset.b2Key=key;img.alt='첨부 사진';img.src=blobUrl;img.loading='lazy';
  const p=document.createElement('p');p.append(img);
  const after=document.createElement('p');after.append(document.createElement('br'));
  const node=caret?.startContainer;
  let anchor:HTMLElement|null=node?(node.nodeType===Node.ELEMENT_NODE?node as HTMLElement:node.parentElement):null;
  while(anchor&&anchor!==editor&&!['P','DIV','H2','H3','LI'].includes(anchor.tagName))anchor=anchor.parentElement;
  if(anchor&&anchor!==editor&&editor.contains(anchor))anchor.after(p,after);
  else editor.append(p,after);
  editor.focus();
  const selection=window.getSelection();const range=document.createRange();range.selectNodeContents(after);range.collapse(true);
  selection?.removeAllRanges();selection?.addRange(range);
}
