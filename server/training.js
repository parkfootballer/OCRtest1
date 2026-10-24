// OCR 학습 데이터: 사람이 검수 완료한 문서의 [이미지, 최초 OCR 결과, 확정값]을 묶어 둔다.
// 저장만 할 뿐 모델이 자동으로 학습되지는 않는다 — 내보낸 뒤 tools/training 으로 PaddleOCR 학습셋을 만든다.

const FIELD_KEYS = ['vendorName', 'businessNumber', 'documentNumber', 'issueDate', 'dueDate', 'totalAmount', 'taxAmount', 'customerName', 'billingMonth'];
const COLUMN = {
  vendorName: 'vendor_name', businessNumber: 'business_number', documentNumber: 'document_number', issueDate: 'issue_date',
  dueDate: 'due_date', totalAmount: 'total_amount', taxAmount: 'tax_amount', customerName: 'customer_name', billingMonth: 'billing_month',
};
const str = (v) => (v == null ? '' : String(v));
const itemsOf = (rows) => rows.map((r) => ({
  itemName: r.item_name ?? r.itemName ?? '', unit: r.unit ?? null, quantity: r.quantity ?? null,
  unitPrice: r.unit_price ?? r.unitPrice ?? null, amount: r.amount ?? null,
}));

async function upsertTrainingSample(c, doc, userId) {
  const ex = (await c.query('SELECT * FROM extracted_data WHERE document_id = $1', [doc.id])).rows[0];
  if (!ex) return null;
  const items = (await c.query('SELECT * FROM line_items WHERE extracted_data_id = $1 ORDER BY line_no', [ex.id])).rows;
  const ocr = (await c.query('SELECT * FROM ocr_results WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1', [doc.id])).rows[0];
  const imageId = String(doc.image_url || '').split('/').pop() || null;

  const finalFields = Object.fromEntries(FIELD_KEYS.map((k) => [k, ex[COLUMN[k]] ?? null]));
  const ocrData = ocr?.parsed?.data || {};
  const boxes = ocr?.parsed?.fieldBoxes || {};
  const conf = ocrData.fieldConfidence || {};
  const finalItems = itemsOf(items);
  const ocrItems = itemsOf(ocr?.parsed?.lineItems || []);

  const rows = FIELD_KEYS
    .filter((k) => str(ocrData[k]) || str(finalFields[k]))
    .map((k) => ({ field: k, ocr: str(ocrData[k]), final: str(finalFields[k]), conf: conf[k] ?? null, box: boxes[k] || null }));
  rows.push({ field: 'documentType', ocr: str(ocr?.parsed?.documentType), final: doc.document_type, conf: null, box: null });
  rows.push({ field: 'lineItems', ocr: JSON.stringify(ocrItems), final: JSON.stringify(finalItems), conf: null, box: null });
  const corrected = rows.filter((r) => r.ocr !== r.final).length;

  await c.query('DELETE FROM training_samples WHERE document_id = $1', [doc.id]);
  const { rows: [sample] } = await c.query(
    `INSERT INTO training_samples (workplace_id, document_id, image_id, ocr_result_id, document_type,
       final_fields, final_items, final_text, corrected_count, verified_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [doc.workplace_id, doc.id, /^[0-9a-f-]{36}$/i.test(imageId) ? imageId : null, ocr?.id || null, doc.document_type,
      JSON.stringify(finalFields), JSON.stringify(finalItems), ex.raw_text || '', corrected, userId],
  );
  for (const r of rows) {
    await c.query(
      `INSERT INTO training_fields (sample_id, workplace_id, document_type, field_name, ocr_value, final_value, corrected, ocr_confidence, box)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [sample.id, doc.workplace_id, doc.document_type, r.field, r.ocr, r.final, r.ocr !== r.final,
        r.conf == null ? null : Math.round(r.conf * 1000) / 1000, r.box ? JSON.stringify(r.box) : null],
    );
  }
  return sample.id;
}

async function trainingStats(c, workplaceId) {
  const byType = (await c.query(
    `SELECT document_type, count(*)::int AS samples, sum(corrected_count)::int AS corrections
       FROM training_samples WHERE workplace_id = $1 GROUP BY document_type ORDER BY document_type`,
    [workplaceId],
  )).rows;
  const byField = (await c.query(
    `SELECT document_type, field_name, count(*)::int AS total, count(*) FILTER (WHERE corrected)::int AS corrected
       FROM training_fields WHERE workplace_id = $1 GROUP BY document_type, field_name ORDER BY document_type, field_name`,
    [workplaceId],
  )).rows;
  return {
    byType: byType.map((r) => ({ documentType: r.document_type, samples: r.samples, corrections: r.corrections || 0 })),
    byField: byField.map((r) => ({ documentType: r.document_type, fieldName: r.field_name, total: r.total, corrected: r.corrected })),
  };
}

// 내보내기: 이미지(base64)·최초 OCR·확정값을 한 파일로. 업장 범위 밖의 데이터는 조회 조건에서 걸러진다
async function exportSamples(c, workplaceId, { documentType, limit = 50, offset = 0 }) {
  const params = [workplaceId];
  let where = 's.workplace_id = $1';
  if (documentType) { params.push(documentType); where += ` AND s.document_type = $${params.length}`; }
  const total = (await c.query(`SELECT count(*)::int AS n FROM training_samples s WHERE ${where}`, params)).rows[0].n;
  params.push(limit, offset);
  const { rows } = await c.query(
    `SELECT s.*, i.mime, i.data, o.engine, o.model_version, o.result, o.parsed
       FROM training_samples s
       LEFT JOIN images i ON i.id = s.image_id
       LEFT JOIN ocr_results o ON o.id = s.ocr_result_id
      WHERE ${where}
      ORDER BY s.verified_at
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const fields = rows.length ? (await c.query(
    'SELECT * FROM training_fields WHERE sample_id = ANY($1) ORDER BY field_name',
    [rows.map((r) => r.id)],
  )).rows : [];
  return {
    total, limit, offset,
    samples: rows.map((r) => ({
      id: r.id, documentId: r.document_id, documentType: r.document_type, verifiedAt: r.verified_at,
      image: r.data ? { mime: r.mime, base64: r.data.toString('base64') } : null,
      ocr: r.result ? { engine: r.engine, modelVersion: r.model_version, result: r.result, parsed: r.parsed } : null,
      finalFields: r.final_fields, finalItems: r.final_items, finalText: r.final_text,
      fields: fields.filter((f) => f.sample_id === r.id).map((f) => ({
        fieldName: f.field_name, ocrValue: f.ocr_value, finalValue: f.final_value, corrected: f.corrected,
        ocrConfidence: f.ocr_confidence, box: f.box,
      })),
    })),
  };
}

module.exports = { upsertTrainingSample, trainingStats, exportSamples };
