#!/usr/bin/env python3
import os
import html
import shutil
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 4545
HOST = "0.0.0.0"

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

INDEX_HTML = r"""<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>폴더 업로드</title>
<style>
*{box-sizing:border-box}
body{
  margin:0;min-height:100vh;display:grid;place-items:center;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  background:#0d1117;color:#e6edf3
}
.wrap{width:min(720px,92vw)}
.card{
  background:#161b22;border:1px solid #30363d;border-radius:18px;
  padding:28px;box-shadow:0 18px 60px #0006
}
h1{margin:0 0 8px;font-size:26px}
.sub{margin:0 0 22px;color:#8b949e}
.drop{
  border:2px dashed #3b82f6;border-radius:15px;padding:34px 20px;
  text-align:center;background:#0d1117;transition:.15s;cursor:pointer
}
.drop.drag{background:#111d31;border-color:#60a5fa}
button,.pick{
  appearance:none;border:0;border-radius:10px;padding:11px 17px;
  font-weight:700;font-size:15px;cursor:pointer
}
.pick{display:inline-block;background:#238636;color:white;margin-top:10px}
button{background:#1f6feb;color:#fff}
button:disabled{opacity:.45;cursor:not-allowed}
input{display:none}
.info{display:flex;justify-content:space-between;gap:15px;margin-top:20px;color:#c9d1d9;font-size:14px}
.bar{
  margin-top:9px;height:16px;background:#21262d;border-radius:999px;
  overflow:hidden;border:1px solid #30363d
}
.fill{height:100%;width:0;background:linear-gradient(90deg,#238636,#2ea043);transition:width .08s}
.current{height:8px;margin-top:9px}
.current .fill{background:#1f6feb}
.actions{display:flex;gap:10px;margin-top:18px}
.log{
  margin-top:16px;padding:12px;border-radius:10px;background:#0d1117;
  border:1px solid #30363d;color:#8b949e;font:13px ui-monospace,monospace;
  max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-all
}
.ok{color:#3fb950}.err{color:#f85149}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>폴더 업로드</h1>
    <p class="sub">폴더 구조를 그대로 서버의 <b>uploads</b> 폴더에 저장합니다.</p>

    <div class="drop" id="drop">
      <div>업로드할 폴더를 선택하세요</div>
      <label class="pick" for="folder">폴더 선택</label>
      <input id="folder" type="file" webkitdirectory directory multiple>
    </div>

    <div class="info">
      <span id="summary">선택된 파일 없음</span>
      <span id="percent">0%</span>
    </div>
    <div class="bar"><div class="fill" id="totalBar"></div></div>

    <div class="info">
      <span id="currentName">대기 중</span>
      <span id="currentPercent">0%</span>
    </div>
    <div class="bar current"><div class="fill" id="currentBar"></div></div>

    <div class="actions">
      <button id="upload" disabled>업로드 시작</button>
      <button id="clear" disabled>선택 취소</button>
    </div>

    <div class="log" id="log">준비됨</div>
  </div>
</div>

<script>
const input = document.getElementById('folder');
const uploadBtn = document.getElementById('upload');
const clearBtn = document.getElementById('clear');
const totalBar = document.getElementById('totalBar');
const currentBar = document.getElementById('currentBar');
const summary = document.getElementById('summary');
const percent = document.getElementById('percent');
const currentPercent = document.getElementById('currentPercent');
const currentName = document.getElementById('currentName');
const log = document.getElementById('log');
const drop = document.getElementById('drop');

let files = [];
let uploading = false;

function fmt(n){
  const u=['B','KB','MB','GB','TB'];
  let i=0;
  while(n>=1024 && i<u.length-1){n/=1024;i++}
  return `${n.toFixed(i?1:0)} ${u[i]}`;
}
function write(msg, cls=''){
  const line=document.createElement('div');
  if(cls) line.className=cls;
  line.textContent=msg;
  log.appendChild(line);
  log.scrollTop=log.scrollHeight;
}
function setFiles(list){
  if(uploading) return;
  files=[...list];
  const size=files.reduce((a,f)=>a+f.size,0);
  summary.textContent=files.length
    ? `${files.length}개 파일 · ${fmt(size)}`
    : '선택된 파일 없음';
  uploadBtn.disabled=!files.length;
  clearBtn.disabled=!files.length;
  totalBar.style.width='0%';
  currentBar.style.width='0%';
  percent.textContent='0%';
  currentPercent.textContent='0%';
  currentName.textContent=files.length ? '업로드 준비 완료' : '대기 중';
  log.textContent=files.length ? '폴더 선택 완료' : '준비됨';
}
input.addEventListener('change',()=>setFiles(input.files));

clearBtn.onclick=()=>{
  input.value='';
  setFiles([]);
};

['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{
  ev.preventDefault(); drop.classList.add('drag');
}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{
  ev.preventDefault(); drop.classList.remove('drag');
}));
drop.addEventListener('drop',ev=>{
  // 브라우저별 폴더 드롭 지원 차이가 있어 파일 드롭만 보조 지원.
  if(ev.dataTransfer.files.length) setFiles(ev.dataTransfer.files);
});

function uploadOne(file, relPath, completed, totalBytes){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('PUT','/upload',true);
    xhr.setRequestHeader('X-Relative-Path', encodeURIComponent(relPath));

    xhr.upload.onprogress=e=>{
      if(!e.lengthComputable) return;
      const cp=Math.round(e.loaded/e.total*100);
      currentBar.style.width=cp+'%';
      currentPercent.textContent=cp+'%';

      const overall = totalBytes ? ((completed+e.loaded)/totalBytes*100) : 100;
      const op=Math.min(100,Math.round(overall));
      totalBar.style.width=op+'%';
      percent.textContent=op+'%';
    };

    xhr.onload=()=>{
      if(xhr.status>=200 && xhr.status<300) resolve();
      else reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
    };
    xhr.onerror=()=>reject(new Error('네트워크 오류'));
    xhr.send(file);
  });
}

uploadBtn.onclick=async()=>{
  if(!files.length || uploading) return;
  uploading=true;
  uploadBtn.disabled=true;
  clearBtn.disabled=true;
  input.disabled=true;
  log.textContent='';

  const totalBytes=files.reduce((a,f)=>a+f.size,0);
  let completed=0;
  let success=0;

  for(let i=0;i<files.length;i++){
    const f=files[i];
    const rel=f.webkitRelativePath || f.name;
    currentName.textContent=`${i+1}/${files.length} · ${rel}`;
    currentBar.style.width='0%';
    currentPercent.textContent='0%';

    try{
      await uploadOne(f, rel, completed, totalBytes);
      completed+=f.size;
      success++;
      write(`✓ ${rel}`,'ok');
    }catch(err){
      write(`✗ ${rel} — ${err.message}`,'err');
      uploading=false;
      input.disabled=false;
      uploadBtn.disabled=false;
      clearBtn.disabled=false;
      currentName.textContent='업로드 중 오류 발생';
      return;
    }
  }

  totalBar.style.width='100%';
  percent.textContent='100%';
  currentBar.style.width='100%';
  currentPercent.textContent='100%';
  currentName.textContent=`완료 · ${success}개 파일`;
  write(`완료: ${success}개 파일 업로드됨`,'ok');

  uploading=false;
  input.disabled=false;
  uploadBtn.disabled=false;
  clearBtn.disabled=false;
};
</script>
</body>
</html>
"""

def safe_destination(raw_path: str) -> Path:
    decoded = urllib.parse.unquote(raw_path)
    decoded = decoded.replace("\\", "/").lstrip("/")
    parts = [p for p in decoded.split("/") if p not in ("", ".")]

    if not parts or any(p == ".." for p in parts):
        raise ValueError("잘못된 경로")

    dest = (UPLOAD_DIR.joinpath(*parts)).resolve()
    upload_root = UPLOAD_DIR.resolve()

    try:
        dest.relative_to(upload_root)
    except ValueError:
        raise ValueError("허용되지 않은 경로")

    return dest


class Handler(BaseHTTPRequestHandler):
    server_version = "FolderUpload/1.0"

    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}")

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            body = INDEX_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_error(404)

    def do_PUT(self):
        if self.path != "/upload":
            self.send_error(404)
            return

        raw_path = self.headers.get("X-Relative-Path")
        length = self.headers.get("Content-Length")

        if not raw_path or length is None:
            self.send_error(400, "Missing upload headers")
            return

        try:
            size = int(length)
            if size < 0:
                raise ValueError
            dest = safe_destination(raw_path)
            dest.parent.mkdir(parents=True, exist_ok=True)

            temp = dest.with_name(dest.name + ".uploading")
            remaining = size

            with open(temp, "wb") as f:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ConnectionError("업로드가 중간에 끊어졌습니다")
                    f.write(chunk)
                    remaining -= len(chunk)

            os.replace(temp, dest)

            msg = f"OK: {dest.relative_to(UPLOAD_DIR)}".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

        except ValueError as e:
            self.send_error(400, str(e))
        except Exception as e:
            try:
                if 'temp' in locals() and temp.exists():
                    temp.unlink()
            except Exception:
                pass
            self.send_error(500, str(e))


if __name__ == "__main__":
    print(f"업로드 폴더: {UPLOAD_DIR}")
    print(f"서버 주소: http://127.0.0.1:{PORT}")
    print(f"LAN 접속: http://<서버IP>:{PORT}")
    print("종료: Ctrl+C")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
