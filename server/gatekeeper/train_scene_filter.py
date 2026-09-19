#!/usr/bin/env python3
"""
PyTorch Staged Fine-Tuning & ONNX Export Pipeline for ClipperVPS Scene Gatekeeper.
Fine-tunes MobileNetV3-Small binary classifier with hard-negative domain adaptation:
- Class 0: rejected   (watermarks, subtitles, banners, 2D cartoons, overlays, static bumpers, unboxing clutter)
- Class 1: valid_real (Clean live-action hands-on product demonstration)

Training Strategy:
- Stage 1: Freeze backbone, train classifier head (lr=1e-3)
- Stage 2: Unfreeze last 3 bottleneck blocks of MobileNetV3 (features[-3:]), fine-tune with low lr (1e-4)
- Loss: Class-weighted CrossEntropyLoss to handle dataset imbalance
- Validation: Tracks Confusion Matrix, Precision, Recall, Macro F1, with priority on Clean Precision
- Early Stopping: Prevents overfitting
- Export: scene_filter_v2.onnx (opset 17, verified with ONNXRuntime)
"""

import os
import sys
import time
import copy
import json
import shutil
import argparse

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

try:
    import torch
    import torch.nn as nn
    from torch.utils.data import DataLoader, Subset
    from torchvision import datasets, models, transforms
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    torch = None
    nn = None

try:
    import onnx
    import onnxruntime as ort
    HAS_ONNX = True
except ImportError:
    HAS_ONNX = False
    ort = None


def build_transforms():
    """
    Data augmentation designed specifically to preserve watermarks and subtle overlays.
    CRITICAL: Avoids aggressive random crops that would crop away corner watermarks
    and teach the model false labels!
    """
    train_transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.ColorJitter(brightness=0.15, contrast=0.15, saturation=0.15),
        transforms.RandomRotation(degrees=6),
        transforms.GaussianBlur(kernel_size=(3, 3), sigma=(0.1, 0.8)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
    ])

    val_transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
    ])

    return train_transform, val_transform


def compute_metrics(y_true, y_pred):
    """
    Menghitung Confusion Matrix dan Metrik Evaluasi:
    Class 0 = rejected
    Class 1 = valid_real (Clean)
    """
    tp = sum(1 for t, p in zip(y_true, y_pred) if t == 1 and p == 1)
    fp = sum(1 for t, p in zip(y_true, y_pred) if t == 0 and p == 1)  # Dirty frame labeled Clean (DANGEROUS!)
    tn = sum(1 for t, p in zip(y_true, y_pred) if t == 0 and p == 0)
    fn = sum(1 for t, p in zip(y_true, y_pred) if t == 1 and p == 0)

    clean_prec = tp / max(1, tp + fp)
    clean_rec = tp / max(1, tp + fn)
    clean_f1 = (2 * clean_prec * clean_rec) / max(1e-6, clean_prec + clean_rec)

    reject_prec = tn / max(1, tn + fn)
    reject_rec = tn / max(1, tn + fp)
    reject_f1 = (2 * reject_prec * reject_rec) / max(1e-6, reject_prec + reject_rec)

    accuracy = (tp + tn) / max(1, len(y_true))
    macro_f1 = (clean_f1 + reject_f1) / 2.0

    return {
        "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "accuracy": accuracy,
        "clean_precision": clean_prec,
        "clean_recall": clean_rec,
        "clean_f1": clean_f1,
        "reject_precision": reject_prec,
        "reject_recall": reject_rec,
        "reject_f1": reject_f1,
        "macro_f1": macro_f1
    }


def train_model(dataset_dir="dataset", stage1_epochs=5, stage2_epochs=8,
                batch_size=16, lr_stage1=0.001, lr_stage2=0.0001,
                output_onnx="scene_filter_v2.onnx", smoke_test=False):
    if not HAS_TORCH:
        print("❌ PyTorch tidak terdeteksi di lingkungan Python ini.")
        print("   Jalankan: pip install torch torchvision onnx onnxruntime")
        return

    train_dir = os.path.join(CURRENT_DIR, dataset_dir, "train")
    val_dir = os.path.join(CURRENT_DIR, dataset_dir, "val")

    if not os.path.exists(train_dir) or not os.path.exists(val_dir):
        print(f"❌ Direktori dataset tidak ditemukan di: {train_dir} dan {val_dir}")
        return

    train_tf, val_tf = build_transforms()
    train_dataset = datasets.ImageFolder(train_dir, transform=train_tf)
    val_dataset = datasets.ImageFolder(val_dir, transform=val_tf)

    classes = train_dataset.classes
    print(f"\n📂 [Dataset Loaded]")
    print(f"   Classes     : {classes} (0={classes[0]}, 1={classes[1]})")
    print(f"   Train count : {len(train_dataset)} images")
    print(f"   Val count   : {len(val_dataset)} images")

    # Smoke test mode: batasi sampel untuk pengujian kilat pipeline
    if smoke_test:
        print("🧪 [SMOKE TEST MODE] Menggunakan subset kecil untuk verifikasi cepat pipeline...")
        train_indices = list(range(min(16, len(train_dataset))))
        val_indices = list(range(min(16, len(val_dataset))))
        train_dataset = Subset(train_dataset, train_indices)
        val_dataset = Subset(val_dataset, val_indices)
        stage1_epochs = 1
        stage2_epochs = 1
        batch_size = 4

    num_workers = 0 if os.name == "nt" else 2
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True, num_workers=num_workers)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False, num_workers=num_workers)

    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    print(f"🚀 Device: {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'})")

    # ── Hitung Class Weighting untuk Weighted Loss ──
    # Mencegah model bias terhadap kelas mayoritas
    train_targets = [train_dataset[i][1] for i in range(len(train_dataset))]
    count_c0 = max(1, sum(1 for t in train_targets if t == 0))
    count_c1 = max(1, sum(1 for t in train_targets if t == 1))
    total_samples = count_c0 + count_c1

    w0 = total_samples / (2.0 * count_c0)
    w1 = total_samples / (2.0 * count_c1)
    class_weights = torch.tensor([w0, w1], dtype=torch.float).to(device)
    print(f"⚖️ [Class Weights] Class 0 (rejected): {w0:.2f} (count: {count_c0}) | Class 1 (valid_real): {w1:.2f} (count: {count_c1})")

    criterion = nn.CrossEntropyLoss(weight=class_weights)

    # ── Model Architecture: MobileNetV3-Small ──
    print("📦 Memuat backbone MobileNetV3-Small...")
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT)

    in_features = model.classifier[3].in_features
    model.classifier[3] = nn.Sequential(
        nn.Dropout(p=0.3),
        nn.Linear(in_features, 2)  # 0=rejected, 1=valid_real
    )
    model = model.to(device)

    best_model_wts = copy.deepcopy(model.state_dict())
    best_score = 0.0
    best_metrics = {}
    patience = 4
    no_improve_epochs = 0

    # ─────────────────────────────────────────────────────────────────────────
    # STAGE 1: FREEZE BACKBONE, TRAIN CLASSIFIER HEAD
    # ─────────────────────────────────────────────────────────────────────────
    print(f"\n=======================================================")
    print(f"🚀 STAGE 1: Classifier Head Training ({stage1_epochs} Epochs)")
    print(f"=======================================================")
    for param in model.features.parameters():
        param.requires_grad = False
    for param in model.classifier.parameters():
        param.requires_grad = True

    opt_s1 = torch.optim.Adam(model.classifier.parameters(), lr=lr_stage1, weight_decay=1e-4)

    for epoch in range(1, stage1_epochs + 1):
        model.train()
        running_loss = 0.0
        for inputs, labels in train_loader:
            inputs, labels = inputs.to(device), labels.to(device)
            opt_s1.zero_grad()
            outputs = model(inputs)
            loss = criterion(outputs, labels)
            loss.backward()
            opt_s1.step()
            running_loss += loss.item() * inputs.size(0)

        # Validation
        model.eval()
        y_true, y_pred = [], []
        with torch.no_grad():
            for inputs, labels in val_loader:
                inputs = inputs.to(device)
                outputs = model(inputs)
                _, preds = torch.max(outputs, 1)
                y_true.extend(labels.tolist())
                y_pred.extend(preds.cpu().tolist())

        m = compute_metrics(y_true, y_pred)
        train_loss = running_loss / len(train_dataset)

        # Score prioritas: 60% Clean Precision (hindari false clean) + 40% Macro F1
        composite_score = (m["clean_precision"] * 0.60) + (m["macro_f1"] * 0.40)
        print(f"  [Stage 1 | Ep {epoch:02d}/{stage1_epochs:02d}] Loss: {train_loss:.4f} | "
              f"Acc: {m['accuracy']*100:.1f}% | "
              f"Clean Prec: {m['clean_precision']*100:.1f}% Rec: {m['clean_recall']*100:.1f}% | "
              f"Macro F1: {m['macro_f1']*100:.1f}% | FP(Dirty->Clean): {m['fp']}")

        if composite_score >= best_score:
            best_score = composite_score
            best_model_wts = copy.deepcopy(model.state_dict())
            best_metrics = m

    # ─────────────────────────────────────────────────────────────────────────
    # STAGE 2: UNFREEZE LAST BOTTLENECK BLOCKS (features[-3:]) + HEAD
    # ─────────────────────────────────────────────────────────────────────────
    print(f"\n=======================================================")
    print(f"🚀 STAGE 2: Fine-Tuning Last Backbone Blocks ({stage2_epochs} Epochs)")
    print(f"=======================================================")
    # Unfreeze 3 blok bottleneck terakhir untuk adaptasi domain watermark/overlay
    for block in model.features[-3:]:
        for param in block.parameters():
            param.requires_grad = True

    opt_s2 = torch.optim.Adam([
        {"params": model.features[-3:].parameters(), "lr": lr_stage2 * 0.5},
        {"params": model.classifier.parameters(), "lr": lr_stage2}
    ], weight_decay=1e-4)

    sched_s2 = torch.optim.lr_scheduler.CosineAnnealingLR(opt_s2, T_max=max(1, stage2_epochs))

    for epoch in range(1, stage2_epochs + 1):
        model.train()
        running_loss = 0.0
        for inputs, labels in train_loader:
            inputs, labels = inputs.to(device), labels.to(device)
            opt_s2.zero_grad()
            outputs = model(inputs)
            loss = criterion(outputs, labels)
            loss.backward()
            opt_s2.step()
            running_loss += loss.item() * inputs.size(0)

        sched_s2.step()

        # Validation
        model.eval()
        y_true, y_pred = [], []
        with torch.no_grad():
            for inputs, labels in val_loader:
                inputs = inputs.to(device)
                outputs = model(inputs)
                _, preds = torch.max(outputs, 1)
                y_true.extend(labels.tolist())
                y_pred.extend(preds.cpu().tolist())

        m = compute_metrics(y_true, y_pred)
        train_loss = running_loss / len(train_dataset)
        composite_score = (m["clean_precision"] * 0.60) + (m["macro_f1"] * 0.40)

        print(f"  [Stage 2 | Ep {epoch:02d}/{stage2_epochs:02d}] Loss: {train_loss:.4f} | "
              f"Acc: {m['accuracy']*100:.1f}% | "
              f"Clean Prec: {m['clean_precision']*100:.1f}% Rec: {m['clean_recall']*100:.1f}% | "
              f"Macro F1: {m['macro_f1']*100:.1f}% | FP(Dirty->Clean): {m['fp']}")

        if composite_score > best_score:
            best_score = composite_score
            best_model_wts = copy.deepcopy(model.state_dict())
            best_metrics = m
            no_improve_epochs = 0
        else:
            no_improve_epochs += 1
            if no_improve_epochs >= patience and not smoke_test:
                print(f"  🛑 Early stopping aktif setelah {patience} epoch tanpa peningkatan metrik.")
                break

    print(f"\n✨ Training Selesai!")
    print(f"📊 [BEST VALIDATION METRICS]")
    print(f"   Accuracy        : {best_metrics.get('accuracy', 0)*100:.2f}%")
    print(f"   Clean Precision : {best_metrics.get('clean_precision', 0)*100:.2f}% (Tingkat frame benar-benar bersih)")
    print(f"   Clean Recall    : {best_metrics.get('clean_recall', 0)*100:.2f}%")
    print(f"   Reject Recall   : {best_metrics.get('reject_recall', 0)*100:.2f}% (Tingkat keberhasilan membuang kotor)")
    print(f"   Macro F1-Score  : {best_metrics.get('macro_f1', 0)*100:.2f}%")
    print(f"   Confusion Matrix: TP={best_metrics.get('tp',0)}, FP={best_metrics.get('fp',0)}, TN={best_metrics.get('tn',0)}, FN={best_metrics.get('fn',0)}")

    # Muat bobot terbaik
    model.load_state_dict(best_model_wts)
    model.eval().to("cpu")

    # ── Export ke ONNX ──
    models_dir = os.path.join(CURRENT_DIR, "models")
    os.makedirs(models_dir, exist_ok=True)
    target_onnx = os.path.join(models_dir, os.path.basename(output_onnx))

    print(f"\n📦 Mengekspor model terbaik ke ONNX: {target_onnx}...")
    dummy_input = torch.randn(1, 3, 224, 224, device="cpu")

    torch.onnx.export(
        model,
        dummy_input,
        target_onnx,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch_size"}, "output": {0: "batch_size"}},
        opset_version=17
    )

    # Sinkronisasi labels.json
    labels_file = os.path.join(models_dir, "labels.json")
    with open(labels_file, "w", encoding="utf-8") as f:
        json.dump(classes, f, indent=2)
    print(f"   Daftar label disimpan ke: {labels_file}")

    file_size_mb = os.path.getsize(target_onnx) / (1024 * 1024)
    print(f"✅ Model ONNX berhasil dibuat! ({file_size_mb:.2f} MB)")

    # ── Verifikasi Inferensi ONNXRuntime ──
    if HAS_ONNX:
        print("🧪 Menjalankan verifikasi inferensi ONNX Runtime...")
        ort_sess = ort.InferenceSession(target_onnx, providers=["CPUExecutionProvider"])
        test_out = ort_sess.run(None, {"input": dummy_input.numpy()})
        print(f"   Output shape: {test_out[0].shape} (Logits: {test_out[0][0]})")
        print("🎉 Verifikasi ONNX Sukses 100%!")


def main():
    parser = argparse.ArgumentParser(description="Staged Fine-Tuning MobileNetV3 Scene Gatekeeper for ClipperVPS")
    parser.add_argument("--dataset", type=str, default="dataset", help="Direktori dataset (train/ dan val/)")
    parser.add_argument("--stage1-epochs", type=int, default=5, help="Jumlah epoch Stage 1 (default: 5)")
    parser.add_argument("--stage2-epochs", type=int, default=8, help="Jumlah epoch Stage 2 (default: 8)")
    parser.add_argument("--batch-size", type=int, default=16, help="Ukuran batch (default: 16)")
    parser.add_argument("--lr-stage1", type=float, default=0.001, help="Learning rate Stage 1")
    parser.add_argument("--lr-stage2", type=float, default=0.0001, help="Learning rate Stage 2")
    parser.add_argument("--output", type=str, default="scene_filter_v2.onnx", help="Nama file ONNX")
    parser.add_argument("--smoke-test", action="store_true", help="Jalankan uji kilat pipeline (1 epoch / batch mini)")
    args = parser.parse_args()

    train_model(
        dataset_dir=args.dataset,
        stage1_epochs=args.stage1_epochs,
        stage2_epochs=args.stage2_epochs,
        batch_size=args.batch_size,
        lr_stage1=args.lr_stage1,
        lr_stage2=args.lr_stage2,
        output_onnx=args.output,
        smoke_test=args.smoke_test
    )


if __name__ == "__main__":
    main()
