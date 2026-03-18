"""
OCR 引擎封装 - 对 PaddleOCR 的调用进行统一封装
"""
import time
import json
import threading
from pathlib import Path
from paddleocr import PaddleOCR

_ocr_instance = None
_ocr_lock = threading.Lock()


def get_ocr(lang="en"):
    """线程安全的单例模式获取 OCR 实例，避免重复加载模型"""
    global _ocr_instance
    if _ocr_instance is None:
        with _ocr_lock:
            if _ocr_instance is None:
                _ocr_instance = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
    return _ocr_instance


def run_ocr(image_path, lang="en"):
    """
    对一张图片执行 OCR，返回统一格式的结果。

    返回:
        {
            "image_path": str,
            "ocr_time_ms": float,
            "blocks": [
                {
                    "text": str,
                    "confidence": float,
                    "bbox": [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
                },
                ...
            ]
        }
    """
    image_path = Path(image_path)
    if not image_path.exists():
        raise FileNotFoundError(f"图片不存在: {image_path}")

    ocr = get_ocr(lang)
    start = time.time()
    result = ocr.ocr(str(image_path), cls=True)
    elapsed_ms = (time.time() - start) * 1000

    blocks = []
    if result and result[0]:
        for line in result[0]:
            bbox = line[0]  # [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            text = line[1][0]
            conf = line[1][1]
            blocks.append({
                "text": text,
                "confidence": conf,
                "bbox": bbox
            })

    return {
        "image_path": str(image_path),
        "ocr_time_ms": elapsed_ms,
        "blocks": blocks
    }


def run_ocr_with_params(image_path, det_db_thresh=0.3, lang="en"):
    """
    使用不同参数重新 OCR，用于生成次优候选值。
    调整检测阈值可以让 OCR 检测到更多/更少的文本块。
    """
    ocr = PaddleOCR(
        use_angle_cls=True, lang=lang, show_log=False,
        det_db_thresh=det_db_thresh
    )
    result = ocr.ocr(str(image_path), cls=True)
    blocks = []
    if result and result[0]:
        for line in result[0]:
            blocks.append({
                "text": line[1][0],
                "confidence": line[1][1],
                "bbox": line[0]
            })
    return blocks


if __name__ == "__main__":
    # 快速测试：对数据集第一张图跑 OCR
    test_img = Path(__file__).parent.parent / "data/sroie/data/img/000.jpg"
    if test_img.exists():
        result = run_ocr(test_img)
        print(f"OCR time: {result['ocr_time_ms']:.0f}ms, blocks: {len(result['blocks'])}")
        for b in result["blocks"][:5]:
            print(f"  [{b['confidence']:.3f}] {b['text']}")
    else:
        print(f"Test image not found: {test_img}")
