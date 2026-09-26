import paramiko, sys, time, re
sys.stdout.reconfigure(encoding='utf-8')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('10.99.208.197', port=8022, username='u0_a466', password='123456', timeout=15)
shell = client.invoke_shell(width=220, height=50)
time.sleep(2)
if shell.recv_ready(): shell.recv(32768)

def run(cmd, timeout=60):
    shell.send(cmd + '\n')
    output = ''
    start = time.time()
    last_data = time.time()
    while time.time() - start < timeout:
        if shell.recv_ready():
            chunk = shell.recv(32768).decode('utf-8', errors='replace')
            output += chunk
            try: print(chunk, end='', flush=True)
            except: pass
            last_data = time.time()
        else:
            time.sleep(0.5)
            clean = re.sub(r'\x1b\[[0-9;]*m', '', output)
            last_line = clean.split('\n')[-1] if clean else ''
            if re.search(r'[$#]\s*$', last_line) and time.time() - last_data > 2:
                break
    return output

print("=== Login proot ubuntu ===")
run('proot-distro login ubuntu', timeout=10)

print("\n=== Coba resurrect dari dump.pm2 ===")
out = run('pm2 resurrect 2>&1', timeout=15)

# If resurrect failed or list still empty, start fresh
if 'not found' in out.lower() or 'no dump' in out.lower() or 'error' in out.lower():
    print("\n=== Resurrect gagal, start manual ===")
    run('cd ~/clippervps && pm2 start dev-runner.js --name clipper', timeout=30)
    run('pm2 start server/gatekeeper/service.py --name gatekeeper --interpreter python3 2>&1 || true', timeout=15)
else:
    print("\n=== Resurrect berhasil, restart untuk kode baru ===")
    run('cd ~/clippervps && pm2 restart clipper', timeout=20)

print("\n=== pm2 save ===")
run('pm2 save', timeout=15)

print("\n=== Tunggu 8 detik untuk boot ===")
time.sleep(8)

print("\n=== pm2 list ===")
run('pm2 list', timeout=10)

print("\n=== pm2 logs 30 baris ===")
shell.send('pm2 logs clipper --lines 30 --nostream\n')
time.sleep(8)
out = ''
deadline = time.time() + 10
while time.time() < deadline:
    if shell.recv_ready():
        out += shell.recv(65536).decode('utf-8', errors='replace')
    time.sleep(0.5)
try: print(out)
except: pass

client.close()
print("\n=== SELESAI ===")
