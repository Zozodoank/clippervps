import os
import json
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import requests
import base64

def get_source_hash():
    try:
        with open(__file__, "rb") as fh:
            return hashlib.md5(fh.read()).hexdigest()
    except Exception:
        return "unknown"

SOURCE_HASH = get_source_hash()
ORACLE_PROTOCOL_VERSION = "2026-10-06-grid-v1"
WORKER_ID = "local-vps"

# ------------------------------------------------------------------ KONFIG ---
BASE_URL = (os.environ.get("ORACLE_BASE_URL") or "http://127.0.0.1:5000").rstrip("/")
TOKEN = os.environ.get("ORACLE_TOKEN") or os.environ.get("API_ACCESS_TOKEN") or ""
LLAMA_SERVER_URL = (os.environ.get("LLAMA_SERVER_URL") or "http://127.0.0.1:8080/v1").rstrip("/")
NO_MODEL = os.environ.get("ORACLE_NO_MODEL", "0") == "1"

POLL_SEC = 2.0
IDLE_SLEEP_MAX = 10.0
MAX_SIDE = 1024
MAX_NEW_TOKENS = 128

START = time.time()
TMP_ROOT = tempfile.mkdtemp(prefix="oracle_frames_")
MODEL_LABEL = "qwen2.5-vl-3b-instruct (llama.cpp)"
DEVICE_INFO = {"cuda": False, "name": "llama-server", "device": "local", "dtype": "gguf"}


def log(msg):
    print("[%7.1fs] %s" % (time.time() - START, msg), flush=True)


def prep_image(src_path, dst_dir, idx):
    """Turunkan resolusi sebelum inference."""
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


def looks_degenerate(text):
    if not text:
        return True
    stripped = text.strip()
    if len(stripped) < 2:
        return True
    unique = len(set(stripped))
    if unique <= 2 and len(stripped) >= 20:
        return True
    if "{" not in stripped:
        return True
    return False


def extract_json(text):
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
                        break
    return None


VERDICT_KEYS = ("safe", "face", "text", "watermark", "graphic")


def resolve_grid_cell_verdicts(expected_by_id, reported, infer_missing):
    verdict_by_id = {}
    for entry in reported if isinstance(reported, list) else []:
        if not isinstance(entry, dict) or not str(entry.get("index", "")).lstrip("-").isdigit():
            continue
        cell_id = int(entry["index"])
        if cell_id in expected_by_id and cell_id not in verdict_by_id:
            verdict_by_id[cell_id] = dict(entry)
    for cell_id in sorted(set(expected_by_id) - set(verdict_by_id)):
        try:
            entry = infer_missing(cell_id, expected_by_id[cell_id])
            if not isinstance(entry, dict):
                raise TypeError("single-cell inference did not return an object")
            entry = dict(entry)
            entry["index"] = cell_id
            entry.setdefault("verified", True)
            verdict_by_id[cell_id] = entry
        except Exception as err:
            verdict_by_id[cell_id] = {
                "index": cell_id, "safe": True, "verified": False,
                "face": False, "text": False, "watermark": False,
                "graphic": False, "reason": ("Cell belum terverifikasi: %s" % str(err))[:280],
            }
    return [verdict_by_id[cell_id] for cell_id in sorted(expected_by_id)]


def wants_ranking(prompt):
    return "matchScore" in (prompt or "")


def clamp_score(value):
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return max(0, min(100, int(round(n))))


def median_int(values):
    nums = sorted(v for v in (clamp_score(x) for x in values) if v is not None)
    if not nums:
        return None
    mid = len(nums) // 2
    if len(nums) % 2:
        return nums[mid]
    return int(round((nums[mid - 1] + nums[mid]) / 2.0))


def ask(image_paths, prompt):
    """POST to llama-server (OpenAI compatible)"""
    content = []
    for p in image_paths:
        with open(p, "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("utf-8")
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{b64}"}
        })
    content.append({"type": "text", "text": prompt})

    payload = {
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "max_tokens": MAX_NEW_TOKENS,
    }

    resp = requests.post(
        f"{LLAMA_SERVER_URL}/chat/completions",
        json=payload,
        timeout=120
    )
    if resp.status_code != 200:
        raise RuntimeError(f"llama-server error: HTTP {resp.status_code} - {resp.text}")
    
    data = resp.json()
    raw = data["choices"][0]["message"]["content"].strip()
    degenerate = looks_degenerate(raw)
    obj = extract_json(raw) if not degenerate else None
    return raw, obj, degenerate


def fetch_frames_raw(payload):
    batch_dir = os.path.join(TMP_ROOT, payload["batchId"])
    os.makedirs(batch_dir, exist_ok=True)
    sess = requests.Session()
    sess.headers.update({"x-api-token": TOKEN, "ngrok-skip-browser-warning": "69420"})
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


def verdict_batch(payload):
    batch_dir = os.path.join(TMP_ROOT, payload["batchId"])
    os.makedirs(batch_dir, exist_ok=True)
    paths = []
    sess = requests.Session()
    sess.headers.update({"x-api-token": TOKEN, "ngrok-skip-browser-warning": "69420"})
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
    grid_mode = any(isinstance(fr.get("cells"), list) and fr["cells"] for fr in payload.get("frames", []))
    t0 = time.time()
    
    frame_indexes = [str(idx) for idx, _ in paths]
    log("[Oracle][Batch] batchId=%s frames=%d indexes=[%s]" % (payload["batchId"], len(paths), ",".join(frame_indexes)))

    # ATTEMPT A: Normal
    raw_txt, obj, deg = ask([p for _, p in paths], prompt)
    log("[Oracle][Generation] batchId=%s rawLength=%d uniqueCharCount=%d degenerate=%s parseSuccess=%s" % 
        (payload["batchId"], len(raw_txt), len(set(raw_txt)), deg, obj is not None))
    
    if obj is None:
        log("[Oracle][Recovery] batchId=%s strategy=prompt_retry attempt=1" % payload["batchId"])
        compact_prompt = "Return ONLY valid JSON. No markdown. No explanations.\n{\"safe\":true,\"face\":false,\"text\":false,\"watermark\":false,\"graphic\":false"
        if wants_ranking(prompt):
            compact_prompt += ",\"productMatch\":true,\"matchScore\":80,\"apparentQuality\":80}"
        else:
            compact_prompt += "}"
        raw_txt, obj, deg = ask([p for _, p in paths], compact_prompt)
        log("[Oracle][Generation] batchId=%s rawLength=%d uniqueCharCount=%d degenerate=%s parseSuccess=%s" % 
            (payload["batchId"], len(raw_txt), len(set(raw_txt)), deg, obj is not None))
            
    if obj is None and len(paths) >= 2:
        log("[Oracle][Recovery] batchId=%s strategy=split2 attempt=2" % payload["batchId"])
        obj = {"safe": True, "face": False, "text": False, "watermark": False, "graphic": False}
        if wants_ranking(prompt):
            obj.update({"productMatch": True, "matchScore": 80, "apparentQuality": 80})
            
        chunks = [paths[i:i + 2] for i in range(0, len(paths), 2)]
        all_success = True
        chunk_objs = []
        for chunk in chunks:
            raw_c, c_obj, deg_c = ask([p for _, p in chunk], prompt)
            log("[Oracle][Generation] batchId=%s chunkLen=%d rawLength=%d uniqueCharCount=%d degenerate=%s parseSuccess=%s" % 
                (payload["batchId"], len(chunk), len(raw_c), len(set(raw_c)), deg_c, c_obj is not None))
            if c_obj is None:
                all_success = False
                break
            chunk_objs.append(c_obj)
            
        if all_success:
            obj["safe"] = all(c.get("safe", True) for c in chunk_objs)
            for k in VERDICT_KEYS:
                if k != "safe":
                    obj[k] = any(c.get(k, False) for c in chunk_objs)
            if wants_ranking(prompt):
                obj["productMatch"] = any(c.get("productMatch", True) for c in chunk_objs)
                obj["matchScore"] = median_int([c.get("matchScore") for c in chunk_objs])
                obj["apparentQuality"] = median_int([c.get("apparentQuality") for c in chunk_objs])
            reasons = [str(c.get("reason", "")) for c in chunk_objs if c.get("reason")]
            if reasons:
                obj["reason"] = " | ".join(reasons)
        else:
            obj = None
            
    if obj is None:
        log("[Oracle][Recovery] batchId=%s strategy=single_frame attempt=3" % payload["batchId"])
        obj = {"safe": False, "reason": "Recovery to single-frame", "face": True}

    dt = time.time() - t0

    out = {k: bool(obj.get(k, False)) for k in VERDICT_KEYS}
    out["safe"] = bool(obj.get("safe", True))
    out["reason"] = str(obj.get("reason", ""))[:280]
    ranking = wants_ranking(prompt)
    out["model"] = MODEL_LABEL
    out["device"] = "%s|%s" % (DEVICE_INFO.get("name", ""), DEVICE_INFO.get("dtype", ""))
    out["elapsedMs"] = int(dt * 1000)

    if ranking:
        out["productMatch"] = bool(obj.get("productMatch", True))
        out["matchScore"] = clamp_score(obj.get("matchScore"))
        out["apparentQuality"] = clamp_score(obj.get("apparentQuality"))

    any_flag = any(out[k] for k in ("face", "text", "watermark", "graphic"))
    if grid_mode:
        from PIL import Image
        reported = obj.get("perFrame") if isinstance(obj.get("perFrame"), list) else []
        expected_by_id = {int(cell["index"]): (frame, cell) for frame in payload["frames"]
                          for cell in (frame.get("cells") or [])
                          if isinstance(cell, dict) and str(cell.get("index", "")).lstrip("-").isdigit()}
        raw_by_grid = {int(fr["index"]): os.path.join(batch_dir, "raw%03d.jpg" % int(fr["index"]))
                       for fr in payload["frames"]}
        log("[Oracle][Grid] batchId=%s expectedCells=%d reportedCells=%d missing=%s" % (
            payload["batchId"], len(expected_by_id), len({int(e["index"]) for e in reported
                if isinstance(e, dict) and str(e.get("index", "")).lstrip("-").isdigit()
                and int(e["index"]) in expected_by_id}), sorted(set(expected_by_id) - {
                int(e["index"]) for e in reported if isinstance(e, dict)
                and str(e.get("index", "")).lstrip("-").isdigit() and int(e["index"]) in expected_by_id})))

        def infer_grid_cell(cell_id, location):
            grid_index, cell = location
            raw_grid = raw_by_grid.get(grid_index)
            if not raw_grid or not os.path.isfile(raw_grid):
                raise RuntimeError("file grid sumber tidak ditemukan")
            with Image.open(raw_grid) as grid_image:
                grid_image = grid_image.convert("RGB")
                w, h = grid_image.size
                col, row = int(cell.get("cell", 0)) % 2, int(cell.get("cell", 0)) // 2
                left, top = col * (w // 2), row * (h // 2)
                right = (col + 1) * (w // 2) if col == 0 else w
                bottom = (row + 1) * (h // 2) if row == 0 else h
                crop_path = os.path.join(batch_dir, "cell_%03d.jpg" % cell_id)
                grid_image.crop((left, top, right, bottom)).save(crop_path, "JPEG", quality=92)
            single_prompt = prompt.split("\nGRID INSTRUCTIONS:", 1)[0]
            single_prompt += ("\nInspect this ONE cropped source frame independently. ")
            single_prompt += ("Respond with one JSON object containing safe, face, text, watermark, graphic, and reason. ")
            single_prompt += ("Do not infer this frame's verdict from neighboring frames.")
            _, cell_obj, cell_degenerate = ask([crop_path], single_prompt)
            if cell_obj is None:
                raise RuntimeError("output crop tidak dapat diparse (degenerate=%s)" % cell_degenerate)
            frame_verdict = {
                "index": cell_id,
                "safe": bool(cell_obj.get("safe", True)),
                "face": bool(cell_obj.get("face", False)),
                "text": bool(cell_obj.get("text", False)),
                "watermark": bool(cell_obj.get("watermark", False)),
                "graphic": bool(cell_obj.get("graphic", False)),
                "reason": str(cell_obj.get("reason", ""))[:280],
            }
            if ranking:
                frame_verdict.update({
                    "productMatch": bool(cell_obj.get("productMatch", True)),
                    "matchScore": clamp_score(cell_obj.get("matchScore")),
                    "apparentQuality": clamp_score(cell_obj.get("apparentQuality")),
                })
            log("[Oracle][Grid] batchId=%s cell=%d verified by individual crop" % (payload["batchId"], cell_id))
            return frame_verdict

        out["perFrame"] = resolve_grid_cell_verdicts(expected_by_id, reported, infer_grid_cell)

        out["safe"] = all(bool(entry.get("safe", True)) for entry in out["perFrame"])
        for key in ("face", "text", "watermark", "graphic"):
            out[key] = any(bool(entry.get(key, False)) for entry in out["perFrame"])
        if ranking:
            out["productMatch"] = any(bool(entry.get("productMatch", False)) for entry in out["perFrame"])
            out["matchScore"] = median_int([entry.get("matchScore") for entry in out["perFrame"]])
            out["apparentQuality"] = median_int([entry.get("apparentQuality") for entry in out["perFrame"]])
    elif (not out["safe"] or any_flag) and len(paths) > 1:
        per_frame = []
        for idx, one in paths:
            raw1, obj1, deg1 = ask([one], prompt)
            if obj1 is None:
                entry = {"index": idx, "safe": True, "verified": False,
                         "face": False, "text": False, "watermark": False, "graphic": False, "reason": "Gagal parse output model"}
                if ranking:
                    entry["productMatch"] = None
                    entry["matchScore"] = None
                    entry["apparentQuality"] = None
                per_frame.append(entry)
                continue
            frame_verdict = {
                "index": idx,
                "safe": bool(obj1.get("safe", True)),
                "face": bool(obj1.get("face", False)),
                "text": bool(obj1.get("text", False)),
                "watermark": bool(obj1.get("watermark", False)),
                "graphic": bool(obj1.get("graphic", False)),
                "reason": str(obj1.get("reason", ""))[:280],
            }
            if ranking:
                frame_verdict["productMatch"] = bool(obj1.get("productMatch", True))
                frame_verdict["matchScore"] = clamp_score(obj1.get("matchScore"))
                frame_verdict["apparentQuality"] = clamp_score(obj1.get("apparentQuality"))
            per_frame.append(frame_verdict)
        if per_frame:
            if all(f.get("reason") == "Gagal parse output model" for f in per_frame):
                raise RuntimeError("Seluruh recovery inferensi gagal (output degeneratif/tidak bisa diparse).")
            out["perFrame"] = per_frame
            out["safe"] = all(f["safe"] for f in per_frame)
            dirty_reasons = [f.get("reason", "") for f in per_frame if (not f["safe"] or f["face"] or f["text"] or f["watermark"] or f["graphic"]) and f.get("reason")]
            if dirty_reasons:
                out["reason"] = " | ".join(dirty_reasons)[:280]
            for k in ("face", "text", "watermark", "graphic"):
                out[k] = any(f[k] for f in per_frame)
            if ranking:
                out["matchScore"] = median_int([f.get("matchScore") for f in per_frame])
                if out["matchScore"] is None:
                    out["matchScore"] = clamp_score(obj.get("matchScore"))
                out["apparentQuality"] = median_int([f.get("apparentQuality") for f in per_frame])
                if out["apparentQuality"] is None:
                    out["apparentQuality"] = clamp_score(obj.get("apparentQuality"))
                matches = [f.get("productMatch") for f in per_frame if f.get("productMatch") is not None]
                out["productMatch"] = any(matches) if matches else bool(obj.get("productMatch", True))
            out["elapsedMs"] = int((time.time() - t0) * 1000)
    shutil.rmtree(batch_dir, ignore_errors=True)
    return out


def post_result(batch_id, attempt=0, verdict=None, error=""):
    if verdict is not None:
        if not isinstance(verdict, dict):
            error = "Vonis bukan dict/object: %s" % str(type(verdict))
            verdict = None
        elif "safe" not in verdict and "perFrame" not in verdict:
            error = "Vonis dict tidak memiliki safe/perFrame: %s" % list(verdict.keys())
            verdict = None
    body = {"batchId": batch_id, "attempt": attempt, "workerId": WORKER_ID, "protocolVersion": ORACLE_PROTOCOL_VERSION}
    if verdict is not None:
        body["verdict"] = verdict
    if error:
        body["error"] = error[:400]
    for i in range(5):
        try:
            r = requests.post(BASE_URL + "/api/vlm-oracle/result", json=body,
                              headers={"x-api-token": TOKEN, "ngrok-skip-browser-warning": "69420"}, timeout=60)
            if r.status_code == 409:
                log("batch %s sudah kadaluarsa di sisi worker - vonis tidak dipakai." % batch_id)
                return r.status_code
            elif r.status_code == 404:
                log("batch %s sudah di-prune worker." % batch_id)
                return r.status_code
            elif r.status_code >= 400:
                log("REPORT GAGAL %s: %s (percobaan %d)" % (r.status_code, r.text[:200], i + 1))
                if r.status_code in (502, 503, 504):
                    time.sleep(3 + i * 2)
                    continue
                return r.status_code
            return r.status_code
        except Exception as e:
            log("REPORT exception: %s (percobaan %d)" % (e, i + 1))
            time.sleep(3 + i * 2)
    return 500


def main():
    if not TOKEN:
        raise SystemExit(
            "API_ACCESS_TOKEN kosong. Isi env var ORACLE_TOKEN atau API_ACCESS_TOKEN."
        )
    log("Base URL: %s | LLAMA_SERVER_URL: %s | NO_MODEL: %s" % (BASE_URL, LLAMA_SERVER_URL, NO_MODEL))

    idle = POLL_SEC
    done = failed = 0
    bid = None
    consecutive_errors = 0
    while True:
        try:
            bid = None
            r = requests.post(BASE_URL + "/api/vlm-oracle/claim",
                              json={"workerId": WORKER_ID, "protocolVersion": ORACLE_PROTOCOL_VERSION, "sourceHash": SOURCE_HASH},
                              headers={"x-api-token": TOKEN, "ngrok-skip-browser-warning": "69420"}, timeout=60)
            if r.status_code == 503:
                raise SystemExit("Server menolak (503): API_ACCESS_TOKEN salah.")
            if r.status_code >= 400:
                log("CLAIM error %s: %s" % (r.status_code, r.text[:200]))
                consecutive_errors += 1
                time.sleep(idle)
                continue
            data = r.json()
            consecutive_errors = 0
            if not data.get("claimed"):
                idle = min(IDLE_SLEEP_MAX, idle * 1.6)
                time.sleep(idle)
                continue
            idle = POLL_SEC
            bid = data["batchId"]
            log("claim %s (%d frame, job=%s scene=%s)" % (bid, len(data["frames"]), data.get("jobId"), data.get("sceneIdx")))
            if NO_MODEL:
                try:
                    got = fetch_frames_raw(data)
                    kb = sum(b for _, b in got) / 1024.0
                    log("  dry-run: %d/%d frame diunduh, total %.0f KB" % (len(got), len(data["frames"]), kb))
                    post_result(bid, attempt=data.get("attempt", 0), verdict={"safe": True, "model": "dry-run"})
                except Exception as dl_err:
                    log("  dry-run GAGAL unduh frame: %s" % dl_err)
                    post_result(bid, attempt=data.get("attempt", 0), verdict=None, error=str(dl_err))
                    failed += 1
                done += 1
                continue
            v = verdict_batch(data)
            post_result(bid, attempt=data.get("attempt", 0), verdict=v)
            done += 1
            log("  -> safe=%s flags=%s %dms" % (v["safe"],
                ",".join(k for k in ("face", "text", "watermark", "graphic") if v.get(k)) or "-",
                v.get("elapsedMs", 0)))
        except SystemExit:
            raise
        except KeyboardInterrupt:
            break
        except Exception as err:
            failed += 1
            log("batch gagal: %s" % err)
            if bid:
                try:
                    post_result(bid, attempt=data.get("attempt", 0), verdict=None, error=str(err))
                except Exception:
                    pass
                shutil.rmtree(os.path.join(TMP_ROOT, bid), ignore_errors=True)
            time.sleep(min(IDLE_SLEEP_MAX, idle))
    shutil.rmtree(TMP_ROOT, ignore_errors=True)
    log("Selesai. vonis=%s gagal=%s durasi=%.1f menit." % (done, failed, (time.time() - START) / 60.0))

if __name__ == "__main__":
    main()
