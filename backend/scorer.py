"""
多候选置信度融合评分算法 - 论文核心算法

评分公式: S(i) = α * C_ocr(i) + β * F_format(i) + γ * X_cross(i)

支持四组消融实验配置:
  Baseline:    α=1.0, β=0.0, γ=0.0
  +Format:     α=0.6, β=0.4, γ=0.0
  +CrossField: α=0.5, β=0.0, γ=0.5
  Full Model:  α=0.4, β=0.3, γ=0.3
"""
import re
from datetime import datetime


# ============================================================
# 格式校验函数（连续分数 0~1，不再是二值）
# ============================================================

def validate_date(value):
    """日期格式校验，返回 0~1 的连续分数"""
    value = value.strip()
    if not value:
        return 0.0

    # 完美匹配标准日期格式 → 1.0
    strict_patterns = [
        r"^\d{1,2}/\d{1,2}/\d{4}$",
        r"^\d{1,2}-\d{1,2}-\d{4}$",
        r"^\d{4}[/-]\d{1,2}[/-]\d{1,2}$",
        r"^\d{1,2}\.\d{1,2}\.\d{4}$",
    ]
    for p in strict_patterns:
        if re.match(p, value):
            return 1.0

    # 宽松匹配（文本中包含日期）→ 0.7
    loose_patterns = [
        r"\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}",
        r"\d{1,2}\s+\w{3,9}\s+\d{4}",
        r"\w{3,9}\s+\d{1,2},?\s+\d{4}",
    ]
    for p in loose_patterns:
        if re.search(p, value, re.IGNORECASE):
            return 0.7

    # 含有数字但不像日期 → 0.1
    if re.search(r"\d", value):
        return 0.1

    return 0.0


def validate_total(value):
    """金额格式校验，返回 0~1 的连续分数"""
    value = value.strip().replace(",", "")
    if not value:
        return 0.0

    # 去掉货币前缀
    clean = re.sub(r"^(RM|MYR|USD|\$|€|£)\s*", "", value, flags=re.IGNORECASE)

    # 完美金额格式：xx.xx → 1.0
    if re.match(r"^\d+\.\d{2}$", clean):
        return 1.0

    # 整数金额：xx → 0.6
    if re.match(r"^\d+$", clean):
        return 0.6

    # 小数但位数不对：xx.x 或 xx.xxx → 0.4
    if re.match(r"^\d+\.\d+$", clean):
        return 0.4

    # 含有数字但混有其他字符 → 0.1
    if re.search(r"\d", clean):
        return 0.1

    return 0.0


def validate_company(value):
    """公司名称格式校验，返回 0~1 的连续分数"""
    value = value.strip()
    if not value:
        return 0.0

    score = 0.3  # 基础分

    # 含有公司关键词 → +0.4
    company_kws = ["sdn", "bhd", "enterprise", "trading", "corporation",
                   "store", "shop", "mart", "restaurant", "pharmacy",
                   "bakery", "hotel", "cafe", "supply", "service",
                   "industries", "co.", "plt", "inc", "ltd"]
    if any(kw in value.lower() for kw in company_kws):
        score += 0.4

    # 合理长度 (5~80 字符) → +0.2
    if 5 <= len(value) <= 80:
        score += 0.2

    # 含有字母 → +0.1
    if re.search(r"[a-zA-Z]", value):
        score += 0.1

    # 纯数字 → 强惩罚
    if re.match(r"^\d[\d\s.,-]*$", value):
        return 0.05

    # 太短（<3字符）→ 惩罚
    if len(value) < 3:
        return 0.1

    # 看起来像日期/金额/电话号 → 惩罚
    if re.match(r"^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$", value):
        return 0.05
    if re.match(r"^(TEL|FAX|GST|REG|CO\.REG|SSM)", value, re.IGNORECASE):
        return 0.15

    return min(score, 1.0)


def validate_address(value):
    """地址格式校验，返回 0~1 的连续分数"""
    value = value.strip()
    if not value:
        return 0.0

    score = 0.2  # 基础分

    # 含有地址关键词 → +0.3
    addr_kws = ["jalan", "jln", "lorong", "taman", "no.", "lot", "block",
                "blk", "bandar", "kampung", "desa", "persiaran", "lebuh",
                "street", "road", "avenue", "drive"]
    if any(kw in value.lower() for kw in addr_kws):
        score += 0.3

    # 含有邮编 (5位数字) → +0.2
    if re.search(r"\b\d{5}\b", value):
        score += 0.2

    # 含有州名 → +0.15
    states = ["johor", "selangor", "perak", "penang", "kedah", "kelantan",
              "melaka", "pahang", "sabah", "sarawak", "perlis", "terengganu",
              "kuala lumpur", "putrajaya", "labuan"]
    if any(s in value.lower() for s in states):
        score += 0.15

    # 合理长度 → +0.15
    if len(value) > 15:
        score += 0.15

    # 纯数字 → 强惩罚
    if re.match(r"^\d[\d\s.,-]*$", value):
        return 0.05

    # 太短 → 惩罚
    if len(value) < 8:
        return 0.1

    return min(score, 1.0)


FORMAT_VALIDATORS = {
    "date": validate_date,
    "total": validate_total,
    "company": validate_company,
    "address": validate_address,
}


# ============================================================
# 跨字段约束校验（增强版）
# ============================================================

def cross_field_check(field_key, candidate_value, current_fields, all_amounts=None):
    """
    跨字段约束校验，返回 0~1 的分数。

    参数:
        all_amounts: 收据中所有识别到的金额列表（用于 total 字段的约束）
    """
    checks_passed = 0
    checks_total = 0

    if field_key == "total":
        clean = candidate_value.strip().replace(",", "")
        clean = re.sub(r"^(RM|MYR|USD|\$)\s*", "", clean, flags=re.IGNORECASE)

        # C1: 金额应为正数
        checks_total += 1
        try:
            val = float(clean)
            if val > 0:
                checks_passed += 1
        except ValueError:
            pass

        # C2: total 应是所有金额中最大的（或接近最大的）
        if all_amounts:
            checks_total += 1
            try:
                val = float(clean)
                max_amt = max(all_amounts)
                if val >= max_amt * 0.9:  # 在最大金额的 90% 以上
                    checks_passed += 1
                elif val >= max_amt * 0.5:
                    checks_passed += 0.5
            except (ValueError, TypeError):
                pass

        # C3: total 不应太小（< 1.00 的总额很罕见）
        checks_total += 1
        try:
            val = float(clean)
            if val >= 1.0:
                checks_passed += 1
            elif val > 0:
                checks_passed += 0.3
        except ValueError:
            pass

    elif field_key == "date":
        # C1: 日期不超过当前日期
        checks_total += 1
        parsed = False
        for fmt in ["%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d", "%d-%m-%Y",
                    "%Y-%m-%d", "%d.%m.%Y"]:
            try:
                dt = datetime.strptime(candidate_value.strip(), fmt)
                parsed = True
                if dt <= datetime.now():
                    checks_passed += 1
                break
            except ValueError:
                continue
        if not parsed and validate_date(candidate_value) > 0:
            checks_passed += 0.5

        # C2: 日期应在合理范围（2000~2030）
        checks_total += 1
        year_match = re.search(r"(20\d{2})", candidate_value)
        if year_match:
            year = int(year_match.group(1))
            if 2000 <= year <= 2030:
                checks_passed += 1
            else:
                checks_passed += 0.2
        else:
            checks_passed += 0.3  # 无法判断年份

    elif field_key == "company":
        # C1: 不应与 address 相同
        checks_total += 1
        addr = current_fields.get("address", "")
        if addr and candidate_value.strip().lower() == addr.strip().lower():
            checks_passed += 0
        else:
            checks_passed += 1

        # C2: 不应像日期或金额
        checks_total += 1
        looks_like_date = validate_date(candidate_value) > 0.5
        looks_like_amount = validate_total(candidate_value) > 0.5
        if not looks_like_date and not looks_like_amount:
            checks_passed += 1
        else:
            checks_passed += 0.1

        # C3: 公司名通常在收据最顶部（如果有 position_rank 信息）
        checks_total += 1
        checks_passed += 0.8  # 默认通过（位置信息在 extractor 中处理）

    elif field_key == "address":
        # C1: 不应与 company 相同
        checks_total += 1
        comp = current_fields.get("company", "")
        if comp and candidate_value.strip().lower() == comp.strip().lower():
            checks_passed += 0
        else:
            checks_passed += 1

        # C2: 地址应包含数字（门牌号或邮编）
        checks_total += 1
        if re.search(r"\d", candidate_value):
            checks_passed += 1
        else:
            checks_passed += 0.3

    # 通用约束: 不应与已确定的其他字段值完全相同
    checks_total += 1
    duplicate = False
    for k, v in current_fields.items():
        if k != field_key and v and candidate_value.strip() == v.strip():
            duplicate = True
            break
    if not duplicate:
        checks_passed += 1

    return checks_passed / checks_total if checks_total > 0 else 1.0


# ============================================================
# 融合评分
# ============================================================

ABLATION_CONFIGS = {
    "baseline":    {"alpha": 1.0, "beta": 0.0, "gamma": 0.0},
    "format":      {"alpha": 0.6, "beta": 0.4, "gamma": 0.0},
    "crossfield":  {"alpha": 0.5, "beta": 0.0, "gamma": 0.5},
    "full":        {"alpha": 0.4, "beta": 0.3, "gamma": 0.3},
}


def compute_score(candidate, field_key, current_fields, config="full",
                  all_amounts=None):
    """计算单个候选值的融合评分。"""
    params = ABLATION_CONFIGS[config]
    alpha, beta, gamma = params["alpha"], params["beta"], params["gamma"]

    value = candidate["value"]
    ocr_conf = candidate.get("ocr_confidence", 0.5)

    # 格式校验
    validator = FORMAT_VALIDATORS.get(field_key, lambda x: 1.0)
    format_score = validator(value)

    # 跨字段校验
    cross_score = cross_field_check(field_key, value, current_fields,
                                    all_amounts=all_amounts)

    # 融合评分
    final_score = alpha * ocr_conf + beta * format_score + gamma * cross_score

    return {
        "value": value,
        "ocr_confidence": ocr_conf,
        "format_score": format_score,
        "cross_field_score": cross_score,
        "final_score": final_score,
        "source": candidate.get("source", "ocr_primary"),
        "bbox": candidate.get("bbox"),
    }


def select_best_candidate(candidates_scored):
    """
    从评分后的候选列表中选择最佳值。

    决策规则:
    1. 格式得分极低 (< 0.1) 的候选值被淘汰
    2. 按 final_score 降序取最高分
    3. 得分 < 0.5 或前两名差距 < 0.05 时标记异常
    """
    # 规则一：淘汰格式极差的
    valid = [c for c in candidates_scored if c["format_score"] >= 0.1]
    if not valid:
        valid = candidates_scored

    # 按分数排序
    valid.sort(key=lambda x: x["final_score"], reverse=True)

    if not valid:
        return None, "no_candidates", False

    best = valid[0]
    is_anomaly = False
    reason = f"score={best['final_score']:.3f}"

    if best["final_score"] < 0.5:
        is_anomaly = True
        reason += " [LOW_SCORE]"
    if len(valid) >= 2 and (valid[0]["final_score"] - valid[1]["final_score"]) < 0.05:
        is_anomaly = True
        reason += " [AMBIGUOUS]"

    return best, reason, is_anomaly
