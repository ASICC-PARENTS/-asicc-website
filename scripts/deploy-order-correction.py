"""Content-only live Worker update. Never redeploy wrangler configuration, secrets, or triggers."""
import email, email.policy, hashlib, json, os, pathlib, subprocess, tempfile, urllib.request
from urllib.error import HTTPError

base="https://api.cloudflare.com/client/v4/accounts/b941b206ccc2aad94ae9b83ada2bc889/workers/scripts/asicc-bazaar-api/content"
token=os.environ.get("CLOUDFLARE_API_TOKEN")
if not token: raise SystemExit("Missing existing Worker deployment authorization")
def call(url, method="GET", data=None, headers=None):
    req=urllib.request.Request(url,data=data,method=method,headers={"Authorization":"Bearer "+token,**(headers or {})})
    try:
        with urllib.request.urlopen(req,timeout=60) as r:return r.headers,r.read()
    except HTTPError as e:
        raise RuntimeError(f"Cloudflare content API HTTP {e.code}") from None

def unpack(headers,body):
    ct=headers.get("Content-Type","")
    if not ct.lower().startswith("multipart/"):raise RuntimeError("Unknown Worker module format; no update")
    msg=email.message_from_bytes(("Content-Type: "+ct+"\r\nMIME-Version: 1.0\r\n\r\n").encode()+body,policy=email.policy.default)
    main=headers.get("CF-WORKER-MAIN-MODULE-PART")
    parts=[]
    for part in msg.iter_parts():
        n=part.get_param("name",header="content-disposition") or part.get_filename()
        b=part.get_payload(decode=True)
        if n=="metadata":
            main=main or json.loads(b).get("main_module");continue
        if not isinstance(n,str) or not isinstance(b,bytes) or not b:raise RuntimeError("Unknown module part")
        parts.append((n,part.get_content_type(),b))
    if not main or sum(n==main for n,t,b in parts)!=1:
        candidates=[n for n,t,b in parts if b"function createBazaar(" in b and b"correctOrder" in b and b"transferReportedAt" in b]
        if len(candidates)==1:main=candidates[0]
        elif len(parts)==1:main=parts[0][0]  # exact parsed transaction check follows before any write
    if not main or sum(n==main for n,t,b in parts)!=1 or len({n for n,t,b in parts})!=len(parts):
        print("Worker module metadata:",repr(main),[(n,t,len(b)) for n,t,b in parts],flush=True)
        raise RuntimeError("Could not uniquely identify deployed main module")
    return main,parts

def get_content():
    return unpack(*call(base+"/v2"))
def identity(content):
    main,parts=content
    return main,sorted((n,b) for n,t,b in parts)
def upload(content):
    main,parts=content
    boundary="asicc-mail-"+os.urandom(16).hex()
    def field(n,t,b,filename=None):
        if any(c in n for c in ('"','\r','\n')):raise RuntimeError("Unsafe module name")
        disp=f'Content-Disposition: form-data; name="{n}"'+(f'; filename="{filename}"' if filename else '')
        return (f"--{boundary}\r\n{disp}\r\nContent-Type: {t}\r\n\r\n").encode()+b+b"\r\n"
    payload=field("metadata","application/json",json.dumps({"main_module":main}).encode())
    for n,t,b in parts:payload+=field(n,t,b,n)
    payload+=(f"--{boundary}--\r\n").encode()
    _,result=call(base,"PUT",payload,{"Content-Type":"multipart/form-data; boundary="+boundary,"CF-WORKER-MAIN-MODULE-PART":main})
    if not json.loads(result).get("success"):raise RuntimeError("Content update failed")

def health_check():
    url="https://asicc-bazaar-api.falling-hall-f390.workers.dev"
    def api(path):
        return subprocess.check_output(["curl","--fail-with-body","--silent","--show-error","--max-time","30","-H","Content-Type: application/json","-H","Origin: https://asicc-parents.fr","--data",'{"data":{}}',url+path],stderr=subprocess.DEVNULL)
    data=json.loads(api("/api/bazaarPublic"))["data"]
    eid=data["event"]["eventId"];products=data["products"]
    if not isinstance(eid,str) or not eid or not isinstance(products,list) or not products:raise RuntimeError("Public order catalogue is unhealthy")
    status=subprocess.check_output(["curl","--silent","--show-error","--max-time","30","-o","/dev/null","-w","%{http_code}","-H","Content-Type: application/json","-H","Origin: https://asicc-parents.fr","--data",'{"data":{"op":"listEvents"}}',url+"/api/bazaarAdmin"],stderr=subprocess.DEVNULL).decode()
    if status!="401":raise RuntimeError("Unauthenticated admin boundary failed: "+status)
    return eid,len(products)

before_health=health_check()
print("Public order catalogue and administrator boundary before:",before_health,flush=True)
original=get_content()
main,parts=original
with tempfile.TemporaryDirectory() as directory:
    f=pathlib.Path(directory)/"live.mjs";old=next(b for n,t,b in parts if n==main);f.write_bytes(old)
    subprocess.run(["node","scripts/patch-order-correction.mjs",str(f),os.environ["BASELINE_BUNDLE"],os.environ["RELEASE_BUNDLE"]],check=True)
    subprocess.run(["node","--check",str(f)],check=True)
    patched=f.read_bytes()
    if old==patched:raise RuntimeError("No changes")
    expected=main,[(n,t,patched if n==main else b) for n,t,b in parts]
    print("Prior content SHA-256:",hashlib.sha256(old).hexdigest(),flush=True)
    print("Candidate content SHA-256:",hashlib.sha256(patched).hexdigest(),flush=True)
    if identity(get_content())!=identity(original):raise RuntimeError("Live code changed during validation; stopped without deploy")
    # Check once again immediately pre-publish; never apply stale code.
    if health_check()[0]!=before_health[0]:raise RuntimeError("Active event changed during validation; stopped without deploy")
    try:
        upload(expected)
        if identity(get_content())!=identity(expected):raise RuntimeError("Post-deploy byte verification failed")
        after_health=health_check()
        if after_health[0]!=before_health[0]:raise RuntimeError("Public event changed")
        print("Public order catalogue and administrator boundary after:",after_health,flush=True)
        print("SUCCESS: Order correction guard updated; verified all module bytes. Configuration, secrets, and triggers not submitted.",flush=True)
    except Exception as e:
        print("Post-upload validation failed:",type(e).__name__,flush=True)
        current=get_content()
        if identity(current)==identity(expected):
            upload(original)
            if identity(get_content())!=identity(original):raise RuntimeError("URGENT: rollback content verification failed")
            health_check()
            print("Rolled back exact earlier Worker content; public health restored.",flush=True)
        elif identity(current)==identity(original):
            print("Original Worker content still active.",flush=True)
        else:
            raise RuntimeError("Live content differs from both known versions; refusing to overwrite a concurrent deployment") from None
        raise
