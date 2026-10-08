import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidInvoiceDate, localInvoiceDate } from '../public/js/invoice-date.js';

test('invoice dates reject invalid calendar dates and accept leap days', () => {
  for (const value of ['2024-02-29', '2026-10-08', '2026-01-01']) assert.equal(isValidInvoiceDate(value), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '', null, 123, '08/10/2026', '0000-01-01']) assert.equal(isValidInvoiceDate(value), false);
});

test('date input defaults to local calendar day', () => {
  assert.equal(localInvoiceDate(new Date(2026, 9, 8, 0, 1)), '2026-10-08');
});
