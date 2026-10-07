#!/usr/bin/env python3
"""Train/export a six-zone MobileNetV3-Small DBNet student (zonetext_v1.onnx)."""
import argparse
import csv
import io
import os
import random
import tempfile

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = ("bottom", "top", "TL", "TR", "BL", "BR")
MEAN = [0.485, 0.456, 0.406]
STD = [0.229, 0.224, 0.225]
SYNTHETIC_LABELS = ("DAPUR PRAKTIS", "@rumahpraktis", "VIDEO RESEP", "daily.home", "RESEP HARIAN")


def add_synthetic_zone_overlay(image, zone_index):
    """Add a small watermark/text treatment and return its corresponding zone label."""
    image = image.convert("RGBA")
    width, height = image.size
    layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    font = ImageFont.load_default()
    for font_path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ):
        if os.path.isfile(font_path):
            try:
                font = ImageFont.truetype(font_path, random.randint(11, 15))
                break
            except OSError:
                pass

    text = random.choice(SYNTHETIC_LABELS)
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=1)
    text_width = bbox[2] - bbox[0]
    text_height = bbox[3] - bbox[1]
    margin = random.randint(5, 10)
    is_corner = zone_index >= 2
    icon_size = max(11, text_height + random.randint(1, 5)) if is_corner and random.random() < 0.7 else 0
    combined_width = text_width + (icon_size + 3 if icon_size else 0)

    if zone_index in (1, 2, 3):
        y = margin
    else:
        y = max(margin, height - text_height - margin)
    if zone_index in (2, 4):
        x = margin
    elif zone_index in (3, 5):
        x = max(margin, width - combined_width - margin)
    else:
        x = max(margin, (width - text_width) // 2)

    opacity = random.randint(145, 220)
    text_color = random.choice(((255, 255, 255, opacity), (20, 20, 20, opacity)))
    if icon_size:
        icon_x = x
        icon_y = y
        icon_color = random.choice(((239, 72, 92, opacity), (45, 150, 232, opacity), (248, 173, 55, opacity)))
        draw.ellipse((icon_x, icon_y, icon_x + icon_size, icon_y + icon_size), fill=icon_color)
        draw.ellipse((icon_x + icon_size * 0.3, icon_y + icon_size * 0.3,
                      icon_x + icon_size * 0.7, icon_y + icon_size * 0.7), fill=(255, 255, 255, opacity))
        x += icon_size + 3
    if random.random() < 0.5:
        pad = random.randint(2, 5)
        bg = random.choice(((0, 0, 0, 105), (255, 255, 255, 105)))
        draw.rectangle((x - pad, y - pad, x + text_width + pad, y + text_height + pad), fill=bg)
    draw.text((x, y), text, font=font, fill=text_color, stroke_width=1,
              stroke_fill=(0, 0, 0, 150) if text_color[0] > 127 else (255, 255, 255, 150))
    return Image.alpha_composite(image, layer).convert("RGB")


class ZoneDataset(Dataset):
    def __init__(self, root, manifest, split, train, synthetic_overlay_probability=0.0):
        self.root, self.train = root, train
        self.synthetic_overlay_probability = max(0.0, min(1.0, float(synthetic_overlay_probability)))
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
            if random.random() < self.synthetic_overlay_probability:
                zone_index = random.randrange(len(LABELS))
                image = add_synthetic_zone_overlay(image, zone_index)
                labels[zone_index] = 1
                if zone_index in (2, 3):
                    labels[1] = 1
                elif zone_index in (4, 5):
                    labels[0] = 1
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
    parser.add_argument("--synthetic-overlay-probability", type=float, default=0.25,
                        help="Chance per training image of a labeled synthetic overlay; validation remains untouched.")
    parser.add_argument("--seed", type=int, default=20261007)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--workers", type=int, default=0,
                        help="DataLoader workers (default 0 to avoid memory-heavy fork workers on Termux).")
    parser.add_argument("--checkpoint", default="",
                        help="Atomic per-epoch checkpoint path; defaults to OUTPUT.checkpoint.pt.")
    parser.add_argument("--resume", action="store_true",
                        help="Resume model, optimizer, and best validation state from the checkpoint.")
    args = parser.parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    torch.set_num_threads(max(1, args.threads))
    manifest = os.path.join(args.data, "manifest.csv")
    train_ds = ZoneDataset(args.data, manifest, "train", True, args.synthetic_overlay_probability)
    val_ds = ZoneDataset(args.data, manifest, "val", False)
    if not train_ds or not val_ds:
        raise SystemExit("Dataset train/val kosong; gunakan --source folder terpisah atau lengkapi kedua split.")
    positives_summary = {name: sum(int(row[name]) for row in train_ds.rows) for name in LABELS}
    print(f"Dataset samples: train={len(train_ds)}, val={len(val_ds)}; train positives={positives_summary}")
    workers = max(0, args.workers)
    loader_generator = torch.Generator().manual_seed(args.seed)
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, num_workers=workers, generator=loader_generator)
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
    checkpoint_path = args.checkpoint or (args.output + ".checkpoint.pt")
    start_epoch = 1
    if args.resume:
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        model.load_state_dict(checkpoint["model"])
        optimizer.load_state_dict(checkpoint["optimizer"])
        best_checkpoint_score = tuple(checkpoint["best_score"])
        best_state = checkpoint["best_model"]
        start_epoch = int(checkpoint["epoch"]) + 1
        print(f"Resumed checkpoint at epoch {start_epoch - 1}; continuing through epoch {args.epochs}.")

    def save_checkpoint(epoch):
        os.makedirs(os.path.dirname(os.path.abspath(checkpoint_path)), exist_ok=True)
        payload = {
            "epoch": epoch,
            "model": {key: value.detach().cpu() for key, value in model.state_dict().items()},
            "optimizer": optimizer.state_dict(),
            "best_score": list(best_checkpoint_score),
            "best_model": best_state,
        }
        checkpoint_dir = os.path.dirname(os.path.abspath(checkpoint_path))
        fd, temporary = tempfile.mkstemp(prefix=".zonetext-checkpoint-", suffix=".pt", dir=checkpoint_dir)
        os.close(fd)
        try:
            torch.save(payload, temporary)
            os.replace(temporary, checkpoint_path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    if start_epoch > max(1, args.epochs):
        raise SystemExit(f"Checkpoint sudah di epoch {start_epoch - 1}, sama/lebih tinggi dari --epochs {args.epochs}.")

    for epoch in range(start_epoch, max(1, args.epochs) + 1):
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
        save_checkpoint(epoch)
        print(f"checkpoint_saved={checkpoint_path} epoch={epoch}")
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
