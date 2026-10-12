"""
Демо-сайт библиотеки docreader-ocr.

Запуск:
    uvicorn app.main:app --host 127.0.0.1 --port 8000
"""

import base64
import io
import logging
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError

import docreader
from docreader import DocReader

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("demo")

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_SIDE = 2560          # большие фото уменьшаем перед обработкой
PREVIEW_SIDE = 1600      # размер превью, возвращаемых в браузер


class StageTimer:
    """
    Оборачивает методы компонентов пайплайна и считает время каждого этапа.
    Вложенные вызовы (resolver -> ocr) засчитываются только внешнему этапу.
    """

    def __init__(self):
        self.timings: dict[str, float] = {}
        self.calls: dict[str, int] = {}
        self._depth = 0

    def reset(self):
        self.timings = {}
        self.calls = {}

    def wrap(self, obj, method: str, stage: str):
        if obj is None:
            return
        original = getattr(obj, method)

        def timed(*args, **kwargs):
            self._depth += 1
            start = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                self._depth -= 1
                if self._depth == 0:
                    self.timings[stage] = self.timings.get(stage, 0.0) + time.perf_counter() - start
                    self.calls[stage] = self.calls.get(stage, 0) + 1

        setattr(obj, method, timed)


class Engine:
    """Единственный экземпляр DocReader + блокировка (модели не потокобезопасны)."""

    def __init__(self):
        self.reader: DocReader | None = None
        self.timer = StageTimer()
        self.lock = threading.Lock()
        self.load_seconds: float | None = None
        self.error: str | None = None

    def load(self):
        start = time.perf_counter()
        try:
            reader = DocReader()
            self.timer.wrap(reader._classifier, "classify", "classify")
            self.timer.wrap(reader._resolver, "resolve", "resolve")
            self.timer.wrap(reader._detector, "detect", "detect")
            self.timer.wrap(reader._ocr, "recognize", "ocr")
            self.reader = reader
            self.load_seconds = time.perf_counter() - start
            logger.info(f"DocReader loaded in {self.load_seconds:.1f}s")
        except Exception as exc:  # noqa: BLE001
            self.error = f"{type(exc).__name__}: {exc}"
            logger.exception("Failed to load DocReader")

    def process(self, image: np.ndarray, classifier_conf: float, detector_conf: float, deskew: bool):
        reader = self.reader
        with self.lock:
            reader._classifier._confidence_threshold = classifier_conf
            reader._detector._confidence_threshold = detector_conf
            reader._config.enable_deskew = deskew
            self.timer.reset()
            start = time.perf_counter()
            result = reader.process(image, return_crops=True)
            total = time.perf_counter() - start
            return result, dict(self.timer.timings), dict(self.timer.calls), total


engine = Engine()


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=engine.load, daemon=True).start()
    yield


app = FastAPI(title="docreader-ocr demo", lifespan=lifespan)


def decode_upload(data: bytes) -> np.ndarray:
    """Байты -> BGR ndarray с учётом EXIF-ориентации (как её видит браузер)."""
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(400, "Не удалось прочитать изображение. Поддерживаются JPG, PNG, WEBP, BMP.") from exc
    if max(img.size) > MAX_SIDE:
        img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


def to_jpeg_b64(image: np.ndarray | None, max_side: int = PREVIEW_SIDE) -> tuple[str | None, float]:
    """BGR -> data-URL JPEG. Возвращает также коэффициент масштаба."""
    if image is None or image.size == 0:
        return None, 1.0
    h, w = image.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale < 1.0:
        image = cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        return None, 1.0
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode("ascii"), scale


def scale_points(points, scale: float) -> list[list[float]]:
    return [[round(float(x) * scale, 1), round(float(y) * scale, 1)] for x, y in np.asarray(points).reshape(-1, 2)]


@app.get("/api/status")
def status():
    return {
        "ready": engine.reader is not None,
        "error": engine.error,
        "load_seconds": engine.load_seconds,
        "version": getattr(docreader, "__version__", None),
        "package_version": _package_version(),
        "device": engine.reader._device if engine.reader else None,
        "classes": engine.reader._classifier.class_names if engine.reader else [],
    }


def _package_version() -> str | None:
    try:
        from importlib.metadata import version
        return version("docreader-ocr")
    except Exception:  # noqa: BLE001
        return None


@app.post("/api/recognize")
async def recognize(
    file: UploadFile = File(...),
    classifier_conf: float = Form(0.3),
    detector_conf: float = Form(0.25),
    deskew: bool = Form(False),
):
    if engine.reader is None:
        if engine.error:
            raise HTTPException(500, f"Модели не загрузились: {engine.error}")
        raise HTTPException(503, "Модели ещё загружаются, попробуйте через несколько секунд.")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Пустой файл.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Файл больше 20 МБ.")

    image = decode_upload(data)
    classifier_conf = min(max(classifier_conf, 0.01), 0.99)
    detector_conf = min(max(detector_conf, 0.01), 0.99)

    try:
        page, timings, calls, total = await run_in_threadpool(
            engine.process, image, classifier_conf, detector_conf, deskew
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Processing failed")
        raise HTTPException(500, f"Ошибка обработки: {type(exc).__name__}: {exc}") from exc

    source_b64, source_scale = to_jpeg_b64(image)
    documents = []
    for doc in page.documents:
        crop_b64, crop_scale = to_jpeg_b64(doc.doc_crop)
        zones = []
        for zone in doc.zones:
            zone_b64, _ = to_jpeg_b64(zone.crop_image, max_side=900)
            zones.append({
                "name": zone.name,
                "text": zone.text,
                "confidence": round(float(zone.confidence), 4),
                "polygon": scale_points(zone.bbox, crop_scale) if zone.bbox else [],
                "crop": zone_b64,
                "ocr_skipped": zone.name in engine.reader._config.skip_ocr_zones,
            })
        documents.append({
            "doc_type": doc.doc_type,
            "doc_confidence": round(float(doc.doc_confidence), 4),
            "polygon": scale_points(doc.doc_bbox, source_scale) if doc.doc_bbox is not None else [],
            "crop": crop_b64,
            "zones": zones,
            "fields": doc.fields,
            "resolve_meta": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in doc.resolve_meta.items()},
        })

    h, w = image.shape[:2]
    return {
        "source": {"image": source_b64, "width": round(w * source_scale), "height": round(h * source_scale)},
        "documents": documents,
        "library_output": page.to_dict(),
        "timings": {k: round(v, 3) for k, v in timings.items()},
        "calls": calls,
        "total_seconds": round(total, 3),
        "device": engine.reader._device,
    }


@app.get("/api/samples")
def samples():
    """Примеры из app/static/samples/ (кладите туда свои фото документов)."""
    folder = STATIC_DIR / "samples"
    if not folder.is_dir():
        return []
    exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
    return [
        {"name": p.stem, "url": f"/static/samples/{p.name}"}
        for p in sorted(folder.iterdir())
        if p.suffix.lower() in exts
    ]


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
