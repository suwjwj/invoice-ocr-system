"""
SROIE 数据集加载器 - 加载图片路径和 ground truth
"""
import json
from pathlib import Path


SROIE_DIR = Path(__file__).parent / "data" / "sroie" / "data"


def load_sroie_samples(max_samples=None):
    """
    加载 SROIE 数据集样本。

    返回:
        [
            {
                "id": "000",
                "image_path": Path,
                "ground_truth": {"company": ..., "date": ..., "address": ..., "total": ...},
            },
            ...
        ]
    """
    img_dir = SROIE_DIR / "img"
    key_dir = SROIE_DIR / "key"

    samples = []
    for img_path in sorted(img_dir.glob("*.jpg")):
        sample_id = img_path.stem
        key_path = key_dir / f"{sample_id}.json"

        if not key_path.exists():
            continue

        with open(key_path, "r", encoding="utf-8") as f:
            gt = json.load(f)

        samples.append({
            "id": sample_id,
            "image_path": img_path,
            "ground_truth": gt,
        })

        if max_samples and len(samples) >= max_samples:
            break

    return samples


def normalize_value(value):
    """标准化字段值，用于比较"""
    if not value:
        return ""
    v = value.strip().upper()
    # 去掉多余空格
    v = " ".join(v.split())
    return v


def match_field(predicted, ground_truth):
    """
    判断预测值和真实值是否匹配。
    使用多级匹配策略。
    """
    import re

    pred = normalize_value(predicted)
    gt = normalize_value(ground_truth)

    if not pred or not gt:
        return False

    # 完全匹配
    if pred == gt:
        return True

    # 包含匹配（处理 OCR 可能多识别/少识别一些字符）
    if gt in pred or pred in gt:
        return True

    # 去空格后匹配（OCR 经常把空格去掉或加多）
    pred_nospace = pred.replace(" ", "").replace(",", "")
    gt_nospace = gt.replace(" ", "").replace(",", "")
    if pred_nospace == gt_nospace:
        return True
    if gt_nospace in pred_nospace or pred_nospace in gt_nospace:
        return True

    # 对于金额，忽略货币符号比较数值
    try:
        pred_num = re.sub(r"[^\d.]", "", pred)
        gt_num = re.sub(r"[^\d.]", "", gt)
        if pred_num and gt_num:
            if abs(float(pred_num) - float(gt_num)) < 0.01:
                return True
    except (ValueError, TypeError):
        pass

    return False


if __name__ == "__main__":
    samples = load_sroie_samples(max_samples=5)
    print(f"Loaded {len(samples)} samples")
    for s in samples:
        print(f"  {s['id']}: {s['ground_truth']}")
