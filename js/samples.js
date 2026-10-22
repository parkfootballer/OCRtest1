// 카메라 없이 흐름을 시험해 볼 수 있는 샘플 문서 이미지 생성기
const Samples = (() => {
  function canvas() {
    const c = document.createElement('canvas');
    c.width = 1240; c.height = 1500;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#111';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.textBaseline = 'middle';
    return [c, ctx];
  }
  const font = (px, bold) => `${bold ? 'bold ' : ''}${px}px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;

  function invoice() {
    const [c, ctx] = canvas();
    ctx.font = font(64, true);
    ctx.textAlign = 'center';
    ctx.fillText('거 래 명 세 서', 620, 110);
    ctx.textAlign = 'left';
    ctx.font = font(34);
    const rows = [
      '작성일자: 2026.10.15',
      '공급자 상호: (주)한빛문구',
      '등록번호: 123-45-67891',
      '공급받는자: 미래상사',
      '등록번호: 220-81-62517',
    ];
    rows.forEach((t, i) => ctx.fillText(t, 90, 220 + i * 60));

    ctx.font = font(34, true);
    const y0 = 580;
    ctx.fillText('품목', 90, y0); ctx.fillText('수량', 560, y0); ctx.fillText('단가', 740, y0); ctx.fillText('금액', 970, y0);
    ctx.beginPath(); ctx.moveTo(80, y0 + 35); ctx.lineTo(1160, y0 + 35); ctx.stroke();
    ctx.font = font(34);
    const items = [
      ['A4 복사용지', 10, 25000],
      ['볼펜 흑색', 50, 800],
      ['토너 카트리지', 2, 85000],
    ];
    items.forEach(([n, q, u], i) => {
      const y = y0 + 90 + i * 70;
      ctx.fillText(n, 90, y);
      ctx.fillText(String(q), 560, y);
      ctx.fillText(u.toLocaleString('ko-KR'), 740, y);
      ctx.fillText((q * u).toLocaleString('ko-KR'), 970, y);
    });
    ctx.beginPath(); ctx.moveTo(80, 900); ctx.lineTo(1160, 900); ctx.stroke();
    ctx.fillText('공급가액: 460,000', 90, 960);
    ctx.fillText('세액: 46,000', 90, 1020);
    ctx.font = font(40, true);
    ctx.fillText('합계금액: 506,000 원', 90, 1100);
    return c.toDataURL('image/png');
  }

  function giro() {
    const [c, ctx] = canvas();
    ctx.font = font(60, true);
    ctx.textAlign = 'center';
    ctx.fillText('지 로 납 부 고 지 서', 620, 110);
    ctx.textAlign = 'left';
    ctx.font = font(36);
    const rows = [
      '수납기관: 한국전력공사',
      '사업자번호: 220-81-62517',
      '고지일: 2026.10.05',
      '납부기한: 2026.10.31',
      '고객번호: 0123 4567 89',
      '사용기간: 2026.09.01 ~ 2026.09.30',
      '',
      '전기요금: 78,400',
      '부가가치세: 7,840',
      '전력기금: 2,900',
    ];
    rows.forEach((t, i) => ctx.fillText(t, 90, 230 + i * 66));
    ctx.font = font(44, true);
    ctx.fillText('납부금액: 89,140 원', 90, 980);
    return c.toDataURL('image/png');
  }

  return { invoice, giro };
})();
