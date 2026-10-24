# OCR 학습 데이터 → 학습셋 변환

앱은 사람이 **검수 완료**한 문서마다 다음을 묶어 DB에 저장합니다 (`training_samples`, `training_fields`, `ocr_results`).

| 저장 항목 | 내용 |
|---|---|
| 원본 이미지 | 검수 시점의 문서 이미지 (`images`) |
| 최초 OCR 결과 | 글자 상자 좌표·글자·신뢰도, 회전 각도, 모델 버전 (`ocr_results.result`) |
| 최초 추출값 | OCR 직후 규칙으로 뽑은 필드·품목, 필드별 값 위치 상자 (`ocr_results.parsed`) |
| 확정값 | 검수로 확정한 필드·품목·문서 종류 (`training_samples.final_*`) |
| 항목별 비교 | 필드마다 최초값·확정값·수정 여부·신뢰도·상자 (`training_fields`) |

- 자동 확정(사람이 보지 않은 문서)은 넣지 않습니다. 자동 확정 문서도 사람이 열어 저장하면 들어갑니다.
- 업장 단위로만 조회·내보내기됩니다. 내보내기는 **업장 관리자**만 할 수 있습니다.
- 문서를 지우거나 재촬영하면 해당 학습 데이터도 지워집니다.

## 중요: 저장만으로 모델이 학습되지 않습니다

앱의 인식 엔진은 PaddleOCR 모델을 **ONNX로 변환한 추론 전용 파일**(`models/*.onnx`)을 휴대폰 브라우저에서 실행합니다.
브라우저·Node 서버에는 학습 기능이 없고, ONNX 파일은 그대로 미세조정할 수 없습니다. 실제 학습은 아래처럼 별도로 해야 합니다.

1. 업장 관리자 계정으로 로그인한 브라우저에서 `/api/training/export?limit=200&offset=0` 을 열어 저장 → `chalkak-training-*.json`
   (앱 화면에는 메뉴가 없습니다. 200건이 넘으면 `offset`을 200, 400…으로 바꿔 나눠 받고, `documentType=invoice`처럼 종류를 고를 수 있습니다)
2. 이 폴더에서 학습셋으로 변환
   ```bash
   cd tools/training
   npm install
   node build-dataset.js --in chalkak-training-all-2026-10-24-001.json --out dataset
   ```
3. (권장) `dataset/Label.txt`를 [PPOCRLabel](https://github.com/PFCCLab/PPOCRLabel)로 열어 상자·글자를 사람이 한 번 더 확인
4. Python + PaddlePaddle(GPU 권장) 환경에서 PaddleOCR 저장소의 **korean PP-OCRv5 mobile rec** 학습 설정으로
   **Paddle 원본 사전학습 가중치**에서 미세조정 (`rec_train.txt` / `rec_val.txt`, 사전은 `models/dict_korean.txt`와 같아야 함)
5. 학습한 모델을 inference 모델로 내보낸 뒤 `paddle2onnx`로 ONNX 변환 → `models/rec_korean.onnx` 교체
6. `tools/eval`로 기존 평가셋과 `dataset/eval`에서 정확도가 실제로 올랐는지 확인
7. `models/README.md`의 SHA-256, `js/ocr.js`의 `MODEL_VERSION`, `sw.js`의 `OCR_CACHE`를 올려 배포

## 만들어지는 파일

| 파일 | 용도 |
|---|---|
| `images/` | 원본 이미지 |
| `Label.txt` | PPOCRLabel 형식. OCR이 찾은 상자 + 글자 (검수로 고친 칸은 고친 값, 자동 변환이 불확실한 칸은 `###`) |
| `rec/`, `rec_train.txt`, `rec_val.txt` | 인식(rec) 모델 미세조정용 잘라낸 줄 + 정답. 문서 단위로 train/val 분리 (`--val 0.1`) |
| `kie.jsonl` | 문서별 최초 추출값·확정값. 추출 규칙(`js/parser.js`) 개선·KIE 모델 평가용 |
| `eval/` | `tools/eval` 라벨 형식. `node ../eval/eval.js --data dataset/eval` |

## 한계

- **정답 글자는 "필드 단위"로만 확인됩니다.** 검수자는 상호·금액 같은 필드를 고칠 뿐 글자 상자 하나하나를 보지 않습니다.
  그래서 rec 정답은 (a) 고친 필드의 상자, (b) 고치지 않았고 OCR 신뢰도가 `--min-conf`(기본 95) 이상인 필드 상자만 씁니다.
  필드가 아닌 일반 글자(주소, 안내문 등)는 정답이 없어 rec 학습에 넣지 않습니다.
- 한 상자에 라벨과 값이 함께 있으면("합계금액:506,000원") 값 부분만 바꿉니다. 날짜는 표기가 제각각이라 자동 변환하지 않습니다(`###`).
- **글자 위치(det) 정답은 없습니다.** `Label.txt`의 상자는 모델이 찾은 것이라, det 모델을 학습하려면 PPOCRLabel로 사람이 고쳐야 합니다.
- 품목 표는 줄 단위 정답 위치가 없어 rec 학습에는 쓰지 않고 `kie.jsonl`·`eval/`의 정답으로만 씁니다.
- 수백 건 이상이 모여야 미세조정 효과를 기대할 수 있습니다. 적은 데이터로 학습하면 오히려 나빠질 수 있으니 반드시 `tools/eval`로 비교하세요.
- 검수에서 고친 필드값은 지금도 **거래처 기억**(`/api/memory`)으로 다음 인식의 상호·고객명 보정에 바로 쓰입니다. 이것은 모델 학습이 아니라 규칙 보정입니다.
