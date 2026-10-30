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

-- ================================================================
-- 업장(호텔 내 영업장) 단위 분리
-- 회원·문서는 업장에 속하고, 같은 업장 구성원끼리만 문서를 공유한다.
-- ================================================================
CREATE TABLE IF NOT EXISTS workplaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_name  text NOT NULL,
  name        text NOT NULL,                        -- 업장명 (예: 객실관리팀, 1층 레스토랑)
  -- 공백·대소문자를 무시한 비교용 키 (같은 호텔에 같은 업장이 두 번 생기지 않게)
  hotel_key   text GENERATED ALWAYS AS (lower(regexp_replace(hotel_name, '\s', '', 'g'))) STORED,
  name_key    text GENERATED ALWAYS AS (lower(regexp_replace(name, '\s', '', 'g'))) STORED,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workplaces_key_idx ON workplaces (hotel_key, name_key);

-- 업장별 가입 코드: 관리자가 발급하고, 회원가입 때 입력한다
CREATE TABLE IF NOT EXISTS signup_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workplace_id  uuid NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
  code          text NOT NULL UNIQUE,               -- 대문자·숫자 8자 (구분자 없이 저장)
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  max_uses      int,                                -- NULL이면 제한 없음
  use_count     int NOT NULL DEFAULT 0,
  expires_at    timestamptz,                        -- NULL이면 만료 없음
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_codes_workplace_idx ON signup_codes (workplace_id, created_at DESC);

ALTER TABLE users ADD COLUMN IF NOT EXISTS workplace_id uuid REFERENCES workplaces(id) ON DELETE RESTRICT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS workplace_id uuid REFERENCES workplaces(id) ON DELETE CASCADE;

-- 기존 회원 이전: 업장이 없는 회원마다 개인 업장을 만들어 관리자로 둔다.
-- (기존에는 본인 문서만 보였으므로, 서로의 문서가 섞여 보이지 않도록 한 사람당 한 업장)
DO $$
DECLARE rec record; w uuid;
BEGIN
  FOR rec IN SELECT id, name FROM users WHERE workplace_id IS NULL LOOP
    INSERT INTO workplaces (hotel_name, name)
    VALUES ('미지정', rec.name || ' 업장 (' || left(rec.id::text, 8) || ')') RETURNING id INTO w;
    UPDATE users SET workplace_id = w, role = 'admin' WHERE id = rec.id;
  END LOOP;
  UPDATE documents SET workplace_id = owner.workplace_id
    FROM users owner WHERE documents.user_id = owner.id AND documents.workplace_id IS NULL;
END $$;
ALTER TABLE users ALTER COLUMN workplace_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN workplace_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS documents_workplace_created_idx ON documents (workplace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS users_workplace_idx ON users (workplace_id);

-- ================================================================
-- 중복 문서 감지
-- ================================================================
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_hash text;          -- 업로드한 원본 파일(촬영 프레임)의 SHA-256
ALTER TABLE documents ADD COLUMN IF NOT EXISTS duplicate_of uuid REFERENCES documents(id) ON DELETE SET NULL;
-- 사용자의 판단: NULL(확인 전·후보 없음) | duplicate(중복으로 등록 → 재고 미반영) | distinct(별개 문서 → 재고 반영)
ALTER TABLE documents ADD COLUMN IF NOT EXISTS duplicate_decision text;
DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT documents_dup_decision_check CHECK (duplicate_decision IN ('duplicate', 'distinct'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS documents_file_hash_idx ON documents (workplace_id, file_hash);

ALTER TABLE extracted_data ADD COLUMN IF NOT EXISTS document_number text; -- 문서번호(일련번호·전표번호 등)
CREATE INDEX IF NOT EXISTS extracted_total_idx ON extracted_data (total_amount);

-- ================================================================
-- 비품 재고
-- 현재고는 입고 내역(inventory_movements)의 합으로 계산한다. 문서별 내역은 문서를 다시 검수할 때마다
-- 통째로 다시 만들므로, 같은 문서가 두 번 더해지지 않고 문서를 지우면 자동으로 되돌려진다.
-- ================================================================
CREATE TABLE IF NOT EXISTS inventory_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workplace_id  uuid NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
  name          text NOT NULL,                      -- 처음 등록된 표기
  name_key      text NOT NULL,                      -- 공백·문장부호·대소문자를 무시한 비교 키
  unit          text NOT NULL DEFAULT '',
  unit_key      text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workplace_id, name_key, unit_key)
);

ALTER TABLE line_items ADD COLUMN IF NOT EXISTS unit text;              -- 단위 (개, 박스, EA 등)

CREATE TABLE IF NOT EXISTS inventory_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workplace_id  uuid NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  document_id   uuid REFERENCES documents(id) ON DELETE CASCADE, -- 문서 삭제 시 입고 내역도 삭제(= 재고 되돌림)
  line_no       int,
  kind          text NOT NULL DEFAULT 'in' CHECK (kind IN ('in', 'adjust')),
  quantity      numeric(14, 3) NOT NULL,
  item_name     text,                               -- 문서에 적힌 품목명 그대로
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, line_no)                     -- 한 문서의 한 품목 줄은 한 번만 반영
);
CREATE INDEX IF NOT EXISTS inventory_movements_item_idx ON inventory_movements (item_id, created_at DESC);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS inventory_status text NOT NULL DEFAULT 'none'; -- none | applied | skipped_duplicate

-- ================================================================
-- OCR 학습 데이터
-- ocr_results: 인식 처리 때의 최초 OCR 결과(글자 상자·신뢰도)와 최초 추출값
-- training_samples: 사람이 검수 완료한 시점의 이미지 + 최초 OCR + 확정값 묶음
-- training_fields: 위 묶음을 항목(필드)별로 펼친 것 — 필드별 오인식률 집계·내보내기에 쓴다
-- 모두 문서에 매달려 있어 문서를 지우면 함께 지워진다.
-- ================================================================
CREATE TABLE IF NOT EXISTS ocr_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  image_id       uuid REFERENCES images(id) ON DELETE SET NULL, -- 상자 좌표의 기준 이미지
  engine         text NOT NULL,
  model_version  text,
  result         jsonb NOT NULL,                    -- { width, height, rotation, confidence, lines[], words[] }
  parsed         jsonb NOT NULL,                    -- { documentType, data, lineItems, fieldBoxes }
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocr_results_document_idx ON ocr_results (document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS training_samples (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workplace_id    uuid NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
  image_id        uuid REFERENCES images(id) ON DELETE SET NULL,
  ocr_result_id   uuid REFERENCES ocr_results(id) ON DELETE SET NULL,
  document_type   text NOT NULL,
  final_fields    jsonb NOT NULL,                   -- 검수 확정 필드값
  final_items     jsonb NOT NULL,                   -- 검수 확정 품목
  final_text      text,                             -- 확정 시점의 원문(OCR 텍스트)
  corrected_count int NOT NULL DEFAULT 0,
  verified_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_samples_workplace_idx ON training_samples (workplace_id, document_type, verified_at DESC);

CREATE TABLE IF NOT EXISTS training_fields (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id       uuid NOT NULL REFERENCES training_samples(id) ON DELETE CASCADE,
  workplace_id    uuid NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
  document_type   text NOT NULL,
  field_name      text NOT NULL,
  ocr_value       text,                             -- 최초 OCR 추출값
  final_value     text,                             -- 검수 확정값
  corrected       boolean NOT NULL,
  ocr_confidence  numeric(4, 3),
  box             jsonb                             -- 값이 읽힌 글자 상자 [x0,y0,x1,y1] (ocr_results.image_id 기준)
);
CREATE INDEX IF NOT EXISTS training_fields_lookup_idx ON training_fields (workplace_id, document_type, field_name);

-- ================================================================
-- 휴대폰 번호 + 문자 인증 (가입 시 필수, 기존 회원은 비어 있음)
-- ================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone text;                  -- 숫자만 (01012345678)
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_idx ON users (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS phone_verifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  code_hash   text NOT NULL,                        -- 인증번호의 해시 (원문은 저장하지 않음)
  attempts    int NOT NULL DEFAULT 0,               -- 틀린 횟수 (5회면 무효)
  expires_at  timestamptz NOT NULL,                 -- 발송 후 3분
  verified_at timestamptz,
  token_hash  text,                                 -- 인증 성공 시 발급한 가입용 토큰의 해시
  used_at     timestamptz,                          -- 가입에 쓴 시각 (한 번만 쓸 수 있음)
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_verifications_phone_idx ON phone_verifications (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS phone_verifications_ip_idx ON phone_verifications (ip, created_at DESC);

-- ================================================================
-- 개인정보: 동의 기록 · 학습 데이터 활용 동의 · 접속기록 · 탈퇴
-- ================================================================
-- 회원 동의 기록 (어떤 버전의 고지에 언제·어디서 동의했는지). 탈퇴하면 함께 지운다
CREATE TABLE IF NOT EXISTS user_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type  text NOT NULL,                      -- privacy (필수: 개인정보 수집·이용)
  version       text NOT NULL,                      -- 고지문 버전 (js/policy.js의 버전과 같음)
  agreed        boolean NOT NULL,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_consents_user_idx ON user_consents (user_id, consent_type, created_at DESC);

-- 업장(소유주) 단위 OCR 학습 데이터 활용 동의 (선택). 동의한 업장의 문서만 학습 데이터로 저장한다
ALTER TABLE workplaces ADD COLUMN IF NOT EXISTS training_consent_at timestamptz;
ALTER TABLE workplaces ADD COLUMN IF NOT EXISTS training_consent_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workplaces ADD COLUMN IF NOT EXISTS training_consent_version text;
-- 동의 전에 쌓인 학습 데이터는 지우지 않되, 내보내기에서는 동의 시각 이후 검수분만 나간다 (server/training.js)

-- 접속기록: 누가·언제·어디서·무엇을 했는지 (개인정보의 안전성 확보조치 기준). 2년 보관 후 자동 삭제
-- 기록이 계정 삭제와 함께 사라지지 않도록 회원과 외래키로 묶지 않는다
CREATE TABLE IF NOT EXISTS access_logs (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  user_id       uuid,
  workplace_id  uuid,
  action        text NOT NULL,                      -- auth.login, document.view, document.delete, data.export …
  target_id     text,                               -- 대상 문서·코드 등의 id
  result        text NOT NULL,                      -- success | fail
  status        int,
  ip            text,
  user_agent    text,
  detail        jsonb
);
CREATE INDEX IF NOT EXISTS access_logs_workplace_idx ON access_logs (workplace_id, at DESC);
CREATE INDEX IF NOT EXISTS access_logs_at_idx ON access_logs (at);

-- ================================================================
-- 외부 연동(읽기 전용 API) — HSO 등 다른 시스템이 업장 문서를 가져간다
-- ================================================================
-- 연동 시스템(클라이언트)별 API 키. 키 원문은 저장하지 않고 SHA-256만 둔다
CREATE TABLE IF NOT EXISTS api_clients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,               -- 예: hso
  key_hash      text NOT NULL UNIQUE,
  key_prefix    text NOT NULL,                      -- 키 앞 12자 (어떤 키인지 알아보는 용도)
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
-- true면 지점 코드 연결 없이 모든 업장(앞으로 생길 업장 포함)의 문서를 내준다
ALTER TABLE api_clients ADD COLUMN IF NOT EXISTS all_workplaces boolean NOT NULL DEFAULT false;
-- 업장 ↔ 상대 시스템의 지점 코드. 매핑된 업장의 문서만 내준다 (all_workplaces면 코드는 선택 사항)
CREATE TABLE IF NOT EXISTS api_client_workplaces (
  client_id     uuid NOT NULL REFERENCES api_clients(id) ON DELETE CASCADE,
  workplace_id  uuid NOT NULL REFERENCES workplaces(id) ON DELETE CASCADE,
  branch_code   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, workplace_id),
  UNIQUE (client_id, branch_code)
);

-- 증분 동기화용 변경 시각: 문서·추출값·품목이 바뀌면 문서의 updated_at이 갱신된다
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE documents SET updated_at = COALESCE(verified_at, created_at) WHERE updated_at IS NULL;
ALTER TABLE documents ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE documents ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS documents_updated_idx ON documents (workplace_id, updated_at, id);

CREATE OR REPLACE FUNCTION documents_touch() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS documents_touch_trg ON documents;
CREATE TRIGGER documents_touch_trg BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION documents_touch();

-- 추출값이 바뀌면(검수 저장은 추출값을 통째로 다시 쓴다) 문서도 바뀐 것으로 본다
CREATE OR REPLACE FUNCTION extracted_touch_document() RETURNS trigger AS $$
BEGIN
  UPDATE documents SET updated_at = now() WHERE id = COALESCE(NEW.document_id, OLD.document_id);
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS extracted_touch_document_trg ON extracted_data;
CREATE TRIGGER extracted_touch_document_trg AFTER INSERT OR UPDATE OR DELETE ON extracted_data
  FOR EACH ROW EXECUTE FUNCTION extracted_touch_document();

-- 삭제된 문서 기록: 연동 시스템이 지운 문서를 알아 가도록 (90일 보관)
CREATE TABLE IF NOT EXISTS document_deletions (
  document_id   uuid PRIMARY KEY,
  workplace_id  uuid NOT NULL,
  deleted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_deletions_idx ON document_deletions (workplace_id, deleted_at);
CREATE OR REPLACE FUNCTION documents_record_deletion() RETURNS trigger AS $$
BEGIN
  INSERT INTO document_deletions (document_id, workplace_id) VALUES (OLD.id, OLD.workplace_id)
  ON CONFLICT (document_id) DO UPDATE SET deleted_at = now();
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS documents_record_deletion_trg ON documents;
CREATE TRIGGER documents_record_deletion_trg AFTER DELETE ON documents FOR EACH ROW EXECUTE FUNCTION documents_record_deletion();

-- 회원이 탈퇴해도 업장 문서는 업장 자료이므로 남긴다 (올린 사람만 비움)
ALTER TABLE documents ALTER COLUMN user_id DROP NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_user_id_fkey' AND confdeltype = 'c') THEN
    ALTER TABLE documents DROP CONSTRAINT documents_user_id_fkey;
    ALTER TABLE documents ADD CONSTRAINT documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
