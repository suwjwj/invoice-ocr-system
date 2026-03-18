"""
消融实验运行器

对 SROIE 数据集运行 4 组消融实验，输出每组的字段级准确率。
结果保存到 experiments/ 目录。

用法:
    python run_ablation.py                    # 跑全部 626 张
    python run_ablation.py --max-samples 50   # 只跑 50 张（调试用）
    python run_ablation.py --use-cache        # 使用缓存的 OCR 结果（跳过 OCR 推理）
"""
import sys
import os
import json
import time
import argparse
import csv
from pathlib import Path

# 添加项目根目录到 path
sys.path.insert(0, str(Path(__file__).parent))

from data_loader import load_sroie_samples, match_field
from backend.ocr_engine import run_ocr
from backend.extractor import extract_all_fields
from backend.scorer import ABLATION_CONFIGS

CACHE_DIR = Path(__file__).parent / "data" / "ocr_cache"
EXPERIMENTS_DIR = Path(__file__).parent / "experiments"


def get_cached_ocr(sample_id):
    """读取缓存的 OCR 结果"""
    cache_path = CACHE_DIR / f"{sample_id}.json"
    if cache_path.exists():
        with open(cache_path, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_ocr_cache(sample_id, ocr_result):
    """保存 OCR 结果到缓存"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / f"{sample_id}.json"
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(ocr_result, f, ensure_ascii=False)


def run_experiment(samples, config_name, use_cache=True):
    """
    对给定样本集运行一组实验。

    返回:
        {
            "config": str,
            "total_samples": int,
            "total_fields": int,
            "correct_fields": int,
            "accuracy": float,
            "per_field": {field_key: {"correct": int, "total": int, "accuracy": float}},
            "details": [...]  # 每个样本的详细结果
        }
    """
    field_keys = ["company", "date", "address", "total"]
    per_field = {k: {"correct": 0, "total": 0} for k in field_keys}
    details = []
    total_correct = 0
    total_fields = 0
    ocr_times = []
    _exp_start = time.time()

    n = len(samples)
    bar_width = 40

    for i, sample in enumerate(samples):
        # OCR
        if use_cache:
            ocr_result = get_cached_ocr(sample["id"])
        else:
            ocr_result = None

        if ocr_result is None:
            ocr_result = run_ocr(sample["image_path"])
            save_ocr_cache(sample["id"], ocr_result)

        ocr_times.append(ocr_result.get("ocr_time_ms", 0))

        # 字段提取（使用指定的消融配置）
        extraction = extract_all_fields(ocr_result["blocks"], config=config_name)
        fields = extraction["fields"]
        gt = sample["ground_truth"]

        sample_detail = {"id": sample["id"], "fields": {}}

        for fk in field_keys:
            pred_value = fields.get(fk, {}).get("value", "")
            gt_value = gt.get(fk, "")
            is_match = match_field(pred_value, gt_value)

            per_field[fk]["total"] += 1
            total_fields += 1
            if is_match:
                per_field[fk]["correct"] += 1
                total_correct += 1

            sample_detail["fields"][fk] = {
                "predicted": pred_value,
                "ground_truth": gt_value,
                "match": is_match,
                "confidence": fields.get(fk, {}).get("confidence", 0),
                "num_candidates": len(fields.get(fk, {}).get("candidates", [])),
            }

        details.append(sample_detail)

        # 每 10 张打印一次进度
        done = i + 1
        if done == 1 or done % 10 == 0 or done == n:
            acc = total_correct / total_fields if total_fields > 0 else 0
            elapsed = time.time() - _exp_start
            speed = done / elapsed if elapsed > 0 else 0
            eta = (n - done) / speed if speed > 0 else 0
            print(f"  [{done}/{n}] acc={acc:.3f} speed={speed:.1f}img/s ETA={eta:.0f}s",
                  flush=True)

    # 计算各字段准确率
    for fk in field_keys:
        t = per_field[fk]["total"]
        per_field[fk]["accuracy"] = per_field[fk]["correct"] / t if t > 0 else 0

    return {
        "config": config_name,
        "total_samples": len(samples),
        "total_fields": total_fields,
        "correct_fields": total_correct,
        "accuracy": total_correct / total_fields if total_fields > 0 else 0,
        "per_field": per_field,
        "avg_ocr_time_ms": sum(ocr_times) / len(ocr_times) if ocr_times else 0,
        "details": details,
    }


def save_results(all_results):
    """保存实验结果到 CSV 和 Markdown"""
    EXPERIMENTS_DIR.mkdir(parents=True, exist_ok=True)

    # CSV: 每组实验的汇总
    csv_path = EXPERIMENTS_DIR / "ablation_results.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["config", "alpha", "beta", "gamma",
                         "total_accuracy",
                         "company_acc", "date_acc", "address_acc", "total_acc",
                         "num_samples", "avg_ocr_time_ms"])
        for r in all_results:
            params = ABLATION_CONFIGS[r["config"]]
            writer.writerow([
                r["config"],
                params["alpha"], params["beta"], params["gamma"],
                f"{r['accuracy']:.4f}",
                f"{r['per_field']['company']['accuracy']:.4f}",
                f"{r['per_field']['date']['accuracy']:.4f}",
                f"{r['per_field']['address']['accuracy']:.4f}",
                f"{r['per_field']['total']['accuracy']:.4f}",
                r["total_samples"],
                f"{r['avg_ocr_time_ms']:.1f}",
            ])
    print(f"\nCSV saved to {csv_path}")

    # Markdown 汇总表
    md_path = EXPERIMENTS_DIR / "ablation_summary.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("# 消融实验结果\n\n")
        f.write(f"样本数: {all_results[0]['total_samples']}\n\n")
        f.write("| 实验组 | α | β | γ | 总准确率 | Company | Date | Address | Total |\n")
        f.write("|--------|---|---|---|----------|---------|------|---------|-------|\n")
        for r in all_results:
            params = ABLATION_CONFIGS[r["config"]]
            f.write(f"| {r['config']} | {params['alpha']} | {params['beta']} | {params['gamma']} "
                    f"| {r['accuracy']:.2%} "
                    f"| {r['per_field']['company']['accuracy']:.2%} "
                    f"| {r['per_field']['date']['accuracy']:.2%} "
                    f"| {r['per_field']['address']['accuracy']:.2%} "
                    f"| {r['per_field']['total']['accuracy']:.2%} |\n")

        # 分析
        f.write("\n## 分析\n\n")
        baseline = all_results[0]
        for r in all_results[1:]:
            diff = r["accuracy"] - baseline["accuracy"]
            f.write(f"- **{r['config']}** vs Baseline: "
                    f"{'↑' if diff > 0 else '↓'}{abs(diff):.2%}\n")

    print(f"Summary saved to {md_path}")

    # 详细结果 JSON
    json_path = EXPERIMENTS_DIR / "ablation_details.json"
    # 只保存非 details 的部分（details 太大）
    summary = []
    for r in all_results:
        s = {k: v for k, v in r.items() if k != "details"}
        summary.append(s)
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print(f"Details saved to {json_path}")


def main():
    parser = argparse.ArgumentParser(description="消融实验运行器")
    parser.add_argument("--max-samples", type=int, default=None,
                        help="最大样本数（调试用）")
    parser.add_argument("--use-cache", action="store_true",
                        help="使用缓存的 OCR 结果")
    args = parser.parse_args()

    print("=" * 60)
    print("消融实验 - 多候选置信度融合评分算法")
    print("=" * 60)

    # 加载数据
    samples = load_sroie_samples(max_samples=args.max_samples)
    print(f"\n加载了 {len(samples)} 个样本")

    # 运行 4 组实验
    configs = ["baseline", "format", "crossfield", "full"]
    all_results = []

    for config_name in configs:
        params = ABLATION_CONFIGS[config_name]
        print(f"\n--- 实验组: {config_name} (α={params['alpha']}, β={params['beta']}, γ={params['gamma']}) ---")
        start = time.time()

        result = run_experiment(samples, config_name, use_cache=args.use_cache)
        elapsed = time.time() - start

        print(f"  完成! 用时 {elapsed:.1f}s, 总准确率: {result['accuracy']:.2%}")
        for fk in ["company", "date", "address", "total"]:
            pf = result["per_field"][fk]
            print(f"    {fk:10s}: {pf['correct']}/{pf['total']} = {pf['accuracy']:.2%}")

        all_results.append(result)

        # 第一组跑完后后续组都用缓存（OCR 结果相同，只是评分不同）
        args.use_cache = True

    # 保存结果
    save_results(all_results)
    print("\n实验完成!")


if __name__ == "__main__":
    main()
