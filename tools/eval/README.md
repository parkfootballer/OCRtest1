# 인식 정확도 평가

라벨링한 문서 사진으로 앱의 인식·추출 정확도를 필드별로 잽니다. 앱과 같은 코드(`js/paddle.js`, `js/parser.js`)를 그대로 씁니다.

## 준비 (처음 한 번)

```bash
cd tools/eval
npm install
```

## 실행

```bash
node eval.js --data <라벨폴더> [--data <라벨폴더> ...]
```

- 라벨폴더: `labels/*.json`(각 파일에 `id`, `image`, `group_id`, `target`)과 `images/`가 있는 폴더
- `--engine tesseract`: 예전 엔진과 비교
- `--memory`: 거래처 기억(이전에 검수 확정한 상호·고객명)을 켠 경우. 같은 `group_id`의 정답은 빼고 씁니다
- `--verbose`: 문서별로 맞음/틀림 표시
- `--no-cache`: OCR을 다시 실행 (기본은 `cache/`에 저장된 OCR 결과를 재사용해 규칙만 빠르게 재측정)

결과 요약은 화면에, 문서별 상세는 `results/<엔진>.json`에 저장됩니다.

## 비교하는 필드

| 앱 필드 | 거래명세서 정답 | 고지서 정답 |
|---|---|---|
| vendorName | 공급자.상호 | 발행처 |
| businessNumber | 공급자.사업자등록번호 | – |
| customerName | 고객명 | 고객명 |
| issueDate | 발행일 | – |
| dueDate | 납부기한 | 납부기한 |
| billingMonth | – | 청구년월 |
| totalAmount | 합계금액 | 납기내금액 (없으면 당월부과액) |
| taxAmount | 부가세 | 부가세 |
| lineItems | 항목 (금액 + 품목명) | 항목 |

한 사진에 명세서가 둘이면 첫 번째만 평가합니다.

**새로 받은 사진은 규칙을 고치기 전에 먼저 평가에만 쓰세요.** 규칙을 맞춘 사진으로 잰 정확도는 실제보다 높게 나옵니다.
