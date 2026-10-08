# setup-ssh-key.py — Daftarkan kunci SSH PC ke Termux agar login/sync tanpa password.
#
# Cara pakai (PowerShell di PC, setelah `bash syn.sh` jalan di Termux):
#   $env:TERMUX_SSH_PASS='password_anda'
#   python setup-ssh-key.py [--ip 10.162.195.166] [--user u0_aNNN] [--port 8022]
#
# Password TIDAK pernah dicetak script ini; ambil dari env TERMUX_SSH_PASS.
# Username Termux dilihat dari hasil 'whoami' di Termux (biasanya u0_aNNN).

import argparse
import os
import sys

import paramiko

PUBKEY_PATH = os.path.expanduser("~/.ssh/id_ed25519_termux.pub")
PRIVKEY_PATH = os.path.expanduser("~/.ssh/id_ed25519_termux")


def connect(host, port, username, **kw):
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(host, port=port, username=username, timeout=15,
              allow_agent=False, look_for_keys=False, **kw)
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ip", default="10.162.195.166")
    ap.add_argument("--port", type=int, default=8022)
    ap.add_argument("--user", required=True, help="hasil 'whoami' di Termux (u0_aNNN)")
    args = ap.parse_args()

    password = os.environ.get("TERMUX_SSH_PASS")
    if not password:
        print("Isi dulu env TERMUX_SSH_PASS (di PowerShell: $env:TERMUX_SSH_PASS='...')")
        sys.exit(1)
    if not os.path.isfile(PUBKEY_PATH):
        print(f"Public key tidak ada: {PUBKEY_PATH}\nJalankan: ssh-keygen -t ed25519 -f {PRIVKEY_PATH} -N '' -C clippervps-pc")
        sys.exit(1)

    pub = open(PUBKEY_PATH).read().strip()
    fp_marker = pub.split()[1][:20]  # penanda unik isi kunci utk cegah duplikat

    print(f"[1/3] Menghubungkan ke {args.user}@{args.ip}:{args.port} (password)...")
    try:
        c = connect(args.ip, args.port, args.user, password=password)
    except paramiko.AuthenticationException:
        print("GAGAL auth: username/password salah, atau 'passwd' belum pernah dijalankan di Termux.")
        sys.exit(2)
    except Exception as e:
        print(f"TIDAK terhubung: {e}\nPastikan 'bash syn.sh' dijalankan di Termux dan HP 1 jaringan Wi-Fi dengan PC.")
        sys.exit(3)

    cmd = (
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && "
        f"grep -qF '{fp_marker}' ~/.ssh/authorized_keys || echo '{pub}' >> ~/.ssh/authorized_keys; "
        "chmod 600 ~/.ssh/authorized_keys; echo KEY_INSTALLED; whoami"
    )
    print("[2/3] Mendaftarkan public key ke ~/.ssh/authorized_keys...")
    _, out, err = c.exec_command(cmd)
    print(out.read().decode() + err.read().decode())
    c.close()

    print("[3/3] Verifikasi login MENGGUNAKAN KUNCI (tanpa password)...")
    try:
        c2 = connect(args.ip, args.port, args.user, key_filename=PRIVKEY_PATH)
        _, out, _ = c2.exec_command("echo KEY_LOGIN_OK; whoami; pwd")
        print(out.read().decode())
        c2.close()
    except Exception as e:
        print(f"Login dengan kunci masih GAGAL: {e}")
        sys.exit(4)

    print("Selesai. Isi sync.config.json: sshKeyPath = " + PRIVKEY_PATH.replace("\\", "/"))


if __name__ == "__main__":
    main()
