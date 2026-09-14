#!/usr/bin/env python3
"""
PyTorch Training & ONNX Export Pipeline for ClipperVPS Scene Gatekeeper.
Fine-tunes MobileNetV3-Small binary classifier:
- Class 0: valid_real (Clean live-action tabletop product demonstration)
- Class 1: rejected   (2D cartoons, overlays, static bumpers, subtitle banners, unboxing clutter)

Exports: scene_filter_v2.onnx (opset 12, sub-10ms CPU inference)
"""

import os
import sys
import time
import copy
import argparse

import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from torchvision import datasets, models, transforms

try:
    import onnx
    import onnxruntime as ort
    HAS_ONNX = True
except ImportError:
    HAS_ONNX = False


def build_transforms():
    """
    Data augmentation to make AI robust against synthetic graphics vs real-world camera noise.
    """
    train_transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.RandomHorizontalFlip(p=0.5),
        transforms.ColorJitter(brightness=0.25, contrast=0.25, saturation=0.2),
        transforms.RandomRotation(degrees=10),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
    ])

    val_transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
    ])

    return train_transform, val_transform


def train_model(dataset_dir="dataset", epochs=10, batch_size=16, lr=0.0008, output_onnx="scene_filter_v2.onnx"):
    train_dir = os.path.join(dataset_dir, "train")
    val_dir = os.path.join(dataset_dir, "val")

    if not os.path.exists(train_dir) or not os.path.exists(val_dir):
        print(f"❌ Direktori dataset tidak ditemukan di: {dataset_dir}")
        print(f"   Pastikan terdapat folder: {train_dir} dan {val_dir}")
        return

    train_tf, val_tf = build_transforms()
    train_dataset = datasets.ImageFolder(train_dir, transform=train_tf)
    val_dataset = datasets.ImageFolder(val_dir, transform=val_tf)

    print(f"\n📂 [Dataset Loaded]")
    print(f"   Classes     : {train_dataset.classes} (0={train_dataset.classes[0]}, 1={train_dataset.classes[1]})")
    print(f"   Train count : {len(train_dataset)} images")
    print(f"   Val count   : {len(val_dataset)} images")

    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True, num_workers=2, pin_memory=True)
    val_loader = DataLoader(val_dataset, batch_size=batch_size, shuffle=False, num_workers=2)

    device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
    print(f"🚀 Device yang digunakan: {device} ({torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'})")

    # Load MobileNetV3-Small pre-trained on ImageNet
    print("📦 Mengunduh & memuat MobileNetV3-Small backbone...")
    model = models.mobilenet_v3_small(weights=models.MobileNet_V3_Small_Weights.DEFAULT)

    # Freeze feature extractor layers to prevent overfitting on small datasets
    for param in model.features.parameters():
        param.requires_grad = False

    # Replace classifier head with binary classification + dropout
    in_features = model.classifier[3].in_features
    model.classifier[3] = nn.Sequential(
        nn.Dropout(p=0.3),
        nn.Linear(in_features, 2)  # 2 classes: 0=valid_real, 1=rejected
    )

    model = model.to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.classifier[3].parameters(), lr=lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=epochs)

    best_model_wts = copy.deepcopy(model.state_dict())
    best_acc = 0.0

    print(f"\n🔥 Memulai training selama {epochs} epoch...")
    start_time = time.time()

    for epoch in range(1, epochs + 1):
        # ── Training Phase ──
        model.train()
        running_loss = 0.0
        running_corrects = 0

        for inputs, labels in train_loader:
            inputs = inputs.to(device)
            labels = labels.to(device)

            optimizer.zero_grad()
            outputs = model(inputs)
            _, preds = torch.max(outputs, 1)
            loss = criterion(outputs, labels)

            loss.backward()
            optimizer.step()

            running_loss += loss.item() * inputs.size(0)
            running_corrects += torch.sum(preds == labels.data)

        scheduler.step()
        epoch_loss = running_loss / len(train_dataset)
        epoch_acc = running_corrects.double() / len(train_dataset)

        # ── Validation Phase ──
        model.eval()
        val_loss = 0.0
        val_corrects = 0

        with torch.no_grad():
            for inputs, labels in val_loader:
                inputs = inputs.to(device)
                labels = labels.to(device)

                outputs = model(inputs)
                _, preds = torch.max(outputs, 1)
                loss = criterion(outputs, labels)

                val_loss += loss.item() * inputs.size(0)
                val_corrects += torch.sum(preds == labels.data)

        val_epoch_loss = val_loss / max(1, len(val_dataset))
        val_epoch_acc = val_corrects.double() / max(1, len(val_dataset))

        print(f"  [Epoch {epoch:02d}/{epochs:02d}] "
              f"Train Loss: {epoch_loss:.4f} Acc: {epoch_acc * 100:.1f}% | "
              f"Val Loss: {val_epoch_loss:.4f} Acc: {val_epoch_acc * 100:.1f}%")

        if val_epoch_acc >= best_acc:
            best_acc = val_epoch_acc
            best_model_wts = copy.deepcopy(model.state_dict())

    elapsed = time.time() - start_time
    print(f"\n✨ Training selesai dalam {elapsed:.1f} detik!")
    print(f"🎯 Best Validation Accuracy: {best_acc * 100:.2f}%\n")

    # Load best weights
    model.load_state_dict(best_model_wts)
    model.eval().to("cpu")

    # ── Export to ONNX ──
    print(f"📦 Mengekspor model ke ONNX format: {output_onnx}...")
    dummy_input = torch.randn(1, 3, 224, 224, device="cpu")

    torch.onnx.export(
        model,
        dummy_input,
        output_onnx,
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {0: "batch_size"}, "output": {0: "batch_size"}},
        opset_version=12
    )

    file_size_mb = os.path.getsize(output_onnx) / (1024 * 1024)
    print(f"✅ Model ONNX berhasil dibuat!")
    print(f"   File : {output_onnx} ({file_size_mb:.2f} MB)")

    # ── Verify with ONNXRuntime ──
    if HAS_ONNX:
        print("\n🧪 Menjalankan verifikasi inferensi ONNX Runtime...")
        ort_sess = ort.InferenceSession(output_onnx, providers=["CPUExecutionProvider"])
        test_out = ort_sess.run(None, {"input": dummy_input.numpy()})
        print(f"   Output shape: {test_out[0].shape} (Logits: {test_out[0][0]})")
        print("🎉 Verifikasi ONNX Sukses 100%!")


def main():
    parser = argparse.ArgumentParser(description="Train MobileNetV3 Scene Gatekeeper for ClipperVPS")
    parser.add_argument("--dataset", type=str, default="dataset", help="Direktori dataset (berisi train/ dan val/)")
    parser.add_argument("--epochs", type=int, default=10, help="Jumlah epoch training (default: 10)")
    parser.add_argument("--batch-size", type=int, default=16, help="Ukuran batch (default: 16)")
    parser.add_argument("--lr", type=float, default=0.0008, help="Learning rate (default: 0.0008)")
    parser.add_argument("--output", type=str, default="scene_filter_v2.onnx", help="Nama file ONNX output")
    args = parser.parse_args()

    train_model(
        dataset_dir=args.dataset,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        output_onnx=args.output
    )


if __name__ == "__main__":
    main()
