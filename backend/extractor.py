"""
字段提取引擎 - 从 OCR 文本块中提取结构化字段

核心改进：每个字段生成大量候选值（包含正确和错误的），
让评分算法来筛选最佳结果。这样消融实验才能体现各评分分量的贡献。
"""
import re
from backend.scorer import compute_score, select_best_candidate


def _get_block_y_center(block):
    bbox = block["bbox"]
    return (bbox[0][1] + bbox[2][1]) / 2


def _get_block_x_center(block):
    bbox = block["bbox"]
    return (bbox[0][0] + bbox[2][0]) / 2


def _is_right_of(block, ref_block, y_tolerance=20):
    bx = _get_block_x_center(block)
    rx = _get_block_x_center(ref_block)
    by = _get_block_y_center(block)
    ry = _get_block_y_center(ref_block)
    return bx > rx and abs(by - ry) < y_tolerance


# ============================================================
# 候选值生成器（宽泛地收集候选，不做过滤）
# ============================================================

def extract_company(blocks):
    """
    公司名候选：收据顶部的所有非纯数字文本块。
    正确的公司名通常含 SDN BHD 等关键词，格式校验和跨字段校验会加分。
    """
    candidates = []
    sorted_blocks = sorted(blocks, key=_get_block_y_center)

    # 取顶部前 8 个文本块作为候选
    for i, b in enumerate(sorted_blocks[:8]):
        text = b["text"].strip()
        if not text or len(text) < 2:
            continue

        # 位置越靠上，给一点额外置信度（模拟位置先验）
        position_bonus = max(0, (8 - i) * 0.005)

        candidates.append({
            "value": text,
            "ocr_confidence": min(b["confidence"] + position_bonus, 1.0),
            "source": "top_region",
            "bbox": b["bbox"],
        })

    # 全文搜索含公司关键词的行（可能不在顶部）
    for b in blocks:
        text = b["text"].strip()
        if any(kw in text.lower() for kw in ["sdn bhd", "sdn. bhd", "enterprise",
                                              "trading", "corporation", "industries"]):
            if not any(c["value"] == text for c in candidates):
                candidates.append({
                    "value": text,
                    "ocr_confidence": b["confidence"],
                    "source": "keyword_match",
                    "bbox": b["bbox"],
                })

    return candidates


def extract_date(blocks):
    """
    日期候选：收集所有看起来可能是日期的文本。
    包括真正的日期和"伪日期"（如电话号码中的数字组合），让格式校验来区分。
    """
    candidates = []
    seen_values = set()

    for b in blocks:
        text = b["text"].strip()

        # 策略1: 精确日期格式匹配
        date_patterns = [
            r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}",
            r"\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}",
            r"\d{1,2}\s+\w{3,9}\s+\d{4}",
            r"\w{3,9}\s+\d{1,2},?\s+\d{4}",
        ]
        for pattern in date_patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                val = match.group(0)
                if val not in seen_values:
                    seen_values.add(val)
                    candidates.append({
                        "value": val,
                        "ocr_confidence": b["confidence"],
                        "source": "pattern_match",
                        "bbox": b["bbox"],
                    })

        # 策略2: "date" 关键词后面的值
        if "date" in text.lower():
            parts = re.split(r"[:\s]+", text, maxsplit=1)
            if len(parts) > 1:
                val = parts[-1].strip()
                if val and val not in seen_values:
                    seen_values.add(val)
                    candidates.append({
                        "value": val,
                        "ocr_confidence": b["confidence"] * 0.95,
                        "source": "keyword_split",
                        "bbox": b["bbox"],
                    })

        # 策略3: 含有连续数字的文本块也作为候选（让格式校验来排除）
        if re.search(r"\d{2,}", text) and len(text) < 25:
            if text not in seen_values and not re.match(r"^\d+\.\d{2}$", text):
                seen_values.add(text)
                candidates.append({
                    "value": text,
                    "ocr_confidence": b["confidence"] * 0.7,
                    "source": "digit_block",
                    "bbox": b["bbox"],
                })

    return candidates


def extract_address(blocks):
    """
    地址候选：生成多种合并方案。
    策略1: 关键词行合并
    策略2: 顶部连续行合并（不同起止位置）
    策略3: 单行候选
    """
    candidates = []
    sorted_blocks = sorted(blocks, key=_get_block_y_center)

    addr_keywords = ["jalan", "jln", "lorong", "taman", "no.", "lot", "block",
                     "blk", "bandar", "kampung", "daya", "bahru", "johor",
                     "selangor", "perak", "penang", "kuala", "malaysia"]

    # 找所有含地址关键词的行索引
    addr_indices = []
    for i, b in enumerate(sorted_blocks):
        text = b["text"].strip()
        if (any(kw in text.lower() for kw in addr_keywords)
                or re.search(r"\b\d{5}\b", text)
                or re.match(r"^(NO|LOT|BLOCK)\b", text, re.IGNORECASE)):
            addr_indices.append(i)

    if addr_indices:
        # 策略1: 从第一个地址行到最后一个地址行
        start = addr_indices[0]
        end = addr_indices[-1]

        # 向上扩展
        while start > 0:
            prev = sorted_blocks[start - 1]["text"].strip()
            if re.match(r"^(NO|LOT|BLOCK|BLK)\b", prev, re.IGNORECASE):
                start -= 1
            else:
                break

        # 全范围合并
        parts = _filter_addr_parts(sorted_blocks, start, end)
        if parts:
            full_addr = ", ".join(parts)
            full_addr = re.sub(r",\s*,", ",", full_addr)
            avg_conf = sum(sorted_blocks[j]["confidence"]
                          for j in range(start, end + 1)) / (end - start + 1)
            candidates.append({
                "value": full_addr,
                "ocr_confidence": avg_conf,
                "source": "full_merge",
                "bbox": sorted_blocks[start]["bbox"],
            })

        # 策略2: 只取核心地址行（排除首尾）
        if len(addr_indices) > 2:
            core_start = addr_indices[0]
            core_end = addr_indices[-1]
            core_parts = _filter_addr_parts(sorted_blocks, core_start, core_end)
            if core_parts:
                core_addr = ", ".join(core_parts)
                core_addr = re.sub(r",\s*,", ",", core_addr)
                if core_addr != full_addr if parts else True:
                    candidates.append({
                        "value": core_addr,
                        "ocr_confidence": avg_conf * 0.95,
                        "source": "core_merge",
                        "bbox": sorted_blocks[core_start]["bbox"],
                    })

    # 策略3: 顶部单行/双行候选
    top_cutoff = min(len(sorted_blocks), 10)
    for i in range(1, top_cutoff):
        text = sorted_blocks[i]["text"].strip()
        if len(text) > 10 and not re.match(r"^\d[\d\s.,-]*$", text):
            candidates.append({
                "value": text,
                "ocr_confidence": sorted_blocks[i]["confidence"] * 0.75,
                "source": "single_line",
                "bbox": sorted_blocks[i]["bbox"],
            })

        # 双行合并
        if i + 1 < top_cutoff:
            next_text = sorted_blocks[i + 1]["text"].strip()
            merged = text + ", " + next_text
            if len(merged) > 15:
                avg_c = (sorted_blocks[i]["confidence"] +
                         sorted_blocks[i + 1]["confidence"]) / 2
                candidates.append({
                    "value": merged,
                    "ocr_confidence": avg_c * 0.7,
                    "source": "two_line_merge",
                    "bbox": sorted_blocks[i]["bbox"],
                })

    return candidates


def _filter_addr_parts(sorted_blocks, start, end):
    """过滤地址合并中的非地址行"""
    parts = []
    for j in range(start, end + 1):
        text = sorted_blocks[j]["text"].strip()
        if re.match(r"^(TEL|FAX|GST|REG|CO\.REG|SSM|RECEIPT|INVOICE|TAX|CASH|Document)",
                    text, re.IGNORECASE):
            continue
        if re.match(r"^\d{6,}-[A-Z]$", text):
            continue
        has_company = any(kw in text.lower() for kw in ["sdn", "bhd", "enterprise", "trading"])
        has_addr = (any(kw in text.lower() for kw in
                       ["jalan", "jln", "taman", "lot", "no.", "block", "daya",
                        "bahru", "johor", "selangor", "perak", "penang", "kuala"])
                    or re.search(r"\b\d{5}\b", text)
                    or re.match(r"^(NO|LOT)\b", text, re.IGNORECASE))
        if has_company and not has_addr:
            continue
        parts.append(text)
    return parts


def extract_total(blocks):
    """
    总金额候选：收集收据上所有金额数值作为候选。
    真正的 total 应该是最大金额且在 TOTAL 关键词附近。
    Baseline 只看 OCR 置信度会选错（可能选到小计或税额），
    CrossField 会偏好最大金额，Format 会偏好 xx.xx 格式。
    """
    candidates = []
    seen_values = set()
    amount_pattern = r"(\d+[,\s]*\d*\.\d{2})"

    # 策略1: TOTAL 关键词附近的金额（给高置信度）
    total_kws = ["total", "grand total", "amount due", "total due",
                 "nett total", "balance due", "total amount", "sum total",
                 "total (rm)", "jumlah"]

    for b in blocks:
        text_lower = b["text"].strip().lower()
        is_total_line = any(kw in text_lower for kw in total_kws)

        if is_total_line:
            # 同行金额
            match = re.search(amount_pattern, b["text"])
            if match:
                val = match.group(1).replace(",", "").replace(" ", "")
                if val not in seen_values:
                    seen_values.add(val)
                    candidates.append({
                        "value": val,
                        "ocr_confidence": b["confidence"],
                        "source": "total_inline",
                        "bbox": b["bbox"],
                    })

            # 右侧/下方的金额
            for other in blocks:
                if other is b:
                    continue
                other_text = other["text"].strip()
                amt_match = re.search(amount_pattern, other_text)
                if amt_match and _is_right_of(other, b, y_tolerance=25):
                    val = amt_match.group(1).replace(",", "").replace(" ", "")
                    if val not in seen_values:
                        seen_values.add(val)
                        candidates.append({
                            "value": val,
                            "ocr_confidence": other["confidence"],
                            "source": "total_spatial",
                            "bbox": other["bbox"],
                        })

    # 策略2: 收集所有 RM 前缀的金额
    for b in blocks:
        text = b["text"].strip()
        rm_match = re.match(r"^RM\s*(\d+[,\s]*\d*\.\d{2})$", text, re.IGNORECASE)
        if rm_match:
            val = rm_match.group(1).replace(",", "").replace(" ", "")
            if val not in seen_values:
                seen_values.add(val)
                candidates.append({
                    "value": val,
                    "ocr_confidence": b["confidence"] * 0.9,
                    "source": "rm_prefix",
                    "bbox": b["bbox"],
                })

    # 策略3: 收集所有独立的金额数值（子项金额、税额等都收集）
    for b in blocks:
        text = b["text"].strip()
        # 独立金额行
        match = re.match(r"^(?:RM|rm)?\s*(\d+[,\s]*\d*\.\d{2})$", text, re.IGNORECASE)
        if match:
            val = match.group(1).replace(",", "").replace(" ", "")
            if val not in seen_values:
                seen_values.add(val)
                # 给较低的基础置信度，让评分来区分
                candidates.append({
                    "value": val,
                    "ocr_confidence": b["confidence"] * 0.65,
                    "source": "any_amount",
                    "bbox": b["bbox"],
                })

    return candidates


def _collect_all_amounts(blocks):
    """收集收据上所有金额数值（用于跨字段约束）"""
    amounts = []
    for b in blocks:
        text = b["text"].strip()
        text = re.sub(r"^(RM|rm)\s*", "", text)
        matches = re.findall(r"(\d+\.?\d*)", text)
        for m in matches:
            try:
                val = float(m)
                if val > 0:
                    amounts.append(val)
            except ValueError:
                pass
    return amounts


EXTRACTORS = {
    "company": extract_company,
    "date": extract_date,
    "address": extract_address,
    "total": extract_total,
}


def extract_all_fields(ocr_blocks, config="full"):
    """
    从 OCR 文本块中提取所有字段。

    参数:
        ocr_blocks: OCR 输出的文本块列表
        config: 消融实验配置 (baseline/format/crossfield/full)
    """
    results = {}
    current_fields = {}
    anomalies = []

    all_amounts = _collect_all_amounts(ocr_blocks)

    # 按确定性高的字段先提取
    extract_order = ["date", "total", "company", "address"]

    for field_key in extract_order:
        extractor = EXTRACTORS[field_key]
        candidates = extractor(ocr_blocks)

        if not candidates:
            results[field_key] = {
                "value": "",
                "confidence": 0.0,
                "candidates": [],
                "decision_reason": "no_candidates_found",
                "is_anomaly": True,
                "evidence_bbox": None,
            }
            anomalies.append(field_key)
            continue

        # 对所有候选值评分
        scored = [compute_score(c, field_key, current_fields, config,
                                all_amounts=all_amounts)
                  for c in candidates]

        # 选择最佳候选
        best, reason, is_anomaly = select_best_candidate(scored)

        if best:
            current_fields[field_key] = best["value"]
            results[field_key] = {
                "value": best["value"],
                "confidence": best["final_score"],
                "candidates": scored,
                "decision_reason": reason,
                "is_anomaly": is_anomaly,
                "evidence_bbox": best["bbox"],
            }
            if is_anomaly:
                anomalies.append(field_key)
        else:
            results[field_key] = {
                "value": "",
                "confidence": 0.0,
                "candidates": scored,
                "decision_reason": "selection_failed",
                "is_anomaly": True,
                "evidence_bbox": None,
            }
            anomalies.append(field_key)

    return {"fields": results, "anomalies": anomalies}
