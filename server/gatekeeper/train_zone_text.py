#!/usr/bin/env python3
"""Train/export a six-zone MobileNetV3-Small DBNet student (zonetext_v1.onnx)."""
import argparse
import csv
import io
import os
import random

from PIL import Image, ImageEnhance, ImageFilter, ImageOps
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = ("bottom", "top", "TL", "TR", "BL", "BR")
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]


class ZoneDataset(Dataset):
    def __init__(self, root, manifest, split, train):
        self.root, self.train = root, train
        with open(manifest, newline="", encoding="utf-8") as stream:
            self.rows = [row for row in csv.DictReader(stream) if row["split"] == split]
        self.tensor = transforms.Compose([transforms.Resize((224, 224)), transforms.ToTensor(), transforms.Normalize(MEAN, STD)])

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        image = Image.open(os.path.join(self.root, row["image"])).convert("RGB")
        labels = [int(row[name]) for name in LABELS]
        if self.train:
            if random.random() < 0.5:
                image = ImageOps.mirror(image)
                labels[2], labels[3] = labels[3], labels[2]
                labels[4], labels[5] = labels[5], labels[4]
            if random.random() < 0.55:
                image = ImageEnhance.Brightness(image).enhance(random.uniform(0.8, 1.2))
                image = ImageEnhance.Contrast(image).enhance(random.uniform(0.8, 1.2))
            if random.random() < 0.45:
                image = image.filter(ImageFilter.GaussianBlur(random.uniform(0.1, 1.0)))
            if random.random() < 0.5:
                buffer = io.BytesIO()
                image.save(buffer, format="JPEG", quality=random.randint(25, 75))
                buffer.seek(0)
                image = Image.open(buffer).convert("RGB")
        return self.tensor(image), torch.tensor(labels, dtype=torch.float32)


def evaluate(model, loader, device):
    model.eval()
    ys, ps = [], []
    with torch.no_grad():
        for x, y in loader:
            p = torch.sigmoid(model(x.to(device))).cpu().numpy()
            ys.extend(y.numpy().astype(bool))
            ps.extend(p)
    if not ys:
        return 0.0, [], [], 0.0
    y, probabilities = np.asarray(ys), np.asarray(ps)
    p = probabilities >= 0.5
    true_positives = np.logical_and(y, p).sum(axis=0)
    support = y.sum(axis=0)
    predicted = p.sum(axis=0)
    # Report recall because false negatives on dirty zones are the risky outcome.
    recalls = true_positives / np.maximum(1, support)
    precisions = true_positives / np.maximum(1, predicted)
    f1 = 2 * precisions * recalls / np.maximum(1e-8, precisions + recalls)
    supported = support > 0
    macro_f1 = float(f1[supported].mean()) if np.any(supported) else 0.0
    exact = float(np.all(y == p, axis=1).mean())
    return exact, recalls.tolist(), precisions.tolist(), macro_f1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", default=os.path.join(HERE, "dataset", "zone_text_distilled"))
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--output", default=os.path.join(HERE, "models", "zonetext_v1.onnx"))
    parser.add_argument("--no-pretrained", action="store_true")
    args = parser.parse_args()
    manifest = os.path.join(args.data, "manifest.csv")
    train_ds = ZoneDataset(args.data, manifest, "train", True)
    val_ds = ZoneDataset(args.data, manifest, "val", False)
    if not train_ds or not val_ds:
        raise SystemExit("Dataset train/val kosong; gunakan --source folder terpisah atau lengkapi kedua split.")
    positives_summary = {name: sum(int(row[name]) for row in train_ds.rows) for name in LABELS}
    print(f"Dataset samples: train={len(train_ds)}, val={len(val_ds)}; train positives={positives_summary}")
    workers = 0 if os.name == "nt" else 2
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=workers)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, num_workers=workers)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    weights = None if args.no_pretrained else models.MobileNet_V3_Small_Weights.DEFAULT
    model = models.mobilenet_v3_small(weights=weights)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, len(LABELS))
    model = model.to(device)
    positives = np.array([sum(int(row[name]) for row in train_ds.rows) for name in LABELS], dtype=np.float32)
    negatives = max(1, len(train_ds)) - positives
    pos_weight = torch.tensor(np.maximum(1.0, negatives / np.maximum(1.0, positives)), device=device)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-4, weight_decay=1e-4)
    best_checkpoint_score = (-1.0, -1.0, -1.0)
    best_state = None
    for epoch in range(1, max(1, args.epochs) + 1):
        model.train()
        loss_total = 0.0
        for x, y in train_loader:
            x, y = x.to(device), y.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x), y)
            loss.backward()
            optimizer.step()
            loss_total += loss.item() * len(x)
        exact, recalls, precisions, macro_f1 = evaluate(model, val_loader, device)
        mean_recall = float(np.mean(recalls)) if recalls else 0.0
        print(
            f"epoch={epoch:02d} loss={loss_total / len(train_ds):.4f} "
            f"macro_f1={macro_f1:.3f} exact_match={exact:.3f} "
            f"zone_recall={dict(zip(LABELS, [round(v,3) for v in recalls]))} "
            f"zone_precision={dict(zip(LABELS, [round(v,3) for v in precisions]))}"
        )
        # Exact-match alone can prefer a checkpoint that misses a sparse zone.
        # Macro-F1 leads; recall and exact-match break ties in that order.
        checkpoint_score = (macro_f1, mean_recall, exact)
        if checkpoint_score >= best_checkpoint_score:
            best_checkpoint_score = checkpoint_score
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
    model.load_state_dict(best_state)
    model.eval().cpu()
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    class ProbabilityOutput(nn.Module):
        def __init__(self, wrapped):
            super().__init__()
            self.wrapped = wrapped
        def forward(self, image):
            return torch.sigmoid(self.wrapped(image))

    export_model = ProbabilityOutput(model).eval()
    torch.onnx.export(export_model, torch.zeros(1, 3, 224, 224), args.output, input_names=["image"], output_names=["zone_probabilities"], dynamic_axes={"image": {0: "batch"}, "zone_probabilities": {0: "batch"}}, opset_version=17, dynamo=False)
    print(
        f"Exported: {args.output}; six output probabilities ordered {LABELS}; "
        f"validation macro-F1={best_checkpoint_score[0]:.3f}, exact-match={best_checkpoint_score[2]:.3f}"
    )


if __name__ == "__main__":
    main()
