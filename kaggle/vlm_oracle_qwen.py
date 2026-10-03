# ============================================================================
# VLM ORACLE WORKER - sisi KAGGLE (model besar), sisi HTTP saja.
#
# PERAN: notebook ini TIDAK menjalankan pipeline. Ia hanya menjadi KLIEN dari
# API ClipperVPS Anda: claim batch frame -> unduh JPEG -> vonis dengan bobot yang
# dikonfigurasi (default Qwen2.5-VL-3B-Instruct) -> kirim verdict -> ulangi. Arah koneksi dipaksa
# oleh kenyataan bahwa Kaggle tidak punya inbound; HP/PC Anda tidak pernah
# "menelepon" ke Kaggle. Kalau notebook ini mati, job lokal hanya kehilangan
# lapisan veto (gatekeeper legacy tetap bekerja) - tidak ada yang rusak.
#
# CARA PAKAI (ringkas, detail di README):
#   1. Beri tahu notebook dari mana ia harus memanggil API lokal ANDA. Ada dua
#      cara, dan keduanya tersedia tanpa membuka UI Kaggle sama sekali:
#      (a) Dataset privat + CLI (DIPRIORITASKAN, karena URL quick-tunnel berubah
#          tiap server restart): deploy.ps1 meng-upload oracle_config.json ke
#          dataset <user>/clippervps-oracle-config yang di-attach kernel ini:
#              {"base_url": "https://xxx.trycloudflare.com", "api_access_token": "..."}
#      (b) Kaggle > Account > Environment variables (perlu UI sekali per perubahan):
#              VLM_ORACLE_BASE_URL  = https://<xxx>.trycloudflare.com (tanpa slash akhir)
#              API_ACCESS_TOKEN     = <nilai yang SAMA dengan server/.env>
#      Env var mengalahkan dataset, supaya Anda bisa menimpa cepat dari UI.
#   2. Accelerator: GPU T4 x2 (atau P100). Metadata kernel sudah men-set ini, dan worker
#      MENOLAK jalan tanpa CUDA (ORACLE_REQUIRE_GPU=1) - lihat catatan dtype/perangkat di
#      KONFIG: lapisan ini ada justru karena GPU, bukan untuk inferensi CPU pelan.
#   3. Jalankan. Notebook ini looping; hentikan manual atau ia exit sendiri
#      setelah ORACLE_MAX_MINUTES supaya tidak dipotong Kaggle di jam ke-12.
#
# Token NIKKIR (tidak pernah dicetak ke log) karena log notebook bisa ter-share.
# ============================================================================
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import requests


def _load_json_if_config(path):
    """Baca JSON dan terima HANYA bila ia memang konfigurasi oracle."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    if isinstance(data, dict) and any(k in data for k in (
            "base_url", "baseUrl", "api_access_token", "token", "ORACLE_NO_MODEL",
            "ORACLE_MODEL_ID", "ORACLE_MAX_MINUTES", "ORACLE_MODEL_MOUNT",
            "HF_TOKEN", "hf_token")):
        return data
    return None


def _read_config_dataset():
    """Cari oracle_config.json dari dataset yang di-attach kernel.

    Kaggle menaruh isi dataset di bawah /kaggle/input/, tapi nama foldernya dibuat dari
    JUDUL dataset (spasi -> tanda hubung) dan bisa berlapis lagi di dalam. Jadi jangan
    tebak satu path: jalan rekursif dan kenali file dari ISINYA. Isi file tidak pernah
    dicetak - yang muncul hanya nama file, supaya log notebook aman di-share.
    """
    root = "/kaggle/input"
    try:
        if not os.path.isdir(root):
            print("[oracle] /kaggle/input tidak ada (dataset konfigurasi tidak ter-attach).", flush=True)
            return {}
        stack = [(root, 0)]
        seen = []
        while stack:
            cur, depth = stack.pop()
            try:
                names = sorted(os.listdir(cur))
            except Exception:
                continue
            if cur == root:
                seen = names
            for name in names:
                full = os.path.join(cur, name)
                if os.path.isdir(full):
                    if depth < 4:
                        stack.append((full, depth + 1))
                    continue
                if not name.lower().endswith(".json"):
                    continue
                data = _load_json_if_config(full)
                if data is not None:
                    print("[oracle] konfigurasi dibaca dari dataset: %s (key: %s)" % (
                        name, ",".join(sorted(data.keys()))), flush=True)
                    return data
        print("[oracle] tidak menemukan oracle_config.json di bawah /kaggle/input; mount teratas: %s"
              % (",".join(seen) or "(kosong)"), flush=True)
    except Exception as err:  # dataset tidak ada/rusak -> biarkan env yang bicara
        print("[oracle] config dataset dilewati: %s" % err, flush=True)
    return {}


_CFG = _read_config_dataset()


def _cfg(*names, **kw):
    """Urutan prioritas: env var > oracle_config.json (dataset) > default."""
    for n in names:
        v = os.getenv(n)
        if v:
            return v
    for n in names:
        v = _CFG.get(n) or _CFG.get(n.lower())
        if v:
            return str(v)
    return kw.get("default", "")


# ------------------------------------------------------------------ KONFIG ---
BASE_URL = (_cfg("VLM_ORACLE_BASE_URL", "ORACLE_BASE_URL", "base_url", "baseUrl") or "").rstrip("/")
TOKEN = _cfg("API_ACCESS_TOKEN", "VLM_ORACLE_API_TOKEN", "api_access_token", "token")
# Model default Qwen2.5-VL-3B-Instruct (fp16), BUKAN 7B-AWQ. Alasannya terukur,
# bukan perkiraan: round trip 7B = 3,5-5,7 s per frame, LEBIH LAMBAT dari gatekeeper
# lokal di HP (2,34 s/frame), dan bobot AWQ butuh `gptqmodel` yang gagal dimuat di image
# Kaggle terbaru. 3B fp16 ~6 GB, nyaman di T4 16 GB, tanpa quantizer apa pun.
MODEL_ID = _cfg("ORACLE_MODEL_ID", default="qwen/Qwen2.5-VL-3B-Instruct")
# RANTAI FALLBACK ANTAR-BOTOT DIHAPUS, dan itu sengaja. Dulu 7B -> 3B, akibatnya `model`
# yang tercatat di vonis bisa berbeda dari bobot yang Anda kalibrasi, dan kegagalan muat
# berubah menjadi "sukses diam-diam memakai bobot lain". Yang tersisa hanya retry untuk
# bobot yang SAMA (memasang quantizer yang kurang). Kalau tetap gagal, sesi mati dengan
# pesan jelas - pipeline lokal aman karena oracle memang fail-open: tanpa vonis tidak ada
# veto, dan gatekeeper lokal tetap menyaring.
LEGACY_FALLBACK = _cfg("ORACLE_FALLBACK_MODEL_ID")
# GPU adalah alasan lapisan ini ada. Kuota GPU mingguan itu terbatas (README bagian "Kuota"
# mencatat dua angka Kaggle yang saling bertentangan: 6 jam dari SDK penegas sesi, 30 jam dari
# tabel CLI). Kalau sesi ternyata TIDAK melihat CUDA, meneruskan = inferensi CPU yang belasan
# kali lebih lambat SAMBIL membakar kuota. Jadi defaultnya berhenti, bukan jalan pelan.
# Matikan hanya untuk debug: ORACLE_REQUIRE_GPU=0.
REQUIRE_GPU = _cfg("ORACLE_REQUIRE_GPU", default="1") != "0"
# float16, BUKAN "auto". `torch_dtype="auto"` mengambil nilai dari config bobot = bfloat16,
# dan T4 (Turing) tidak punya jalur bf16 - bobot tetap 6 GB tapi tiap op jatuh ke emulasi.
# fp16 adalah format native T4. ORACLE_TORCH_DTYPE=auto kalau Anda pindah ke GPU Ampere+.
TORCH_DTYPE = (_cfg("ORACLE_TORCH_DTYPE", default="float16") or "float16").lower()
# Bobot yang SUDAH ada di dalam sesi (Kaggle Model lewat model_sources, atau dataset berisi
# snapshot HF) di-mount di bawah /kaggle/input. Memakainya memangkas biaya yang terukur tadi:
# dari 86,7 s "siap" (22 s pip + 21 s unduh HF + 47 s muat) tinggal waktu baca disk. Path
# eksplisit boleh dipaksa; kalau kosong, find_mounted_model() mengenali dari ISI direktori.
MODEL_MOUNT = _cfg("ORACLE_MODEL_MOUNT", "model_mount")
# Token HF hanya untuk unduhan (rate limit/429 di jaringan Kaggle); bukan syarat bisa jalan.
HF_TOKEN = _cfg("HF_TOKEN", "hugging_face_token", "hf_token")
if HF_TOKEN:
    # WAJIB di-set sebelum transformers di-import; setelah itu HF_HUB sudah membaca env.
    os.environ.setdefault("HF_TOKEN", HF_TOKEN)
POLL_SEC = float(_cfg("ORACLE_POLL_SEC", default="5") or 5)
IDLE_SLEEP_MAX = float(_cfg("ORACLE_IDLE_SLEEP_MAX", default="30") or 30)
MAX_MINUTES = float(_cfg("ORACLE_MAX_MINUTES", default="690") or 690)   # < 12 jam Kaggle
MAX_SIDE = int(_cfg("ORACLE_MAX_SIDE", default="1024") or 1024)         # turun sebelum inference
MAX_NEW_TOKENS = int(_cfg("ORACLE_MAX_NEW_TOKENS", default="160") or 160)
AUTO_INSTALL = _cfg("ORACLE_AUTO_INSTALL", default="1") == "1"
# Set 1 untuk menguji sambungan (claim/report) TANPA memuat model - berguna untuk
# memvalidasi tunnel + token sebelum menghabiskan kuota GPU.
NO_MODEL = _cfg("ORACLE_NO_MODEL", default="0") == "1"

# (module yang di-import, nama paket pip). Hanya yang HILANG yang dipasang, jadi sesi
# tidak menghabiskan waktu untuk `pip install` hal-hal yang sudah ada di image Kaggle.
REQUIRED_PIP = (
    ("transformers", "transformers"),
    ("accelerate", "accelerate"),
    ("qwen_vl_utils", "qwen-vl-utils[decord]==0.0.8"),
    ("PIL", "pillow"),
)

START = time.time()
TMP_ROOT = tempfile.mkdtemp(prefix="oracle_frames_")
# Nama yang dicatat di SETIAP verdict. Kalau bobot datang dari mount lokal (bukan HF id),
# ini ikut diganti ke nama mount tersebut supaya vonis tetap bisa diatribusikan.
MODEL_LABEL = MODEL_ID.split("/")[-1]
# Diisi saat muat; ikut dikirim di verdict supaya log lokal menunjukkan DI MANA vonis lahir.
DEVICE_INFO = {"cuda": False, "name": "belum dimuat", "device": "", "dtype": ""}


def log(msg):
    print("[%7.1fs] %s" % (time.time() - START, msg), flush=True)


def read_token_from_file():
    """Fallback: Kaggle 'Kaggle API' input menaruh kaggle.json (username+key).
    Itu BUKAN token kita, jadi hanya dipakai bila user menyimpan token di
    file rahasia terpisah bernama oracle_token.txt di direktori yang sama."""
    for cand in ("/kaggle/input/oracle_token.txt", "oracle_token.txt"):
        try:
            if os.path.exists(cand):
                with open(cand, "r", encoding="utf-8") as fh:
                    return fh.read().strip()
        except Exception:
            pass
    return ""


def ensure_deps():
    if NO_MODEL:
        return
    # Cek SATU PER SATU, bukan hanya `import transformers`. Image Kaggle sudah membawa
    # transformers + torch, jadi cek tunggal dulu selalu "lolos" dan qwen_vl_utils tidak
    # pernah terpasang - gejalanya: model termuat, claim sukses, lalu seluruh batch
    # kembali dengan error `No module named 'qwen_vl_utils'` (kuota GPU terpakai, vonis nol).
    missing = []
    for mod, pkg in REQUIRED_PIP:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if not missing:
        return
    if not AUTO_INSTALL:
        raise SystemExit("Dependensi kurang: %s. Set ORACLE_AUTO_INSTALL=1 atau install manual." % ", ".join(missing))
    log("Menginstal dependensi yang kurang (sekali per sesi): %s" % ", ".join(missing))
    pip_install(*missing)
    time.sleep(3)  # beri kesempatan filesystem sinkron


def pip_install(*packages):
    """pip via subprocess + argumen list (BUKAN string ke shell): tidak ada interpreasi
    shell, jadi nilai env/user tidak bisa menyuntik perintah."""
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "--no-warn-conflicts"] + list(packages),
        check=False,
    )


def _pick_dtype(torch):
    """float16 di GPU. Di CPU, fp16/bf16 tidak didukung merata -> float32 (dan itu berarti
    sesi Anda salah perangkat: gerbang GPU di load_model sudah menghentikannya lebih dulu,
    kecuali ORACLE_REQUIRE_GPU=0 untuk debug)."""
    want = TORCH_DTYPE
    if want in ("auto", ""):
        return "auto"
    table = {"float16": torch.float16, "fp16": torch.float16, "half": torch.float16,
             "bfloat16": torch.bfloat16, "bf16": torch.bfloat16,
             "float32": torch.float32, "fp32": torch.float32}
    if want not in table:
        log("ORACLE_TORCH_DTYPE=%s tidak dikenal; pakai float16." % want)
        return torch.float16
    if not torch.cuda.is_available() and table[want] in (torch.float16, torch.bfloat16):
        log("CUDA tidak terlihat -> float32 (fp16/bf16 tidak dipakai di CPU).")
        return torch.float32
    return table[want]


def describe_device(torch, model):
    cuda = bool(torch.cuda.is_available())
    info = {"cuda": cuda, "name": "", "device": "", "dtype": ""}
    if cuda:
        info["name"] = torch.cuda.get_device_name(0)
        try:
            free_b, total_b = torch.cuda.mem_get_info()
            info["name"] += " (%.1f/%.1f GB terpakai)" % ((total_b - free_b) / 2 ** 30, total_b / 2 ** 30)
        except Exception:
            pass
    else:
        info["name"] = "CPU"
    try:
        info["device"] = str(next(model.parameters()).device)
    except Exception:
        info["device"] = "(tidak terbaca)"
    return info


def _has_weights(dir_path):
    """Snapshot bobot sungguhan: safetensors tunggal ATAU index + shard. Folder berisi
    README saja tidak boleh lolos - itu memberi error muat yang membingungkan."""
    if glob.glob(os.path.join(dir_path, "*.safetensors")):
        return True
    if os.path.isfile(os.path.join(dir_path, "model.safetensors.index.json")):
        return True
    return bool(glob.glob(os.path.join(dir_path, "*.bin")))


def _processor_status(dir_path):
    """Ringkasan diagnostik: apakah snapshot mount bisa dipakai untuk AutoProcessor.
    Hanya membaca, tidak pernah mengubah sumber bobot. Yang dibutuhkan transformers
    adalah `image_processor_type` yang dikenal di preprocessor_config.json."""
    p = os.path.join(dir_path, "preprocessor_config.json")
    if not os.path.isfile(p):
        return "tanpa preprocessor_config.json"
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return "preprocessor_config.json tidak terbaca"
    t = data.get("image_processor_type")
    if isinstance(t, (list, tuple)):
        t = t[0] if t else None
    return "image_processor_type=%s" % t if t else "tanpa image_processor_type"


def _is_qwen_vl_dir(dir_path):
    cfgp = os.path.join(dir_path, "config.json")
    if not os.path.isfile(cfgp) or not _has_weights(dir_path):
        return False
    try:
        with open(cfgp, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except Exception:
        return False
    arch = (" ".join(cfg.get("architectures") or []) + " " + str(cfg.get("model_type", ""))).lower()
    return "qwen2_5_vl" in arch or "qwen2.5-vl" in arch


def find_mounted_model(root="/kaggle/input"):
    """Kembalikan path bobot yang SUDAH ter-mount di sesi, atau None.

    Kaggle menaruh model_sources di /kaggle/input/models/<owner>/<model>/<framework>/<
    instance>/<versi>/ dan tiap segmen nama ditentukan pembuat modelnya (qwen-lm vs qwen,
    transformers vs pytorch), jadi menebak satu path adalah cara tercepat untuk bug. Yang
    dipakai di sini: kenali dari ISI direktori (config.json arsitektur Qwen2_5_VL + bobot
    sungguhan), lalu prioritaskan yang namanya paling mirip MODEL_ID. Isi file tidak pernah
    dicetak - yang muncul hanya nama folder. Param `root` ada supaya fungsi ini teruji di
    mesin tanpa /kaggle/input (korpus tiruan di temp), BUKAN untuk diubah pemanggil.
    """
    if MODEL_MOUNT:
        if _is_qwen_vl_dir(MODEL_MOUNT):
            log("ORACLE_MODEL_MOUNT diterima: %s" % MODEL_MOUNT)
            return MODEL_MOUNT
        log("ORACLE_MODEL_MOUNT=%s bukan snapshot Qwen2.5-VL yang sah; cari otomatis." % MODEL_MOUNT)
    if not os.path.isdir(root):
        return None
    tokens = [t for t in re.split(r"[^a-z0-9]+", MODEL_LABEL.lower()) if t]
    best, best_score, found = None, -1, []
    stack = [(root, 0)]
    while stack:
        cur, depth = stack.pop()
        if os.path.normpath(cur) != os.path.normpath(root) and _is_qwen_vl_dir(cur):
            low = cur.lower()
            score = sum(1 for t in tokens if t in low)
            found.append(cur)
            if score > best_score or (score == best_score and best and len(cur) < len(best)):
                best, best_score = cur, score
        if depth >= 6:
            continue
        try:
            names = sorted(os.listdir(cur))
        except Exception:
            continue
        for name in names:
            full = os.path.join(cur, name)
            if os.path.isdir(full):
                stack.append((full, depth + 1))
    if found:
        # Baris ini yang membedakan "mount tidak jalan" dari "mount jalan tapi processor
        # mirror tidak bisa dipakai" - terukur di kernel v11, keduanya terjadi sekaligus.
        log("Mount bobot terdeteksi: %d kandidat, dipilih %s | processor di mount: %s" % (
            len(found), best, _processor_status(best) if best else "-"))
    return best


def model_label_for(ref):
    """Nama bobot yang dicatat di verdict. Mount Kaggle berakhir dengan NOMOR VERSI
    (/kaggle/input/models/qwen-lm/qwen2.5-vl/transformers/3b-instruct/2), jadi basename
    mentah akan menulis "2" - tidak berguna saat Anda membaca tabel kalibrasi. Yang disimpan
    adalah dua segmen nama terakhir yang berarti (di sini: qwen2.5-vl-3b-instruct)."""
    if ref == MODEL_ID:
        return MODEL_ID.split("/")[-1]
    noise = {"kaggle", "input", "models", "model", "datasets", "data", "transformers",
             "pytorch", "tensorflow", "tfhub", "jax", "default", "main", "1", "2", "3"}
    parts = [p for p in str(ref).replace("\\", "/").split("/") if p]
    named = [p for p in parts if p.lower() not in noise and not p.isdigit()]
    return "-".join(named[-2:]) or (parts[-1] if parts else str(ref))


PROC_MIN_PIXELS = 256 * 28 * 28
PROC_MAX_PIXELS = 1280 * 28 * 28


def load_processor(AutoProcessor, model_ref):
    """Ambil processor (pembagi image + tokenizer) dan laporkan dari mana ia datang.

    Kenapa fungsi ini ada: terukur pada kernel versi 10 dan 11 (2026-10-03), bobot dari
    mount Kaggle dimuat SUKSES (824/824 tensor) tetapi `AutoProcessor.from_pretrained(mount)`
    mati dengan "Unrecognized image processor" - mirror Kaggle Models punya
    `preprocessor_config.json` yang tidak cukup untuk transformers (kelas image processor
    Qwen2.5-VL terdaftar lewat key `image_processor_type` di file itu, dan nilai yang
    tersimpan tidak dikenali).

    Fall-backnya HANYA processor, diunduh dari HF id: itu file kecil - terukur 3,6 s di
    kernel v11 - bukan bobot 7 GB, jadi hemat waktu yang dikejar opsi ini tetap
    didapat. BOBOT tidak pernah berpindah sumber di sini; kalau
    sumbernya sudah HF id dan processor tetap gagal, kesalahan dilempar apa adanya.
    """
    try:
        return AutoProcessor.from_pretrained(
            model_ref, min_pixels=PROC_MIN_PIXELS, max_pixels=PROC_MAX_PIXELS), model_ref
    except Exception as err:
        if model_ref == MODEL_ID:
            raise
        log("Processor tidak dikenali di mount (%s: %s) -> ambil processor dari %s"
            % (type(err).__name__, str(err)[:120], MODEL_ID))
        return AutoProcessor.from_pretrained(
            MODEL_ID, min_pixels=PROC_MIN_PIXELS, max_pixels=PROC_MAX_PIXELS), MODEL_ID


def _build(model_ref):
    import torch
    from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor
    dtype = _pick_dtype(torch)
    t0 = time.time()
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        model_ref,
        torch_dtype=dtype,
        device_map="auto",
        # sdpa menghindari kebutuhan flash-attention yang sering gagal build di Kaggle.
        attn_implementation="sdpa",
    )
    model.eval()
    processor, proc_src = load_processor(AutoProcessor, model_ref)
    global DEVICE_INFO
    DEVICE_INFO = describe_device(torch, model)
    DEVICE_INFO["dtype"] = "auto" if dtype == "auto" else str(dtype).replace("torch.", "")
    DEVICE_INFO["processor"] = proc_src
    log("Model %s siap dalam %.0fs | torch=%s cuda=%s | %s | bobot di %s | dtype=%s | processor dari %s" % (
        MODEL_LABEL, time.time() - t0, torch.__version__, DEVICE_INFO["cuda"],
        DEVICE_INFO["name"], DEVICE_INFO["device"], DEVICE_INFO["dtype"],
        "HF id" if proc_src == MODEL_ID else "mount"))
    return model, processor, torch


def load_model():
    """Muat SATU bobot. Tidak ada fallback ke bobot lain (lihat KONFIG).

    Urutan sumber: ORACLE_MODEL_MOUNT -> mount Kaggle yang dikenali otomatis -> unduh HF.
    Yang pertama selalu dipilih, karena yang terakhir adalah biaya yang terukur hari ini:
    22 s pip + 21 s unduh HF + 47 s muat = 86,7 s sebelum vonis pertama bisa keluar.

    Satu-satunya retry yang diizinkan memperbaiki DEPENDENSI untuk bobot yang sama:
    transformers bawaan image Kaggle memuat AWQ lewat `gptqmodel`, jadi kalau ImportError
    menyebut quantizer itu, pasang lalu coba bobot yang sama sekali lagi. Gagal lagi =
    raise; sesi berhenti dan log menunjukkan penyebabnya apa adanya, bukan tertutup oleh
    vonis dari bobot yang tidak Anda pilih.
    """
    if LEGACY_FALLBACK:
        log("CATATAN: ORACLE_FALLBACK_MODEL_ID=%s DIABAIKAN - fallback antar-bobot sudah dihapus." % LEGACY_FALLBACK)
    import torch  # lebih awal: gerbang GPU harus memutuskan SEBELUM sesi bayar unduhan
    if REQUIRE_GPU and not torch.cuda.is_available():
        raise SystemExit(
            "CUDA tidak terlihat di sesi ini, jadi bobot akan jalan di CPU - belasan kali lebih "
            "lambat SAMBIL tetap memotong kuota GPU. Set Accelerator notebook ke GPU T4 "
            "(machine_shape NvidiaTeslaT4) lalu jalankan ulang. Debug sengaja tanpa GPU: "
            "ORACLE_REQUIRE_GPU=0.")
    ref = find_mounted_model() or MODEL_ID
    log("Sumber bobot: %s" % ("mount lokal (tanpa unduh HF)" if ref != MODEL_ID else "unduh HF %s" % MODEL_ID))
    global MODEL_LABEL
    MODEL_LABEL = model_label_for(ref)
    try:
        return _build(ref)
    except ImportError as err:
        msg = str(err)
        log("Muat %s gagal: %s" % (ref, msg[:200]))
        if AUTO_INSTALL and "gptqmodel" in msg.lower():
            log("Menginstal gptqmodel (perlu untuk AWQ di transformers sistem Kaggle)...")
            pip_install("gptqmodel")
            return _build(ref)   # masih gagal -> biarkan exception naik, tanpa diam-diam ganti bobot
        raise


def prep_image(src_path, dst_dir, idx):
    """Turunkan resolusi sebelum inference. Biaya vision-token Qwen tumbuh dengan
    jumlah patch, dan frame dari pipeline sudah 1080p - percuma dikirim mentah."""
    from PIL import Image
    with Image.open(src_path) as im:
        im = im.convert("RGB")
        w, h = im.size
        scale = min(1.0, float(MAX_SIDE) / max(w, h))
        if scale < 1.0:
            im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))))
        out = os.path.join(dst_dir, "f%03d.jpg" % idx)
        im.save(out, "JPEG", quality=88)
    return out


def extract_json(text):
    r"""Model kadang menambah prolog walau dilarang. Ambil objek JSON pertama yang sah.

    PENTING: jangan pakai greedy regex r"\{.*\}" karena model Qwen kadang menuliskan
    komentar atau kalimat tambahan dalam tanda kurung kurawal SETELAH blok JSON utama.
    Greedy regex akan menangkap dari '{' pertama sampai '}' PALING AKHIR, melampaui
    batas JSON yang valid dan membuat json.loads gagal. Solusi: bracket balancing.

    Balancing-nya HARUS sadar-string: terukur 2026-10-03, versi yang hanya menghitung
    kurung membuat vonis dengan reason berisi '}' (mis. "teks } aneh") jadi None, padahal
    regex lama masih menanganinya. Itu memindahkan kegagalan dari 'ada prolog' ke 'reason
    normal' - dua-duanya tidak boleh terjadi, jadi tanda kutip dan backslash ikut dilacak.
    """
    if not text:
        return None
    for m in re.finditer(r"\{", text):
        start = m.start()
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            c = text[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except Exception:
                        break  # bukan JSON valid, lanjut ke '{' berikutnya
    return None


VERDICT_KEYS = ("safe", "face", "text", "watermark", "graphic")


def ask(model, processor, torch, image_paths, prompt):
    from qwen_vl_utils import process_vision_info
    content = [{"type": "image", "image": "file://" + p} for p in image_paths]
    content.append({"type": "text", "text": prompt})
    messages = [{"role": "user", "content": content}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    images, videos = process_vision_info(messages)
    inputs = processor(text=[text], images=images, videos=videos, padding=True,
                       return_tensors="pt").to(model.device)
    with torch.inference_mode():
        gen = model.generate(**inputs, max_new_tokens=MAX_NEW_TOKENS,
                             do_sample=False, temperature=None, top_p=None)
    trimmed = gen[:, inputs["input_ids"].shape[1]:]
    raw = processor.batch_decode(trimmed, skip_special_tokens=True,
                                 clean_up_tokenization_spaces=False)[0].strip()
    del inputs, gen, trimmed
    return raw, extract_json(raw)


def fetch_frames_raw(payload):
    """Unduh seluruh JPEG batch lewat tunnel (tanpa preprocessing).

    Dipakai jalur NO_MODEL: claim + report saja tidak cukup membuktikan apa pun, karena
    justru pengambilan frame yang bisa gagal diam-diam (allowlist path di sisi server,
    file sementara job yang sudah dibersihkan, tunnel putus). Yang dikembalikan hanya
    (index, jumlah byte) - isi frame tidak pernah dicetak ke log.
    """
    batch_dir = os.path.join(TMP_ROOT, payload["batchId"])
    os.makedirs(batch_dir, exist_ok=True)
    sess = requests.Session()
    sess.headers.update({"x-api-token": TOKEN})
    got = []
    for fr in payload["frames"]:
        r = sess.get(BASE_URL + fr["url"], timeout=120)
        if r.status_code != 200:
            raise RuntimeError("frame %s -> HTTP %s" % (fr["url"], r.status_code))
        raw = os.path.join(batch_dir, "raw%03d.jpg" % int(fr["index"]))
        with open(raw, "wb") as fh:
            fh.write(r.content)
        got.append((int(fr["index"]), len(r.content)))
    shutil.rmtree(batch_dir, ignore_errors=True)
    return got


def verdict_batch(payload, model, processor, torch):
    """Satu batch -> verdict. Hemat GPU: satu panggilan multi-frame dulu. Hanya
    kalau batch dinyatakan KOTOR kita panggil per-frame untuk menemukan frame mana
    yang kotor (batch bersih - mayoritas kasus - selesai dalam satu panggilan)."""
    batch_dir = os.path.join(TMP_ROOT, payload["batchId"])
    os.makedirs(batch_dir, exist_ok=True)
    paths = []
    sess = requests.Session()
    sess.headers.update({"x-api-token": TOKEN})
    for fr in payload["frames"]:
        url = BASE_URL + fr["url"]
        r = sess.get(url, timeout=120)
        if r.status_code != 200:
            raise RuntimeError("frame %s -> HTTP %s" % (fr["url"], r.status_code))
        raw = os.path.join(batch_dir, "raw%03d.jpg" % int(fr["index"]))
        with open(raw, "wb") as fh:
            fh.write(r.content)
        paths.append((int(fr["index"]), prep_image(raw, batch_dir, int(fr["index"]))))

    prompt = payload.get("prompt") or "Inspect ALL frames. Answer ONLY JSON {\"safe\":true|false}"
    t0 = time.time()
    raw_txt, obj = ask(model, processor, torch, [p for _, p in paths], prompt)
    dt = time.time() - t0
    if obj is None:
        raise RuntimeError("output model tidak bisa di-parse: %r" % raw_txt[:200])

    out = {k: bool(obj.get(k, False)) for k in VERDICT_KEYS}
    out["safe"] = bool(obj.get("safe", True))
    out["reason"] = str(obj.get("reason", ""))[:280]
    # `model` = label bobot yang benar-benar dimuat (bukan MODEL_ID mentah): kalau bobot
    # datang dari mount lokal, namanya ikut tercatat di sini. `device`/`dtype` ditambahkan
    # supaya angka recall/false-reject bisa ditelusuri ke PERANGKAT yang memproduksinya -
    # vonis dari CPU dan dari T4 tidak boleh menyatu di satu tabel tanpa jejak.
    out["model"] = MODEL_LABEL
    out["device"] = "%s|%s" % (DEVICE_INFO.get("name", ""), DEVICE_INFO.get("dtype", ""))
    out["elapsedMs"] = int(dt * 1000)

    # Refine per-frame bila ada TANDA kotor apa pun, bukan hanya saat safe:false.
    # Hilir (`normalizeOracleVerdict`) memveto ketika `safe:false` ATAU salah satu flag menyala,
    # dan model kecil sering menulis safe:true SAMBIL menyalakan text/watermark. Kalau refine
    # hanya jalan saat safe:false, veto berbasis flag tidak pernah punya bukti per-frame dan
    # worker lokal menghitamkan SELURUH batch (terukur 2026-10-03: 2 dari 5 frame yang
    # divonis bersih oleh gatekeeper lokal ikut tertolak). Biaya tambahan hanya untuk batch
    # yang memang dicurigai: <= N inferensi satu-frame.
    any_flag = any(out[k] for k in ("face", "text", "watermark", "graphic"))
    if (not out["safe"] or any_flag) and len(paths) > 1:
        per_frame = []
        for idx, one in paths:
            _, obj1 = ask(model, processor, torch, [one], prompt)
            if obj1 is None:
                # Gagal parse = tidak tahu = jangan lepas veto. Tandai frame INI saja yang
                # kotor supaya veto tidak merata ke seluruh batch karena satu frame saja.
                per_frame.append({"index": idx, "safe": False,
                                  "face": False, "text": False, "watermark": False, "graphic": False})
                continue
            per_frame.append({
                "index": idx,
                "safe": bool(obj1.get("safe", True)),
                "face": bool(obj1.get("face", False)),
                "text": bool(obj1.get("text", False)),
                "watermark": bool(obj1.get("watermark", False)),
                "graphic": bool(obj1.get("graphic", False)),
            })
        if per_frame:
            out["perFrame"] = per_frame
            out["safe"] = all(f["safe"] for f in per_frame)
            # Flag agregat diturunkan dari bukti per-frame, bukan tebakan satu panggilan.
            for k in ("face", "text", "watermark", "graphic"):
                out[k] = any(f[k] for f in per_frame)
            out["elapsedMs"] = int((time.time() - t0) * 1000)
    shutil.rmtree(batch_dir, ignore_errors=True)
    return out


def post_result(batch_id, verdict=None, error=""):
    body = {"batchId": batch_id}
    if verdict is not None:
        body["verdict"] = verdict
    if error:
        body["error"] = error[:400]
    r = requests.post(BASE_URL + "/api/vlm-oracle/result", json=body,
                      headers={"x-api-token": TOKEN}, timeout=60)
    if r.status_code == 409:
        log("batch %s sudah kadaluarsa di sisi worker - vonis tidak dipakai (normal saat jaringan lambat)." % batch_id)
    elif r.status_code == 404:
        log("batch %s sudah di-prune worker." % batch_id)
    elif r.status_code >= 400:
        log("REPORT GAGAL %s: %s" % (r.status_code, r.text[:200]))
    return r.status_code


def main():
    if not BASE_URL:
        raise SystemExit(
            "URL lokal belum diketahui. Isi lewat salah satu: (a) dataset privat "
            "clippervps-oracle-config -> oracle_config.json {\"base_url\": \"https://xxx.trycloudflare.com\"} "
            "(dibuat oleh kaggle/deploy.ps1 -TunnelUrl ...), atau (b) env var VLM_ORACLE_BASE_URL."
        )
    token = TOKEN or read_token_from_file()
    if not token:
        # Sengaja berhenti, bukan jalan tanpa token: server menolak 503 dan kita
        # hanya membakar kuota GPU untuk permintaan yang pasti ditolak.
        raise SystemExit(
            "API_ACCESS_TOKEN kosong. Isi di oracle_config.json (key api_access_token) lewat "
            "kaggle/deploy.ps1 -TunnelUrl ... -WithToken, atau env var API_ACCESS_TOKEN di Kaggle."
        )
    log("Base URL siap. Token: %d karakter (tidak ditampilkan). Model: %s (SATU bobot, tanpa fallback). "
        "GPU wajib=%s|NO_MODEL=%s|max=%.0f menit"
        % (len(token), MODEL_ID.split("/")[-1], REQUIRE_GPU, NO_MODEL, MAX_MINUTES))

    model = processor = torch = None
    if not NO_MODEL:
        ensure_deps()
        # Cek lagi sebelum claim: kalau modul ini tetap hilang, lebih baik sesi mati sekarang
        # daripada mengklaim batch lalu mengirim error untuk setiap batch (kuota GPU terpakai,
        # vonis nol - persis kegagalan sesi sebelumnya).
        try:
            import qwen_vl_utils  # noqa: F401
        except ImportError as err:
            raise SystemExit("qwen_vl_utils tidak tersedia setelah pip install: %s" % err)
        model, processor, torch = load_model()

    idle = POLL_SEC
    done = failed = 0
    bid = None
    while (time.time() - START) / 60.0 < MAX_MINUTES:
        try:
            bid = None
            r = requests.post(BASE_URL + "/api/vlm-oracle/claim",
                              json={"workerId": "kaggle-notebook"},
                              headers={"x-api-token": token}, timeout=60)
            if r.status_code == 503:
                raise SystemExit("Server menolak (503): API_ACCESS_TOKEN belum diset di server/.env. Set lalu restart server.")
            if r.status_code == 429:
                time.sleep(20)
                continue
            if r.status_code >= 400:
                log("CLAIM error %s: %s" % (r.status_code, r.text[:200]))
                time.sleep(idle)
                continue
            data = r.json()
            if not data.get("claimed"):
                idle = min(IDLE_SLEEP_MAX, idle * 1.6)
                time.sleep(idle)
                continue
            idle = POLL_SEC
            bid = data["batchId"]
            log("claim %s (%d frame, job=%s scene=%s)" % (bid, len(data["frames"]), data.get("jobId"), data.get("sceneIdx")))
            if NO_MODEL:
                # Dry-run tetap MENGUNDUH frame: itu bagian yang paling mungkin pecah
                # (allowlist path + usia file + tunnel), dan gratis di sisi GPU.
                try:
                    got = fetch_frames_raw(data)
                    kb = sum(b for _, b in got) / 1024.0
                    log("  dry-run: %d/%d frame diunduh, total %.0f KB (rata-rata %.0f KB/frame)"
                        % (len(got), len(data["frames"]), kb, (kb / max(1, len(got)))))
                    post_result(bid, {"safe": True, "model": "dry-run"})
                except Exception as dl_err:
                    log("  dry-run GAGAL unduh frame: %s" % dl_err)
                    post_result(bid, None, error=str(dl_err))
                    failed += 1
                done += 1
                continue
            v = verdict_batch(data, model, processor, torch)
            post_result(bid, v)
            done += 1
            log("  -> safe=%s flags=%s %dms" % (v["safe"],
                ",".join(k for k in ("face", "text", "watermark", "graphic") if v.get(k)) or "-",
                v.get("elapsedMs", 0)))
        except SystemExit:
            raise
        except KeyboardInterrupt:
            break
        except Exception as err:  # jangan matikan looping untuk satu batch rusak
            failed += 1
            log("batch gagal: %s" % err)
            if bid:
                try:
                    post_result(bid, None, error=str(err))
                except Exception:
                    pass
                shutil.rmtree(os.path.join(TMP_ROOT, bid), ignore_errors=True)
            time.sleep(min(IDLE_SLEEP_MAX, idle))
    shutil.rmtree(TMP_ROOT, ignore_errors=True)
    log("Selesai. vonis=%s gagal=%s durasi=%.1f menit." % (done, failed, (time.time() - START) / 60.0))


if __name__ == "__main__":
    main()
