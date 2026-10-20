# archive/ — kode & catatan mati yang sengaja disimpan

Folder ini berisi hal-hal yang **tidak berada di jalur produksi** tetapi tetap
bernilai sebagai arsip rollback atau catatan keputusan. Isi tidak diimpor,
tidak dipanggil, dan tidak diuji oleh pipeline aktif.

| Subfolder | Isi | Kenapa diarsipkan |
|---|---|---|
| `kaggle/` | Worker oracle Qwen untuk kernel Kaggle + pendorong deploy CLI | Vonis visual sejak 2026-10 penuh ditangani Oracle lokal Qwen di VPS (`server/oracle_local/`). Lihat `kaggle/DEPRECATED.md` untuk syarat menyalakan ulang |
| `notes/` | Catatan perencanaan lama (`audit gpt.txt`, `plan lengkap.txt`, `prompt.txt`) | `prompt.txt` adalah seed pencarian niche alat dapur yang **sudah dihapus total**; ditinggal di root berisiko memicu regresi konsep |
| `ops/` | `setup-ssh-key.py`, `test_ssh.py` | Bootstrap SSH sekali-pakai untuk Termux/VPS. Nol referensi dari skrip lain, jadi tidak layak duduk di root — tapi masih berguna saat re-setup perangkat |

## Cara mengambil kembali

```bash
git log --oneline --diff-filter=D -- archive/   # riwayat penghapusan di area ini
git checkout <commit> -- <path>                 # kembalikan satu berkas dari commit tertentu
```

## Catatan pemakaian alat SSH (dari PC ke Termux)

```powershell
$env:TERMUX_SSH_PASS='password_termux'   # tidak pernah ditulis ke file
python archive/ops/setup-ssh-key.py --ip 10.x.x.x --user u0_aNNN --port 8022
$env:TERMUX_SSH_IP='10.x.x.x'; $env:TERMUX_SSH_USER='u0_aNNN'
python archive/ops/test_ssh.py
```

Kedua skrip butuh `paramiko` (`pip install paramiko`) dan membaca host/user/pass
hanya dari argumen baris perintah atau variabel lingkungan. `test_ssh.py` pernah
berisi IP + password Termux hardcoded; nilai itu dicabut saat pengarsipan
(2026-10-20) — tetapi masih terbaca di riwayat Git lama, jadi ganti password
Termux bila perangkat itu masih bisa diakses dari jaringan.
