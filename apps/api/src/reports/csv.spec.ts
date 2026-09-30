import { describe, expect, it } from 'vitest';
import { csvRow } from './reports.service.js';

describe('csvRow', () => {
  it('neutralises spreadsheet formulas but keeps negative amounts numeric', () => {
    expect(csvRow(['=HYPERLINK("x")', '+1', '@cmd', '-850.00', 'plain'])).toBe(
      `"'=HYPERLINK(""x"")","'+1","'@cmd","-850.00","plain"`,
    );
  });
});
