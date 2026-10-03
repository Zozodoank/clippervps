# ============================================================================
# VLM ORACLE WORKER - sisi KAGGLE (model besar), sisi HTTP saja.
#
# PERAN: notebook ini TIDAK menjalankan pipeline. Ia hanya menjadi KLIEN dari
# API ClipperVPS Anda: claim batch frame -> unduh JPEG -> vonis dengan
# Qwen2.5-VL-7B-Instruct-AWQ -> kirim verdict -> ulangi. Arah koneksi dipaksa
# oleh kenyataan bahwa Kaggle tidak punya inbound; HP/PC Anda tidak pernah
# "menelepon" ke Kaggle. Kalau notebook ini mati, job lokal hanya kehilangan
# lapisan veto (fallback ke gatekeeper legacy) - tidak ada yang rusak.
#
# CARA PAKAI (ringkas, detail di README):
#   1. Kaggle > Settings > Environment variables, tambahkan:
#        VLM_ORACLE_BASE_URL  = https://<xxx>.trycloudflare.com   (tanpa slash akhir)
#        API_ACCESS_TOKEN     = <nilai yang SAMA dengan server/.env>
#      (atau upload kaggle.json sebagai "Kaggle API" input kalau Anda lebih suka
#       membaca token dari file - keduanya didukung, env lebih diprioritaskan.)
#   2. Accelerator: GPU T4 x2 (atau P100). Attach GitHub repo zozodoank/clippervps.
#   3. Jalankan cell di bawah. Notebook ini looping; hentikan manual atau ia exit
#      sendiri setelah ORACLE_MAX_MINUTES supaya tidak dipotong Kaggle di jam ke-12.
#
# Token NIKKIR (tidak pernah dicetak ke log) karena log notebook bisa ter-share.
# ============================================================================
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import requests

# ------------------------------------------------------------------ KONFIG ---
BASE_URL = (os.getenv("VLM_ORACLE_BASE_URL") or os.getenv("ORACLE_BASE_URL") or "").rstrip("/")
TOKEN = os.getenv("API_ACCESS_TOKEN") or os.getenv("VLM_ORACLE_API_TOKEN") or ""
MODEL_ID = os.getenv("ORACLE_MODEL_ID", "qwen/Qwen2.5-VL-7B-Instruct-AWQ")
POLL_SEC = float(os.getenv("ORACLE_POLL_SEC", "5"))
IDLE_SLEEP_MAX = float(os.getenv("ORACLE_IDLE_SLEEP_MAX", "30"))
MAX_MINUTES = float(os.getenv("ORACLE_MAX_MINUTES", "690"))   # < 12 jam Kaggle
MAX_SIDE = int(os.getenv("ORACLE_MAX_SIDE", "1024"))          # turun sebelum inference
MAX_NEW_TOKENS = int(os.getenv("ORACLE_MAX_NEW_TOKENS", "160"))
AUTO_INSTALL = os.getenv("ORACLE_AUTO_INSTALL", "1") == "1"
# Set 1 untuk menguji sambungan (claim/report) TANPA memuat model - berguna untuk
# memvalidasi tunnel + token sebelum menghabiskan kuota GPU.
NO_MODEL = os.getenv("ORACLE_NO_MODEL", "0") == "1"

START = time.time()
TMP_ROOT = tempfile.mkdtemp(prefix="oracle_frames_")


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
    try:
        import transformers  # noqa: F401
        return
    except ImportError:
        pass
    if not AUTO_INSTALL:
        raise SystemExit("transformers belum terpasang; set ORACLE_AUTO_INSTALL=1 atau install manual.")
    log("Menginstal dependensi (sekali per sesi)...")
    # subprocess + argumen list (BUKAN string ke shell): tidak ada interpreasi shell,
    # jadi nilai env/user tidak bisa menyuntik perintah.
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "-q", "--no-warn-conflicts",
         "transformers==4.49.0", "accelerate", "qwen-vl-utils[decord]==0.0.8",
         "autoawq", "autoawq-kernels", "av"],
        check=False,
    )
    time.sleep(3)  # beri kesempatan filesystem sinkron


def load_model():
    """Muat Qwen2.5-VL sekali per proses. Bobot AWQ ~7-8 GB, aman di T4 16 GB."""
    import torch
    from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

    log("Memuat %s ..." % MODEL_ID)
    t0 = time.time()
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL_ID,
        torch_dtype="auto",
        device_map="auto",
        # sdpa menghindari kebutuhan flash-attention yang sering gagal build di Kaggle.
        attn_implementation="sdpa",
    )
    model.eval()
    processor = AutoProcessor.from_pretrained(
        MODEL_ID, min_pixels=256 * 28 * 28, max_pixels=1280 * 28 * 28)
    log("Model siap dalam %.0fs." % (time.time() - t0))
    return model, processor, torch


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
    """Model kadang menambah prolog walau dilarang. Ambil objek JSON pertama yang sah."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
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
    out["model"] = MODEL_ID.split("/")[-1]
    out["elapsedMs"] = int(dt * 1000)

    if not out["safe"] and len(paths) > 1:
        # Refine per-frame supaya worker lokal hanya memveto frame yang benar-benar kotor.
        per_frame = []
        for idx, one in paths:
            _, obj1 = ask(model, processor, torch, [one], prompt)
            if obj1 is None:
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
        raise SystemExit("Set VLM_ORACLE_BASE_URL (contoh https://xxx.trycloudflare.com).")
    token = TOKEN or read_token_from_file()
    if not token:
        # Sengaja berhenti, bukan jalan tanpa token: server menolak 503 dan kita
        # hanya membakar kuota GPU untuk permintaan yang pasti ditolak.
        raise SystemExit("API_ACCESS_TOKEN kosong. Isi lewat Kaggle Secrets (env var) lalu restart notebook.")
    log("Base URL siap. Token: %d karakter (tidak ditampilkan). NO_MODEL=%s" % (len(token), NO_MODEL))

    model = processor = torch = None
    if not NO_MODEL:
        ensure_deps()
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
                post_result(bid, {"safe": True, "model": "dry-run"})
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
