// 앱에서 내보낸 학습 데이터(chalkak-training-*.json) → PaddleOCR 학습셋 + 정확도 평가셋
//   node build-dataset.js --in <내보낸.json> [--in ...] --out <폴더> [--min-conf 95] [--val 0.1]
//
// 만들어지는 것 (자세한 설명은 README.md)
//   images/            원본 이미지
//   Label.txt          PPOCRLabel 형식: OCR이 찾은 글자 상자 + 글자 (검수로 고친 칸은 고친 값). 사람이 PPOCRLabel로 열어 확인용
//   rec/               글자 줄 잘라낸 이미지 (인식 모델 미세조정용)
//   rec_train.txt, rec_val.txt   "rec/파일\t정답 글자"
//   kie.jsonl          문서별 최초 추출값·확정값 (추출 규칙·KIE 모델 평가용)
//   eval/              tools/eval 이 읽는 라벨 폴더 (node ../eval/eval.js --data <out>/eval)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : args[i + 1]; };
const inputs = args.flatMap((a, i) => (a === '--in' ? [args[i + 1]] : []));
const OUT = opt('out');
const MIN_CONF = Number(opt('min-conf', 95)); // 고치지 않은 칸은 OCR 신뢰도가 이 이상일 때만 정답으로 쓴다
const VAL_RATIO = Number(opt('val', 0.1));
if (!inputs.length || !OUT) {
  console.error('사용법: node build-dataset.js --in <내보낸.json> [--in ...] --out <폴더>');
  process.exit(1);
}

const sameBox = (a, b) => a && b && a.length === 4 && a.every((v, i) => Math.abs(v - b[i]) <= 1);
const digits = (s) => String(s ?? '').replace(/\D/g, '');
const withCommas = (n) => Number(n).toLocaleString('en-US');
// 같은 문서는 늘 같은 쪽(train/val)에 들어가도록 문서 id 해시로 나눈다
const isVal = (id) => crypto.createHash('md5').update(id).digest()[0] / 256 < VAL_RATIO;

// 고친 칸의 글자 상자 원문에서 "OCR이 읽은 값" 부분만 확정값으로 바꾼다. 확신이 없으면 null (그 칸은 건너뜀)
function correctedText(word, field) {
  const t = word.text;
  const ocr = String(field.ocrValue ?? ''), fin = String(field.finalValue ?? '');
  if (!fin) return null;
  if (['totalAmount', 'taxAmount'].includes(field.fieldName)) {
    // 원문의 숫자 덩어리 중 OCR 값과 숫자가 같은 것을 확정 금액으로 (쉼표 표기는 원문을 따름)
    const m = [...t.matchAll(/\d[\d,.\s]*\d|\d/g)].find((x) => digits(x[0]) === digits(ocr));
    if (!m) return null;
    const rep = /[,.]/.test(m[0]) ? withCommas(fin) : digits(fin);
    return t.slice(0, m.index) + rep + t.slice(m.index + m[0].length);
  }
  if (['issueDate', 'dueDate', 'billingMonth'].includes(field.fieldName)) return null; // 날짜는 표기가 제각각이라 자동 변환하지 않음
  if (ocr && t.includes(ocr)) return t.replace(ocr, fin);
  return null;
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'images'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'rec'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'eval', 'labels'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'eval', 'images'), { recursive: true });
  const label = [], recTrain = [], recVal = [], kie = [];
  const stat = { samples: 0, skipped: 0, recCorrected: 0, recConfirmed: 0, recSkipped: 0 };

  for (const file of inputs) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.format !== 'chalkak-training-v1') throw new Error(`${file}: 앱에서 내보낸 학습 데이터 파일이 아닙니다`);
    for (const s of data.samples) {
      if (!s.image || !s.ocr) { stat.skipped++; continue; } // 이미지나 최초 OCR 결과가 없는 문서
      stat.samples++;
      const ext = s.image.mime === 'image/png' ? 'png' : s.image.mime === 'image/webp' ? 'webp' : 'jpg';
      const imgName = `${s.documentId}.${ext}`;
      const buf = Buffer.from(s.image.base64, 'base64');
      fs.writeFileSync(path.join(OUT, 'images', imgName), buf);
      fs.writeFileSync(path.join(OUT, 'eval', 'images', imgName), buf);
      const meta = await sharp(buf).metadata();

      // 상자별 정답 글자: 기본은 OCR 글자, 검수로 고친 칸은 고친 값
      const words = s.ocr.result.words.map((w) => ({ ...w, label: w.text, source: 'ocr' }));
      for (const f of s.fields) {
        if (!f.box) continue;
        const w = words.find((x) => sameBox(x.box, f.box));
        if (!w) continue;
        if (f.corrected) {
          const fixed = correctedText(w, f);
          if (fixed) { w.label = fixed; w.source = 'corrected'; } else w.source = 'unsure';
        } else if (w.confidence >= MIN_CONF) w.source = 'confirmed';
      }
      label.push(`images/${imgName}\t${JSON.stringify(words.map((w) => ({
        transcription: w.source === 'unsure' ? '###' : w.label,
        points: [[w.box[0], w.box[1]], [w.box[2], w.box[1]], [w.box[2], w.box[3]], [w.box[0], w.box[3]]],
        difficult: w.source === 'unsure',
      })))}`);

      // 인식 모델용 잘라낸 줄: 사람이 확인한 칸(고친 칸 + 고치지 않은 고신뢰 칸)만
      for (const [i, w] of words.entries()) {
        if (w.source !== 'corrected' && w.source !== 'confirmed') { if (w.source === 'unsure') stat.recSkipped++; continue; }
        const pad = Math.round((w.box[3] - w.box[1]) * 0.1);
        const left = Math.max(0, w.box[0] - pad), top = Math.max(0, w.box[1] - pad);
        const width = Math.min(meta.width - left, w.box[2] - w.box[0] + pad * 2);
        const height = Math.min(meta.height - top, w.box[3] - w.box[1] + pad * 2);
        if (width < 4 || height < 4) continue;
        const crop = `rec/${s.documentId}_${i}.jpg`;
        await sharp(buf).extract({ left, top, width, height }).jpeg({ quality: 92 }).toFile(path.join(OUT, crop));
        (isVal(s.documentId) ? recVal : recTrain).push(`${crop}\t${w.label}`);
        if (w.source === 'corrected') stat.recCorrected++; else stat.recConfirmed++;
      }

      const ocrFields = s.ocr.parsed?.data || {};
      kie.push(JSON.stringify({
        documentId: s.documentId, documentType: s.documentType, image: `images/${imgName}`,
        ocrFields, finalFields: s.finalFields, ocrItems: s.ocr.parsed?.lineItems || [], finalItems: s.finalItems,
        corrected: s.fields.filter((f) => f.corrected).map((f) => f.fieldName),
      }));

      // tools/eval 라벨 (검수 확정값을 정답으로)
      const ff = s.finalFields;
      const isBill = s.documentType === 'giro' || s.documentType === 'bill';
      const items = (s.finalItems || []).map((it) => ({ 항목명: it.itemName, 수량: it.quantity, 단가: it.unitPrice, 금액: it.amount }));
      const target = isBill
        ? { 문서유형: '고지서', 발행처: ff.vendorName, 고객명: ff.customerName, 납부기한: ff.dueDate, 청구년월: ff.billingMonth, 납기내금액: ff.totalAmount, 부가세: ff.taxAmount, 항목: items }
        : { 문서유형: '거래명세서', 공급자: { 상호: ff.vendorName, 사업자등록번호: ff.businessNumber }, 고객명: ff.customerName, 발행일: ff.issueDate, 납부기한: ff.dueDate, 합계금액: ff.totalAmount, 부가세: ff.taxAmount, 항목: items };
      fs.writeFileSync(path.join(OUT, 'eval', 'labels', `${s.documentId}.json`),
        JSON.stringify({ id: s.documentId, image: imgName, group_id: s.documentId, target }, null, 2));
    }
  }

  fs.writeFileSync(path.join(OUT, 'Label.txt'), label.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'rec_train.txt'), recTrain.join('\n') + (recTrain.length ? '\n' : ''));
  fs.writeFileSync(path.join(OUT, 'rec_val.txt'), recVal.join('\n') + (recVal.length ? '\n' : ''));
  fs.writeFileSync(path.join(OUT, 'kie.jsonl'), kie.join('\n') + (kie.length ? '\n' : ''));
  console.log(`문서 ${stat.samples}건 (건너뜀 ${stat.skipped}) → ${OUT}`);
  console.log(`인식용 줄: 고친 값 ${stat.recCorrected} · 확인된 값 ${stat.recConfirmed} · 자동 변환 못한 고친 칸 ${stat.recSkipped}`);
  console.log(`train ${recTrain.length} / val ${recVal.length}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
