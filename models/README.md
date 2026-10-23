# 인식 모델

| 파일 | 모델 | 용도 |
|---|---|---|
| `det.onnx` | PP-OCRv3 mobile det | 글자 위치 찾기 |
| `rec_korean.onnx` | korean PP-OCRv5 mobile rec | 한국어·영어 글자 읽기 |
| `dict_korean.txt` | 위 인식 모델의 글자 사전 | |

- 원본: [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (Apache License 2.0)
- ONNX 변환본: [monkt/paddleocr-onnx](https://huggingface.co/monkt/paddleocr-onnx) (Apache License 2.0)
- SHA-256
  - `det.onnx` ee40e80071ba3a320d4efda75f3e22047a7d049e9bf7bcaaf9daea23fc21b935
  - `rec_korean.onnx` 322f140154c820fcb83c3d24cfe42c9ec70dd1a1834163306a7338136e4f1eaa

모델을 바꾸면 `sw.js`의 `OCR_CACHE` 이름을 올려야 휴대폰에 새 모델이 내려갑니다.
