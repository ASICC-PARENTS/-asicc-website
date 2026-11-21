/** ASICC private B2 media API (Cloudflare Worker, no npm dependencies).
 * Browser -> Worker (Firebase bearer token) -> Backblaze B2 private bucket.
 * Never expose B2 application keys to browsers, Firestore or GitHub.
 * POST /api/upload : image/webp or image/jpeg <= 1.5MB, member/special/admin.
 * GET  /api/photo?key=board/YYYYMMDD/UID/UUID.webp : verified active members only.
 * Resource posts: POST /api/resource-upload, GET/DELETE /api/resource.
 * Gallery: POST /api/gallery-upload, GET/DELETE /api/gallery.
 * Resources: ALL attachments per Firestore post must total <=20,000,000 bytes.
 */
const MAX_IMAGE = 1_500_000;
const MAX_GALLERY_VIDEO = 20_000_000;
const MAX_RESOURCE_POST = 20_000_000;
const MAX_RESOURCE_FILES = 8;
const SAFE_ID = /^[A-Za-z0-9_-]{12,128}$/;
const DOC_TYPES = new Set([
  'application/pdf','image/jpeg','image/png','image/webp','text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]);
const KEY_PATTERN = /^board\/\d{8}\/[A-Za-z0-9_-]{1,128}\/[0-9a-f-]{36}\.(?:webp|jpg)$/;
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwksCache = null;
let jwksExpires = 0;
const encoder = new TextEncoder();
function json(obj,status=200,headers={}){
  return new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
}
function corsHeaders(req,env){
  const origin=req.headers.get('Origin')||'';
  const allowed=String(env.ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  return allowed.includes(origin)?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS','Access-Control-Max-Age':'3600','Vary':'Origin'}:null;
}
function b64urlToBytes(s){
  const raw=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function decodeJwtPart(s){return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));}
async function getJwks(kid){
  if(Date.now()<jwksExpires && jwksCache?.keys?.some(k=>k.kid===kid))return jwksCache;
  const response=await fetch(JWKS_URL,{cf:{cacheTtl:3600}});
  if(!response.ok)throw new Error('JWKS unavailable');
  const result=await response.json();
  if(!Array.isArray(result.keys))throw new Error('Bad JWKS');
  jwksCache=result;
  jwksExpires=Date.now()+Math.min(3_600_000,Number(response.headers.get('Cache-Control')?.match(/max-age=(\d+)/)?.[1]||3600)*1000);
  return result;
}
async function verifyIdToken(token,projectId){
  const parts=token.split('.');if(parts.length!==3||token.length>9000)throw new Error('Bad bearer token');
  const header=decodeJwtPart(parts[0]), claims=decodeJwtPart(parts[1]);
  if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>180)throw new Error('Bad JWT header');
  const now=Math.floor(Date.now()/1000);
  if(claims.aud!==projectId||claims.iss!==`https://securetoken.google.com/${projectId}` ||
    typeof claims.sub!=='string'||!(/^[A-Za-z0-9_-]{1,128}$/).test(claims.sub)||
    typeof claims.exp!=='number'||claims.exp<=now||
    typeof claims.iat!=='number'||claims.iat>now+60||
    typeof claims.auth_time!=='number'||claims.auth_time>now+60||
    claims.email_verified!==true)throw new Error('Invalid JWT claims');
  const jwks=await getJwks(header.kid);const jwk=jwks.keys.find(k=>k.kid===header.kid&&k.kty==='RSA');
  if(!jwk)throw new Error('Unknown JWT key');
  const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  const ok=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,b64urlToBytes(parts[2]),encoder.encode(parts[0]+'.'+parts[1]));
  if(!ok)throw new Error('Invalid JWT signature');
  return claims;
}
async function verifiedMember(req,env){
  const bearer=req.headers.get('Authorization')||'';
  if(!bearer.startsWith('Bearer '))throw new Error('Missing auth');
  const token=bearer.slice(7);
  const claims=await verifyIdToken(token,String(env.FIREBASE_PROJECT_ID||''));
  // The user-supplied Firebase token is checked against Firestore rules.
  // Reading one's own members/{uid} document is permitted by the ASICC rules.
  const url=`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/members/${encodeURIComponent(claims.sub)}`;
  const res=await fetch(url,{headers:{Authorization:`Bearer ${token}`,'Cache-Control':'no-store'}});
  if(!res.ok)throw new Error('Profile unavailable');
  const profile=await res.json();
  const status=profile?.fields?.status?.stringValue;
  const role=profile?.fields?.role?.stringValue;
  if(status!=='approved'||!['general','member','special','admin'].includes(role))throw new Error('Inactive profile');
  return {uid:claims.sub,role};
}
// Firestore REST reads are authorized by the caller's signed Firebase ID token.
async function firestoreRecord(req,env,collection,id){
  const token=(req.headers.get('Authorization')||'').slice(7);
  const url=`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/${collection}/${encodeURIComponent(id)}`;
  const res=await fetch(url,{headers:{Authorization:`Bearer ${token}`,'Cache-Control':'no-store'}});
  if(!res.ok)throw new Error('Record unavailable');
  const data=await res.json();
  function val(v){
    if(!v)return null;
    if('stringValue' in v)return v.stringValue;
    if('integerValue' in v)return Number(v.integerValue);
    if('doubleValue' in v)return Number(v.doubleValue);
    if('booleanValue' in v)return v.booleanValue;
    if('arrayValue' in v)return (v.arrayValue.values||[]).map(val);
    if('mapValue' in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,val(x)]));
    return null;
  }
  return Object.fromEntries(Object.entries(data.fields||{}).map(([k,v])=>[k,val(v)]));
}
function resourceManifest(record){
  if(!record||!Array.isArray(record.files)||record.files.length>MAX_RESOURCE_FILES)return null;
  // An author may keep a published resource post with no attachments.
  if(!['draft','published'].includes(record.status))return null;
  let sum=0;const ids=new Set();
  for(const f of record.files){
    if(!f||!SAFE_ID.test(f.id||'')||ids.has(f.id)||typeof f.name!=='string'||!f.name||f.name.length>255||
      !DOC_TYPES.has(f.mime)||!Number.isSafeInteger(f.size)||f.size<1||f.size>MAX_RESOURCE_POST)return null;
    ids.add(f.id);sum+=f.size;
  }
  if(sum>MAX_RESOURCE_POST||sum!==record.bytesTotal)return null;
  return record.files;
}
function validDocumentBytes(bytes,mime){
  if(bytes.length<1)return false;
  if(mime==='application/pdf')return bytes.length>=5&&String.fromCharCode(...bytes.slice(0,5))==='%PDF-';
  if(mime==='image/jpeg'||mime==='image/webp')return isValidImage(bytes,mime);
  if(mime==='image/png')return bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  if(mime==='text/plain')return !bytes.includes(0);
  // DOCX / XLSX / PPTX are ZIP OpenXML documents. The browser chooses the subtype.
  return bytes.length>=4&&bytes[0]===80&&bytes[1]===75&&bytes[2]===3&&bytes[3]===4;
}
function validGalleryRecord(record){
  return record&&['draft','published','pending','hidden','rejected'].includes(record.status)&&record.image&&SAFE_ID.test(record.image.id||'')&&
    ['image/webp','image/jpeg','video/mp4','video/webm'].includes(record.image.mime)&&
    Number.isSafeInteger(record.image.size)&&record.image.size>0&&
    (['video/mp4','video/webm'].includes(record.image.mime)?record.image.size<=MAX_GALLERY_VIDEO:record.image.size<=MAX_IMAGE);
}
async function galleryIsOpen(request,env){
  try{const data=await firestoreRecord(request,env,'siteSettings','gallery');return data.isOpen===true;}
  catch{return false;}
}
async function handleFiles(request,env,headers,url,user){
  const resource=url.pathname.includes('resource');
  const collection=resource?'learningResources':'galleryItems';
  const id=url.searchParams.get(resource?'postId':'itemId')||'';
  const fileId=url.searchParams.get('fileId')||'';
  // Omitting fileId on DELETE removes the full resource; specified IDs delete one file.
  const deleteAll=resource&&request.method==='DELETE'&&!fileId;
  if(!SAFE_ID.test(id)||(resource&&!deleteAll&&!SAFE_ID.test(fileId)))return json({error:'Invalid record identifier'},400,headers);
  if(!resource&&user.role!=='admin'){
    if(!['member','special'].includes(user.role)||!await galleryIsOpen(request,env))return json({error:'Gallery is currently closed'},403,headers);
  }
  let record;
  try{record=await firestoreRecord(request,env,collection,id);}catch{return json({error:'Record not accessible'},403,headers);}
  const files=resource?resourceManifest(record):null;
  if(resource&&!files||!resource&&!validGalleryRecord(record))return json({error:'Invalid file manifest'},409,headers);
  const meta=resource?files.find(f=>f.id===fileId):record.image;
  if(!meta&&request.method==='GET')return json({error:'Attachment not found'},404,headers);
  const isOwner=record.authorUid===user.uid;
  const writer=isOwner&&['member','special','admin'].includes(user.role);
  const remover=user.role==='admin'||writer;
  const reader=resource?true:['member','special','admin'].includes(user.role);
  const isVideo=!resource&&['video/mp4','video/webm'].includes(meta?.mime);
  const key=resource?`learning/${id}/${fileId}`:`gallery/${id}/${meta.id}`;
  if(request.method==='POST'){
    if(!writer)return json({error:'Only the author may upload'},403,headers);
    const mime=(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
    const declared=Number(request.headers.get('Content-Length')||'0');
    const editing=resource&&record.status==='published';
    if(editing){
      // Upload a fresh ID first. The published manifest is updated only after success.
      // Existing attachments are never overwritten by an edit request.
      if(meta)return json({error:'Attachment already exists'},409,headers);
      if(!DOC_TYPES.has(mime)||declared>MAX_RESOURCE_POST)return json({error:'File type or size not allowed'},413,headers);
    }else{
      if(record.status!=='draft'||!meta)return json({error:'Draft attachment required'},403,headers);
      if(mime!==meta.mime||declared>meta.size)return json({error:'File does not match the manifest'},413,headers);
    }
    const bytes=new Uint8Array(await request.arrayBuffer());
    if(bytes.length===0||bytes.length>(resource?MAX_RESOURCE_POST:MAX_GALLERY_VIDEO)||(!editing&&bytes.length!==meta.size)||
       !(isVideo?validVideoBytes(bytes,mime):validDocumentBytes(bytes,mime)))
      return json({error:'Invalid file size or format'},415,headers);
    try{const upstream=await b2Request(env,'PUT',key,bytes,mime);
      return upstream.ok?json({ok:true},201,headers):json({error:'Storage upload failed'},502,headers);
    }catch{return json({error:'Storage unavailable'},502,headers);}
  }
  if(request.method==='GET'){
    if(!reader||(!resource&&record.status!=='published'&&!isOwner&&user.role!=='admin')||
      (resource&&record.status!=='published'&&!isOwner))return json({error:'Not available'},403,headers);
    try{const upstream=await b2Request(env,'GET',key);
      if(upstream.status===404)return json({error:'File missing'},404,headers);
      if(!upstream.ok)return json({error:'Storage read failed'},502,headers);
      return new Response(upstream.body,{status:200,headers:{...headers,'Content-Type':meta.mime,
        'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; sandbox"}});
    }catch{return json({error:'Storage read error'},502,headers);}
  }
  if(request.method==='DELETE'){
    if(!remover)return json({error:'Delete access required'},403,headers);
    try{
      // With a fileId remove only that attachment; without it remove the whole post.
      const targets=resource?(deleteAll?files.map(f=>f.id):[fileId]):[meta.id];
      for(const target of targets){const res=await b2Request(env,'DELETE',`${resource?'learning':'gallery'}/${id}/${target}`);
        if(!res.ok&&res.status!==404)return json({error:'Storage delete failed'},502,headers);
      }
      return json({ok:true},200,headers);
    }catch{return json({error:'Storage delete unavailable'},502,headers);}
  }
  return json({error:'Method not allowed'},405,headers);
}
function validVideoBytes(bytes,mime){
  if(mime==='video/mp4')return bytes.length>=12&&String.fromCharCode(...bytes.slice(4,8))==='ftyp';
  if(mime==='video/webm')return bytes.length>=4&&[26,69,223,163].every((x,i)=>bytes[i]===x);
  return false;
}
function isValidImage(bytes,mime){
  if(mime==='image/webp')return bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if(mime==='image/jpeg')return bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  return false;
}
function hex(buffer){return Array.from(new Uint8Array(buffer)).map(v=>v.toString(16).padStart(2,'0')).join('');}
async function sha256(data){return hex(await crypto.subtle.digest('SHA-256',typeof data==='string'?encoder.encode(data):data));}
async function hmac(key,data){
  const obj=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC',obj,typeof data==='string'?encoder.encode(data):data));
}
async function signingKey(secret,date,region){
  let k=await hmac(encoder.encode('AWS4'+secret),date);
  k=await hmac(k,region);k=await hmac(k,'s3');k=await hmac(k,'aws4_request');return k;
}
async function b2Request(env,method,key,bytes=null,mime=null){
  const endpoint=String(env.B2_S3_ENDPOINT||'').replace(/\/$/,'');
  const parsed=new URL(endpoint);
  if(parsed.protocol!=='https:'||!/^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(parsed.hostname)||parsed.pathname!=='/')throw Error('Invalid B2 endpoint');
  const region=parsed.hostname.slice(3,-'.backblazeb2.com'.length);
  const bucket=String(env.B2_BUCKET||'');
  if(!/^[A-Za-z0-9-]{6,63}$/.test(bucket))throw Error('Invalid bucket name');
  const path='/'+encodeURIComponent(bucket)+'/'+key.split('/').map(encodeURIComponent).join('/');
  const now=new Date(),amz=now.toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,15)+'Z';
  const short=amz.slice(0,8);const scope=`${short}/${region}/s3/aws4_request`;
  const hash=await sha256(bytes||new Uint8Array());
  const headers={'host':parsed.host,'x-amz-content-sha256':hash,'x-amz-date':amz};
  if(mime)headers['content-type']=mime;
  const names=Object.keys(headers).sort();
  const canonicalHeaders=names.map(k=>k+':'+headers[k].trim()+'\n').join('');
  const requestToSign=[method,path,'',canonicalHeaders,names.join(';'),hash].join('\n');
  const stringToSign=['AWS4-HMAC-SHA256',amz,scope,await sha256(requestToSign)].join('\n');
  const signature=hex(await hmac(await signingKey(env.B2_APPLICATION_KEY,short,region),stringToSign));
  const requestHeaders={...headers,Authorization:`AWS4-HMAC-SHA256 Credential=${env.B2_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`};
  delete requestHeaders.host;
  return fetch(endpoint+path,{method,headers:requestHeaders,...(bytes?{body:bytes}:{}),redirect:'manual'});
}
/** Firestore-authenticated notification. Requires Resend secret and a KV binding:
 * RESEND_API_KEY, ASICC_NOTIFY_TO, NOTIFICATION_KV, ASICC_MAIL_FROM.
 * Caller can only notify about their OWN recently-created request. */
async function handleNotify(request,env,headers,user){
  if(!env.RESEND_API_KEY||!env.NOTIFICATION_KV||!env.ASICC_NOTIFY_TO||!env.ASICC_MAIL_FROM)
    return json({error:'Notification service is not configured'},503,headers);
  let input;try{input=await request.json();}catch{return json({error:'Invalid JSON'},400,headers);}
  const kind=String(input?.kind||''),id=String(input?.id||'');
  const types={upgrade:'upgradeRequests',suggestion:'suggestions',gallery:'galleryItems',withdrawal:'memberWithdrawalRequests',name:'nameChangeRequests'};
  if(!Object.hasOwn(types,kind)||!SAFE_ID.test(id))return json({error:'Invalid request'},400,headers);
  let data,profile;try{
    data=await firestoreRecord(request,env,types[kind],id);
    profile=await firestoreRecord(request,env,'members',user.uid);
  }catch{return json({error:'Request not readable'},403,headers);}
  const owner=data.uid||data.authorUid||id;
  if(owner!==user.uid)return json({error:'Not your request'},403,headers);
  if(kind==='gallery'&&data.status!=='pending')return json({error:'Not awaiting review'},409,headers);
  if(kind==='upgrade'&&data.status!=='pending')return json({error:'Not awaiting review'},409,headers);
  // Requests without a createdAt are invalid. Time protection avoids abuse
  // through repeatedly notifying about old records.
  const cacheKey=`asicc-notice/${kind}/${id}/${data.createdAt||data.requestedAt||'1'}`;
  if(await env.NOTIFICATION_KV.get(cacheKey))return json({ok:true,duplicate:true},200,headers);
  const labels={upgrade:'회원 승급 신청',suggestion:'운영진 건의·문의',gallery:'갤러리 사진 검토 요청',withdrawal:'회원 탈퇴 신청',name:'실명 변경 신청'};
  const subject=`[ASICC] ${labels[kind]} 접수`;
  const safe=(v,max=200)=>String(v??'').replace(/[\r\n\u0000-\u001f]/g,' ').slice(0,max);
  const lines=[`요청 유형: ${labels[kind]}`,`신청자 실명: ${safe(profile.name)}`,`가입 이메일: ${safe(profile.email)}`,`회원 등급: ${safe(profile.role)}`,`접수 일시: ${new Date().toISOString()}`,
    `요청 ID: ${safe(id)}`,`신청 분류: ${safe(data.kind||data.category||data.requestedRole||data.reviewReason||'')}`,
    '', '세부 내용과 학생 정보는 ASICC 운영진 관리 화면에서 확인해 주세요.'];
  const destination=String(env.ASICC_NOTIFY_TO).split(',').map(x=>x.trim()).filter(Boolean);
  if(!destination.length||destination.length>5)return json({error:'Invalid recipients'},503,headers);
  const mail=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:String(env.ASICC_MAIL_FROM),to:destination,subject,text:lines.join('\n')})});
  if(!mail.ok)return json({error:'Email delivery failed'},502,headers);
  await env.NOTIFICATION_KV.put(cacheKey,'1',{expirationTtl:60*60*24*14});
  return json({ok:true},200,headers);
}
export default {
  async fetch(request,env){
    const headers=corsHeaders(request,env);
    if(!headers)return json({error:'Origin not allowed'},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    const url=new URL(request.url);
    const fileRoutes=['/api/resource-upload','/api/resource','/api/gallery-upload','/api/gallery'];
    if(!['/api/upload','/api/photo','/api/notify',...fileRoutes].includes(url.pathname))return json({error:'Not found'},404,headers);
    if(!['GET','POST','DELETE'].includes(request.method))return json({error:'Method not allowed'},405,headers);
    if(request.method==='DELETE'&&!['/api/resource','/api/gallery'].includes(url.pathname))return json({error:'Method not allowed'},405,headers);
    if(request.method==='GET'&&!['/api/photo','/api/resource','/api/gallery'].includes(url.pathname))return json({error:'Method not allowed'},405,headers);
    if(request.method==='POST'&&!['/api/upload','/api/notify','/api/resource-upload','/api/gallery-upload'].includes(url.pathname))return json({error:'Method not allowed'},405,headers);
    let user;
    try{user=await verifiedMember(request,env);}
    catch(e){return json({error:'Membership verification failed'},401,headers);}
    if(url.pathname==='/api/notify')return handleNotify(request,env,headers,user);
    if(fileRoutes.includes(url.pathname))return handleFiles(request,env,headers,url,user);
    if(request.method==='POST'){
      if(!['member','special','admin'].includes(user.role))return json({error:'Write access required'},403,headers);
      const mime=(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
      const size=Number(request.headers.get('Content-Length')||'0');
      if(!['image/webp','image/jpeg'].includes(mime)||size>MAX_IMAGE)return json({error:'Only WebP/JPEG <= 1.5MB allowed'},413,headers);
      const body=new Uint8Array(await request.arrayBuffer());
      if(body.length===0||body.length>MAX_IMAGE||!isValidImage(body,mime))return json({error:'Invalid photo bytes'},415,headers);
      const date=new Date().toISOString().slice(0,10).replace(/-/g,'');
      const key=`board/${date}/${user.uid}/${crypto.randomUUID()}.${mime==='image/webp'?'webp':'jpg'}`;
      try{
        const r=await b2Request(env,'PUT',key,body,mime);
        if(!r.ok){
          // Only disclose the upstream HTTP status and a safe S3 error code.
          // Never return B2 XML, request headers, credentials, object keys or token data.
          const upstreamBody=await r.text().catch(()=>'');
          const match=upstreamBody.match(/<Code>\s*([^<]{1,100})\s*<\/Code>/i);
          const rawCode=match?.[1]?.trim()||'Unknown';
          const safeCode=/^[A-Za-z][A-Za-z0-9_-]{0,64}$/.test(rawCode)?rawCode:'Unknown';
          console.error('ASICC B2 upload rejected',JSON.stringify({status:r.status,code:safeCode}));
          return json({error:`B2 rejected upload (HTTP ${r.status}, ${safeCode})`},502,headers);
        }
        return json({key},201,headers);
      }catch(e){
        // Log a safe error class only. Never log secrets or the full request.
        const errorType=e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name)?e.name:'Unknown';
        console.error('ASICC B2 upload connection error',errorType);
        return json({error:`B2 connection error (${errorType})`},502,headers);
      }
    }
    const key=url.searchParams.get('key')||'';
    if(!KEY_PATTERN.test(key))return json({error:'Invalid photo key'},400,headers);
    try{
      const upstream=await b2Request(env,'GET',key);
      if(upstream.status===404)return json({error:'Photo not found'},404,headers);
      if(!upstream.ok)return json({error:'Photo storage error'},502,headers);
      const mime=key.endsWith('.webp')?'image/webp':'image/jpeg';
      return new Response(upstream.body,{status:200,headers:{...headers,'Content-Type':mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
    }catch{return json({error:'Photo retrieval unavailable'},502,headers);}
  }
};
