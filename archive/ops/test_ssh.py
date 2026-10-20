# test_ssh.py — Uji koneksi SSH ke Termux (dipakai saat re-setup perangkat).
#
# Kredensial TIDAK pernah di-hardcode di file ini — semua dibaca dari environment:
#   $env:TERMUX_SSH_IP='10.x.x.x'; $env:TERMUX_SSH_USER='u0_aNNN'
#   $env:TERMUX_SSH_PORT='8022';   $env:TERMUX_SSH_PASS='...'
#   python archive/ops/test_ssh.py

import os
import sys

import paramiko

HOST = os.environ.get('TERMUX_SSH_IP')
USER = os.environ.get('TERMUX_SSH_USER')
PORT = int(os.environ.get('TERMUX_SSH_PORT', '8022'))
PASSWORD = os.environ.get('TERMUX_SSH_PASS')

if not (HOST and USER and PASSWORD):
    sys.exit("Isi dulu env TERMUX_SSH_IP, TERMUX_SSH_USER, TERMUX_SSH_PASS "
             "(dan TERMUX_SSH_PORT bila bukan 8022).")

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

try:
    client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=10)
    stdin, stdout, stderr = client.exec_command('whoami; uname -a; proot-distro list')
    print("STDOUT:")
    print(stdout.read().decode())
    print("STDERR:")
    print(stderr.read().decode())
except Exception as e:
    print(f"Failed: {e}")
finally:
    client.close()
