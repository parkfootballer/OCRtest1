-- PRD 데이터 모델 (User, Document, ExtractedData, LineItem, ReviewLog)
-- 서버 시작 시 매번 실행되므로 모두 IF NOT EXISTS 로 작성한다.

CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type  text NOT NULL,                     -- auto | giro | bill | invoice | tax_invoice
  image_url      text,
  status         text NOT NULL DEFAULT 'processing'
                 CHECK (status IN ('processing', 'needs_retake', 'needs_review', 'verified')),
  retake_reason  text,
  verified_by    text,                              -- 'auto' 또는 검수자 user id
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_user_created_idx ON documents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);

CREATE TABLE IF NOT EXISTS extracted_data (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  vendor_name       text,
  business_number   text,
  issue_date        date,
  due_date          date,
  total_amount      bigint,
  tax_amount        bigint,
  raw_text          text,
  confidence_score  numeric(4, 3),
  field_confidence  jsonb NOT NULL DEFAULT '{}',    -- 필드별 인식 신뢰도
  ocr_confidence    numeric(4, 3),
  quality_issues    jsonb NOT NULL DEFAULT '[]'     -- 촬영 품질 경고
);

CREATE TABLE IF NOT EXISTS line_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extracted_data_id  uuid NOT NULL REFERENCES extracted_data(id) ON DELETE CASCADE,
  line_no            int NOT NULL,                  -- 문서상의 품목 순서
  item_name          text,
  quantity           numeric(14, 3),
  unit_price         bigint,
  amount             bigint
);
CREATE INDEX IF NOT EXISTS line_items_extracted_idx ON line_items (extracted_data_id, line_no);

CREATE TABLE IF NOT EXISTS review_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reviewer_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  field_name       text NOT NULL,
  original_value   text,
  corrected_value  text,
  reviewed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS review_logs_document_idx ON review_logs (document_id, reviewed_at DESC);

-- ---- 배포용 추가 테이블 ----

-- 로그인: scrypt 해시 ("salt:hash", hex)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,                     -- 쿠키 토큰의 SHA-256 (원문은 저장하지 않음)
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

-- 촬영 이미지: 무료 호스팅의 디스크는 재배포 때 지워지므로 DB에 둔다
CREATE TABLE IF NOT EXISTS images (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  mime         text NOT NULL,
  data         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS images_document_idx ON images (document_id);

-- 라벨링 데이터에 맞춰 추가한 추출 필드
ALTER TABLE extracted_data ADD COLUMN IF NOT EXISTS customer_name text;   -- 공급받는자 / 고지서 고객명
ALTER TABLE extracted_data ADD COLUMN IF NOT EXISTS billing_month text;   -- 청구년월 YYYY-MM
