export function roundGold99(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 1e6) / 1e6;
}

export function normalizeGoldConversion99(sold, bought, conversion, oldDebt = 0) {
  const sold99 = roundGold99(sold);
  const bought99 = roundGold99(bought);
  const remaining99 = roundGold99(sold99 - bought99 + Number(oldDebt));
  const conversion99 = roundGold99(conversion);

  // Giao diện hiển thị/cho nhập 3 số lẻ. Nếu nhân viên nhập đúng số đang thấy để tất
  // toán vàng, khớp phần sai số dưới nửa đơn vị hiển thị về số còn lại chính xác.
  return conversion99 !== 0 && Math.sign(conversion99) === Math.sign(remaining99)
    && Math.abs(remaining99 - conversion99) < 0.0005 ? remaining99 : conversion99;
}

// Accept either decimal separator, but never silently truncate malformed input.
export function parseGoldInput(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text) return 0;
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) ? Number(text) : NaN;
}

export function isGoldConversionValid(sold, bought, conversion, oldDebt = 0) {
  if (![sold, bought, conversion, oldDebt].every(value => Number.isFinite(Number(value)))) return false;
  const remaining = Math.round(Number(sold) * 1e6) - Math.round(Number(bought) * 1e6) + Math.round(Number(oldDebt) * 1e6);
  const converted = Math.round(Number(conversion) * 1e6);
  return remaining >= 0
    ? converted >= 0 && converted <= remaining
    : converted <= 0 && converted >= remaining;
}

// Toa đã tất toán khi tiền đã thu/hoàn đủ theo đúng chiều của tổng toa VÀ không còn nợ vàng.
export function isOrderSettled(total, initialPaymentAmount, goldDebt99, goldEpsilon = 0.000001) {
  const hasOutstandingGold = Math.abs(goldDebt99) > goldEpsilon;
  const moneySettled = total === 0 || (initialPaymentAmount !== 0 && (
    (total >= 0 && total - initialPaymentAmount <= 0)
    || (total < 0 && total - initialPaymentAmount >= 0)
  ));
  return moneySettled && !hasOutstandingGold;
}
