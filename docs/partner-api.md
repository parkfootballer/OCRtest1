# 찰칵장부 외부 연동 API (읽기 전용) v1

HSO 등 다른 시스템이 찰칵장부에 등록·검수된 **지점별 청구·거래 자료**를 가져가기 위한 API입니다.
조회만 할 수 있고, 찰칵장부의 데이터를 바꿀 수는 없습니다.

> **청구 확인 ≠ 납부 완료.** 찰칵장부는 고지서·명세서에 적힌 청구 내용을 읽고 사람이 확인한 결과만 알려 줍니다.
> 실제 납부·출금 여부는 모르므로 `paymentStatus`는 항상 `unknown`입니다. 실제 출금 내역과 같은 건으로 **이중 합산하지 마세요.**

## 1. 접속 정보

| 항목 | 값 |
|---|---|
| 기본 주소 | `https://<찰칵장부 서버 주소>/api/ext/v1` (운영: Render `chalkak` 서비스 주소) |
| 인증 | `Authorization: Bearer <API 키>` (키는 `chk_`로 시작) |
| 형식 | JSON, UTF-8, 시각은 ISO 8601(UTC), 금액은 원 단위 정수. `updatedAt`·`deletedAt`·`syncedUntil`은 마이크로초까지 오므로 **문자열 그대로 저장해 다시 넘기세요** (날짜 타입으로 바꾸면 잘려서 같은 건이 다시 올 수 있음) |
| 호출 제한 | 키당 분당 300회 (넘으면 `429`) |
| 범위 | 키마다 둘 중 하나: **모든 업장**(`scope: all`) 또는 **연결한 지점만**(`scope: mapped`). `GET /branches`로 확인 |
| 지점 구분 | 모든 문서에 `workplaceId`(업장 고유 id, 바뀌지 않음)가 붙습니다. 지점 코드를 연결한 업장은 `branchCode`도 붙습니다 |

API 키와 지점 연결은 찰칵장부 운영자가 발급합니다(아래 7장). 키는 비밀번호처럼 다루고, 서버 환경변수 등 안전한 곳에만 두세요.

## 2. 엔드포인트

### `GET /branches` — 연결 확인 · 조회 가능한 업장(지점) 목록
```json
{ "client": "hso", "scope": "all",
  "branches": [ { "workplaceId": "1f0c…", "branchCode": null, "hotelName": "그랜드호텔", "workplaceName": "객실관리팀" } ] }
```
모든 업장 범위의 키는 새 업장이 생기면 자동으로 목록에 추가됩니다. 주기적으로 받아 상대 시스템의 지점과 맞춰 두세요.

### `GET /documents` — 문서 목록 (증분 동기화)
변경 시각(`updatedAt`) 오름차순으로 돌려줍니다.

| 파라미터 | 설명 |
|---|---|
| `updatedSince` | 이 시각 **이후에 바뀐** 문서만 (ISO 8601). 증분 동기화에 사용 |
| `cursor` | 다음 페이지 (이전 응답의 `nextCursor`) |
| `limit` | 페이지 크기 1~200 (기본 100) |
| `workplace` | 업장 id(`workplaceId`) 하나로 제한 |
| `branch` | 지점 코드 하나로 제한 (지점 코드를 연결한 업장만) |
| `status` | `confirmed`(확인) 또는 `unconfirmed`(미확인) |
| `type` | `giro`,`bill`,`invoice`,`tax_invoice` (쉼표로 여러 개) |
| `includeDuplicates` | `true`면 "중복으로 등록"된 사본도 포함 (기본: 제외) |

```json
{
  "data": [ { …문서… } ],
  "hasMore": true,
  "nextCursor": "MjAyNi0xMC0zMFQwMjo…",
  "syncedUntil": "2026-10-30T02:11:09.512Z"
}
```

### `GET /documents/{id}` — 문서 상세 (품목 포함)
목록의 문서 필드 + `lineItems`:
```json
"lineItems": [ { "lineNo": 1, "itemName": "A4복사용지", "unit": "박스", "quantity": 2, "unitPrice": 25000, "amount": 50000 } ]
```

### `GET /deleted-documents?since=…` — 삭제된 문서
찰칵장부에서 지운 문서의 id입니다. 받아 간 쪽에서도 지워 주세요. **90일**만 보관하므로 그보다 자주 확인하세요.
```json
{ "data": [ { "id": "…", "workplaceId": "1f0c…", "branchCode": null, "deletedAt": "2026-10-30T03:00:00.123456Z" } ] }
```

## 3. 문서 필드

| 필드 | 설명 |
|---|---|
| `id` | 문서 id (UUID, 바뀌지 않음) — 상대 시스템의 중복 방지 키로 쓰세요 |
| `workplaceId` | 업장(지점) 고유 id — 지점 구분에 쓰세요 (바뀌지 않음) |
| `workplace.code` | 업장코드 (가입 때 입력, 관리자가 바꿀 수 있으므로 키로 쓰지 말고 표시·대조용으로) |
| `branchCode` | 연결된 상대 시스템의 지점 코드 (연결하지 않았으면 `null`) |
| `documentType` / `documentTypeLabel` | `giro` 지로, `bill` 고지서, `invoice` 거래명세서, `tax_invoice` 세금계산서 |
| `reviewStatus` | `confirmed` 확인(사람 검수 또는 자동 확정) / `unconfirmed` 미확인(검수 대기·재촬영 필요) |
| `confirmedAt`, `confirmedBy` | 확인 시각, `human`(사람) / `auto`(모든 대조 항목이 맞아 자동 확정) |
| `needsRetake` | 사진 품질 문제로 다시 찍어야 하는 문서 |
| `vendorName`, `businessNumber` | 청구한 곳(공급자·발행처) 상호, 사업자등록번호 |
| `documentNumber` | 문서번호(있으면) |
| `issueDate`, `dueDate`, `billingMonth` | 발행일, 납부기한, 청구년월(`YYYY-MM`) |
| `totalAmount`, `taxAmount`, `currency` | 청구 합계·세액(원), `KRW` |
| `paymentStatus` | 항상 `unknown` — 납부 여부를 모름 |
| `isDuplicate`, `duplicateOf` | 같은 문서를 두 번 등록한 사본이면 `true`와 원본 id (`includeDuplicates=true`일 때만 나옴) |
| `itemCount` | 품목 줄 수 |
| `createdAt`, `updatedAt` | 등록·마지막 변경 시각 |

값을 읽지 못한 필드는 `null`입니다. **미확인 문서의 값은 OCR이 읽은 그대로라 틀릴 수 있으니**, 합계·정산에는 `confirmed`만 쓰기를 권장합니다.

내주지 않는 정보: 문서 이미지, OCR 원문, 고객명(공급받는자)·담당자 등 개인 정보, 검수자 정보.

## 4. 동기화 방법 (권장)
1. 처음: `GET /documents?limit=200`을 `hasMore`가 `false`가 될 때까지 `cursor`로 이어서 받습니다.
2. 마지막 응답의 `syncedUntil`을 저장합니다.
3. 이후 주기적으로(예: 10분마다): `GET /documents?updatedSince=<저장한 값>` → 같은 방법으로 끝까지 → `syncedUntil` 갱신.
4. 받은 문서는 `id` 기준으로 **덮어쓰기(upsert)** 합니다. 검수로 금액이 바뀌거나 미확인 → 확인으로 바뀌면 다시 내려옵니다.
5. `GET /deleted-documents?since=<마지막 확인 시각>`으로 지워진 문서를 반영합니다.

## 5. 오류
```json
{ "error": { "code": "unauthorized", "message": "API 키가 올바르지 않거나 중지되었습니다" } }
```

| 상태 | code | 의미 |
|---|---|---|
| 400 | `invalid_parameter`, `invalid_cursor` | 파라미터 오류 |
| 401 | `unauthorized` | 키 없음·틀림·중지 |
| 404 | `not_found` | 없는 문서이거나 연결되지 않은 지점 |
| 405 | `method_not_allowed` | GET 외 요청 (읽기 전용) |
| 429 | `rate_limited` | 호출 제한 초과 |

## 6. 예시
```bash
curl -H "Authorization: Bearer $CHALKAK_API_KEY" "https://<서버>/api/ext/v1/documents?status=confirmed&type=giro,bill&limit=50"
```

## 7. 운영자용: 키 발급·지점 연결 (`server/manage.js`)
운영 DB에 대해 실행할 때는 `DATABASE_URL`에 Render의 External Database URL, `DB_SSL=true`를 줍니다.
```bash
node --env-file=.env manage.js api-client-add hso --all           # 키 발급: 모든 업장 (한 번만 표시)
node --env-file=.env manage.js api-client-add hso                 # 키 발급: 연결한 지점만
node --env-file=.env manage.js api-client-scope hso mapped        # 범위 변경 (all | mapped)
node --env-file=.env manage.js workplaces                         # 업장 id 확인
node --env-file=.env manage.js api-client-map hso <업장 id> HS-001  # 업장 ↔ 지점 코드 (모든 업장 키에선 선택)
node --env-file=.env manage.js api-clients                        # 연동·매핑·마지막 호출 확인
node --env-file=.env manage.js api-client-rotate hso              # 키 유출 의심 시 재발급
node --env-file=.env manage.js api-client-revoke hso              # 연동 중지
```
모든 연동 호출은 접속기록(`access_logs`, action `partner.*`)에 연동 이름·조건과 함께 남습니다.

## 8. 개인정보
연동으로 넘어가는 정보는 정산에 필요한 청구 항목(거래처 상호·사업자번호·금액·날짜·품목)으로 한정했습니다.
위탁 지점의 소유주가 개인사업자인 경우 거래처·사업자번호가 개인정보일 수 있으므로, 업장(소유주) 동의서와 처리방침에
"정산 대행 목적의 HSO 제공(또는 처리위탁)"을 반영해야 합니다(리걸 검토 2장).
