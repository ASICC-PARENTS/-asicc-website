"""Patch only the live Worker's known authorization function. Never deploy configuration."""
import email, email.policy, json, os, subprocess, tempfile, pathlib, urllib.request
from urllib.error import HTTPError

base="https://api.cloudflare.com/client/v4/accounts/b941b206ccc2aad94ae9b83ada2bc889/workers/scripts/asicc-bazaar-api/content"
token=os.environ.get("CLOUDFLARE_API_TOKEN")
if not token: raise SystemExit("Missing existing Worker deployment authorization")
def call(url, method="GET", data=None, headers=None):
    req=urllib.request.Request(url, data=data, method=method, headers={"Authorization":"Bearer "+token,**(headers or {})})
    try:
        with urllib.request.urlopen(req,timeout=60) as r:return r.headers,r.read()
    except HTTPError as e:
        # Do not print configuration, secrets, or live source.
        raise SystemExit(f"Cloudflare authorization/content API returned HTTP {e.code}")
def unpack(headers, body):
    content_type=headers.get("Content-Type","")
    if not content_type.lower().startswith("multipart/"):
        raise SystemExit("Expected module-format Worker content; do not replace unknown format")
    msg=email.message_from_bytes(("Content-Type: "+content_type+"\r\nMIME-Version: 1.0\r\n\r\n").encode()+body,policy=email.policy.default)
    parts=[]
    main=headers.get("CF-WORKER-MAIN-MODULE-PART")
    for part in msg.iter_parts():
        name=part.get_param("name",header="content-disposition") or part.get_filename()
        content=part.get_payload(decode=True)
        if name=="metadata":
            meta=json.loads(content); main=main or meta.get("main_module");continue
        if not name or not content:raise SystemExit("Unknown module part; no update")
        parts.append((name,part.get_content_type(),content))
    if not main:
        js=[n for n,t,b in parts if t in ("application/javascript+module","text/javascript+module","application/javascript","text/javascript") and b"function requireAdmin" in b]
        if len(js)==1:main=js[0]
    if not main or sum(n==main for n,t,b in parts)!=1:raise SystemExit("Main module cannot be identified safely")
    return main,parts
def public_check():
    req=urllib.request.Request("https://asicc-bazaar-api.falling-hall-f390.workers.dev/api/bazaarPublic",data=b'{"data":{}}',headers={"Content-Type":"application/json","Origin":"https://asicc-parents.fr"})
    with urllib.request.urlopen(req,timeout=30) as r:
        data=json.load(r)["data"]
        if not data["event"]["eventId"] or not isinstance(data["products"],list):raise SystemExit("Public bazaar is not healthy")
        return len(data["products"])
print("Public bazaar product count before:",public_check())
headers,body=call(base+"/v2")
main,parts=unpack(headers,body)
with tempfile.TemporaryDirectory() as directory:
    f=pathlib.Path(directory)/"live.mjs"
    old=next(b for n,t,b in parts if n==main);f.write_bytes(old)
    subprocess.run(["node","scripts/patch-bazaar-admin-role.mjs",str(f),"scripts/bazaar-auth-before.mjs","scripts/bazaar-auth-after.mjs"],check=True)
    subprocess.run(["node","--check",str(f)],check=True)
    patched=f.read_bytes()
    if old==patched:raise SystemExit("No change")
    # Fail closed if another deploy occurred during the validation.
    current_headers,current=call(base+"/v2")
    _,current_parts=unpack(current_headers,current)
    if sorted(current_parts)!=sorted(parts):raise SystemExit("Live Worker changed during inspection")
    boundary="asicc-role-"+os.urandom(16).hex()
    def field(name,ctype,content,filename=None):
        if any(c in name for c in ('"','\r','\n')):raise SystemExit("Unsafe module name")
        disposition=f'Content-Disposition: form-data; name="{name}"'+(f'; filename="{filename}"' if filename else '')
        return (f"--{boundary}\r\n{disposition}\r\nContent-Type: {ctype}\r\n\r\n").encode()+content+b"\r\n"
    payload=field("metadata","application/json",json.dumps({"main_module":main}).encode())
    for n,t,b in parts:payload+=field(n,t,patched if n==main else b,n)
    payload+=(f"--{boundary}--\r\n").encode()
    _,result=call(base,"PUT",payload,{"Content-Type":"multipart/form-data; boundary="+boundary,"CF-WORKER-MAIN-MODULE-PART":main})
    if not json.loads(result).get("success"):raise SystemExit("Content update did not succeed")
    h,after=call(base+"/v2")
    new_main,new_parts=unpack(h,after)
    expected=[(n,t,patched if n==main else b) for n,t,b in parts]
    if new_main!=main or sorted((n,b) for n,t,b in new_parts)!=sorted((n,b) for n,t,b in expected):raise SystemExit("Post-deploy content comparison failed")
    print("Live authorization updated; all other Worker module bytes match.")
print("Public bazaar product count after:",public_check())
