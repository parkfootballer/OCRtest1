// 비품 재고: 검수 완료된 거래명세서·세금계산서의 품목을 입고 내역으로 반영한다.
// 문서 하나의 입고 내역은 항상 "지우고 다시 만들기"로 맞추므로 몇 번을 호출해도 결과가 같다(멱등).
const { findDuplicates } = require('./duplicates');

const INVENTORY_TYPES = ['invoice', 'tax_invoice'];
// 품목명 비교 키: 공백·괄호·문장부호·대소문자 무시 ("A4 용지(80g)" = "a4용지80g")
const itemKey = (s) => String(s || '').toLowerCase().replace(/[\s()[\]{}<>.,·'"\-_/*~:;]/g, '');
const unitKey = (s) => itemKey(s).replace(/^(ea|개)$/, 'ea');

async function syncInventory(c, documentId, userId) {
  const doc = (await c.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [documentId])).rows[0];
  if (!doc) return { status: 'none', applied: 0 };
  // 같은 업장의 반영 작업은 한 번에 하나씩 → 동시에 검수한 중복 문서가 둘 다 반영되는 일을 막는다
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`inventory:${doc.workplace_id}`]);
  await c.query('DELETE FROM inventory_movements WHERE document_id = $1', [documentId]);

  let status = 'none';
  let applied = 0;
  if (doc.status === 'verified' && INVENTORY_TYPES.includes(doc.document_type)) {
    if (doc.duplicate_decision === 'duplicate') {
      status = 'skipped_duplicate';
    } else if (doc.duplicate_decision !== 'distinct') {
      // 중복 확인을 거치지 않은 문서라도, 정확히 일치하는 문서가 이미 재고에 반영돼 있으면 반영하지 않는다
      const hit = (await findDuplicates(c, doc.workplace_id, { docId: documentId }))
        .find((d) => d.level === 'exact' && d.document.inventoryStatus === 'applied');
      if (hit) {
        status = 'skipped_duplicate';
        await c.query(`UPDATE documents SET duplicate_of = $1, duplicate_decision = 'duplicate' WHERE id = $2`,
          [hit.document.id, documentId]);
      }
    }
    if (status !== 'skipped_duplicate') {
      const { rows: items } = await c.query(
        `SELECT l.* FROM line_items l JOIN extracted_data e ON e.id = l.extracted_data_id
          WHERE e.document_id = $1 ORDER BY l.line_no`,
        [documentId],
      );
      for (const it of items) {
        const name = String(it.item_name || '').trim();
        const qty = Number(it.quantity);
        if (!itemKey(name) || !(qty > 0)) continue; // 품목명·수량이 확인된 줄만 반영
        const unit = String(it.unit || '').trim();
        const { rows } = await c.query(
          `INSERT INTO inventory_items (workplace_id, name, name_key, unit, unit_key) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (workplace_id, name_key, unit_key) DO UPDATE SET name = inventory_items.name
           RETURNING id`,
          [doc.workplace_id, name, itemKey(name), unit, unitKey(unit)],
        );
        await c.query(
          `INSERT INTO inventory_movements (workplace_id, item_id, document_id, line_no, kind, quantity, item_name, created_by)
           VALUES ($1, $2, $3, $4, 'in', $5, $6, $7)`,
          [doc.workplace_id, rows[0].id, documentId, it.line_no, qty, name, userId || null],
        );
        applied++;
      }
      if (applied) status = 'applied';
    }
  }
  await c.query('UPDATE documents SET inventory_status = $1 WHERE id = $2', [status, documentId]);
  return { status, applied };
}

// 문서에 연결된 입고 내역 (검수 화면·삭제 확인용)
async function documentMovements(c, documentId) {
  const { rows } = await c.query(
    `SELECT m.line_no, m.quantity, m.item_name, i.id AS item_id, i.name, i.unit
       FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id
      WHERE m.document_id = $1 ORDER BY m.line_no`,
    [documentId],
  );
  return rows.map((r) => ({ itemId: r.item_id, lineNo: r.line_no, name: r.name, itemName: r.item_name, unit: r.unit, quantity: r.quantity }));
}

module.exports = { syncInventory, documentMovements, itemKey, INVENTORY_TYPES };
