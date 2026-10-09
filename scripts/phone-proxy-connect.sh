#!/bin/bash
# phone-proxy-connect.sh - Skrip untuk dijalankan di HP (Termux)
# Fungsi: Menjalankan SOCKS5 server dan SSH reverse tunnel ke VPS.
set -e

echo "==================================================="
echo "  Setup SOCKS5 Proxy & Reverse Tunnel di Termux"
echo "==================================================="

echo "[1/3] Install dependencies (openssh, microsocks, autossh)..."
pkg update -y
pkg install -y openssh microsocks autossh

echo "==================================================="
echo "Konfigurasi Koneksi ke VPS"
echo "Contoh: ubuntu@208.76.40.194 atau -p 14115 ubuntu@208.76.40.194"
read -p "Masukkan argumen SSH (contoh: root@<IP_VPS>): " SSH_ARGS

echo "[2/3] Setup SSH Key (jika belum ada)..."
if [ ! -f ~/.ssh/id_rsa ]; then
    ssh-keygen -t rsa -N "" -f ~/.ssh/id_rsa
    echo "Menyalin SSH key ke VPS (mungkin diminta password VPS)..."
    ssh-copy-id $SSH_ARGS
else
    echo "SSH Key sudah ada."
fi

echo "[3/3] Menjalankan Service..."

# Jalankan microsocks di background jika belum jalan
if ! pgrep microsocks > /dev/null; then
    echo "Menjalankan microsocks (SOCKS5 proxy) di port 1080..."
    microsocks -i 127.0.0.1 -p 1080 > /dev/null 2>&1 &
else
    echo "microsocks sudah berjalan."
fi

echo "Memulai autossh reverse tunnel ke VPS..."
echo "Tunnel ini akan membelokkan port 10808 di VPS ke port 1080 di HP."
echo "Biarkan script ini berjalan..."
autossh -M 0 -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -R 10808:127.0.0.1:1080 $SSH_ARGS
