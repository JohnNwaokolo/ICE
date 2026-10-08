"""Resumable, hash-verified qwen3:4b download from the official Ollama registry.

One-MiB checkpoints survive interrupted connections. No credentials or cloud API.
"""
import concurrent.futures
import hashlib
import http.client
import threading
import urllib.parse
import json
import pathlib
import os
import socket
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODELS = ROOT / 'runtime' / 'ollama' / 'models'
REGISTRY = 'https://registry.ollama.ai/v2/library/qwen3'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
CHUNK = 1024 * 1024

def request(url, headers=None):
    return OPENER.open(urllib.request.Request(url, headers={'User-Agent': 'Jarvis-John-local-setup', **(headers or {})}), timeout=90)

def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()

def download(blob):
    sha = blob['digest'].split(':')[1]
    size = blob['size']
    target = MODELS / 'blobs' / ('sha256-' + sha)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size == size and digest(target) == sha:
        print('Already verified', sha[:12], flush=True)
        return
    parts = MODELS / 'download-parts' / sha
    parts.mkdir(parents=True, exist_ok=True)
    url = REGISTRY + '/blobs/sha256:' + sha
    with request(url, {'Range': 'bytes=0-0'}) as response:
        direct = response.geturl()
        if response.status != 206 and size > CHUNK:
            raise RuntimeError('The official registry did not support resumable ranges.')
    count = (size + CHUNK - 1) // CHUNK
    endpoint = urllib.parse.urlsplit(direct)
    local = threading.local()
    preferred_ip = os.environ.get('JARVIS_DOWNLOAD_IP')
    if preferred_ip and preferred_ip not in {x[4][0] for x in socket.getaddrinfo(endpoint.hostname,443,type=socket.SOCK_STREAM)}:
        raise RuntimeError('Download IP must be a current DNS address of the official registry redirect.')
    def worker(index):
        start = index * CHUNK
        end = min(size, start + CHUNK) - 1
        path = parts / f'{index:06d}.part'
        if path.exists() and path.stat().st_size == end-start+1:
            return end-start+1
        temporary = path.with_suffix('.tmp')
        for attempt in range(12):
            try:
                saved = temporary.stat().st_size if temporary.exists() else 0
                if saved > end-start+1:
                    raise RuntimeError('Oversized partial checkpoint; inspect the download cache.')
                if saved == end-start+1:
                    temporary.replace(path)
                    return saved
                resume = start + saved
                if not getattr(local, 'connection', None):
                    local.connection = http.client.HTTPSConnection(endpoint.hostname, endpoint.port or 443, timeout=30)
                    if preferred_ip:
                        # The HTTPS hostname and certificate verification remain unchanged.
                        local.connection._create_connection = lambda addr, timeout, *a, **kw: socket.create_connection((preferred_ip, addr[1]), timeout, *a, **kw)
                local.connection.request('GET', endpoint.path + ('?' + endpoint.query if endpoint.query else ''), headers={'Range':f'bytes={resume}-{end}', 'User-Agent':'Jarvis-John-local-setup'})
                response = local.connection.getresponse()
                if not (response.status == 206 and response.getheader('Content-Range', '').startswith(f'bytes {resume}-{end}/')) and not (response.status == 200 and resume == 0 and end == size-1):
                    raise RuntimeError('Unexpected byte range response')
                with temporary.open('ab', buffering=0) as output:
                    while saved < end-start+1:
                        data = response.read1(min(65536, end-start+1-saved))
                        if not data:
                            raise RuntimeError('Incomplete chunk; partial bytes kept for resume')
                        output.write(data)
                        saved += len(data)
                temporary.replace(path)
                return saved
            except Exception as error:
                if getattr(local, 'connection', None):
                    local.connection.close()
                    local.connection = None
                if attempt in (0, 5, 11):
                    print(f'Chunk {index} retry {attempt+1}: {type(error).__name__}', flush=True)
                if attempt == 11:
                    raise
                time.sleep(min(20, attempt+1))
    pending = [i for i in range(count) if not ((parts/f'{i:06d}.part').exists() and (parts/f'{i:06d}.part').stat().st_size == min(CHUNK, size-i*CHUNK))]
    completed = size - sum(min(CHUNK, size-i*CHUNK) for i in pending)
    last = -1
    print(f'Resuming {completed}/{size} bytes; {len(pending)} chunks left.', flush=True)
    started = time.monotonic()
    raw_workers = int(os.environ.get("JARVIS_DOWNLOAD_WORKERS", "8"))
    workers = max(1, min(32, raw_workers))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for future in concurrent.futures.as_completed([pool.submit(worker, i) for i in pending]):
            completed += future.result()
            percent = int(completed * 100 / size)
            if percent != last:
                progress = {'status': 'downloading checkpoints; final hash pending', 'digest': sha, 'completed': completed, 'total': size, 'percent': percent, 'elapsedSeconds': round(time.monotonic()-started,1)}
                (ROOT / 'runtime' / 'ollama' / 'pull-progress.json').write_text(json.dumps(progress, indent=2))
                print(json.dumps(progress), flush=True)
                last = percent
    temporary = target.with_suffix('.assembling')
    with temporary.open('wb') as output:
        for index in range(count):
            output.write((parts / f'{index:06d}.part').read_bytes())
    if digest(temporary) != sha:
        raise RuntimeError('Model digest mismatch. The model will not be installed.')
    temporary.replace(target)
    print('SHA256 verified', sha, flush=True)

def already_running(pid):
    if pid <= 0 or pid == os.getpid():
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

def main():
    MODELS.mkdir(parents=True, exist_ok=True)
    lock = MODELS / 'download.lock'
    if lock.exists():
        try:
            other = int(lock.read_text().strip())
        except ValueError:
            other = 0
        if already_running(other):
            print('Another qwen3:4b download is already running. Not starting a second one.', flush=True)
            return
    lock.write_text(str(os.getpid()))
    try:
        with request(REGISTRY + '/manifests/4b', {'Accept':'application/vnd.docker.distribution.manifest.v2+json'}) as response:
            raw = response.read()
        manifest = json.loads(raw)
        for blob in manifest['layers'] + [manifest['config']]:
            download(blob)
        path = MODELS / 'manifests' / 'registry.ollama.ai' / 'library' / 'qwen3' / '4b'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        (ROOT/'runtime'/'ollama'/'pull-progress.json').write_text(json.dumps({'status':'success','model':'qwen3:4b','verified':True}))
        print('qwen3:4b installed and verified. Start-Jarvis.cmd can now open ICE.', flush=True)
    finally:
        try:
            if lock.exists() and lock.read_text().strip() == str(os.getpid()):
                lock.unlink()
        except OSError:
            pass

if __name__ == '__main__':
    main()
