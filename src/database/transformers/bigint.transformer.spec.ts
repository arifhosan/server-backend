import { bigintTransformer } from './bigint.transformer';

describe('bigintTransformer', () => {
  describe('from (database -> entity)', () => {
    it('converts the string mysql2 returns for BIGINT into a number', () => {
      expect(bigintTransformer.from('5000')).toBe(5000);
    });

    it('passes a number through unchanged', () => {
      expect(bigintTransformer.from(5000)).toBe(5000);
    });

    it('preserves null', () => {
      expect(bigintTransformer.from(null)).toBeNull();
    });

    it('produces a value that adds rather than concatenates', () => {
      const total = bigintTransformer.from('5000') as number;
      expect(total + 1000).toBe(6000);
      // The bug this guards against: '5000' + 1000 === '50001000'
      expect(total + 1000).not.toBe('50001000');
    });
  });

  describe('to (entity -> database)', () => {
    it('writes numbers unchanged', () => {
      expect(bigintTransformer.to(6000)).toBe(6000);
    });

    it('preserves null', () => {
      expect(bigintTransformer.to(null)).toBeNull();
    });
  });
});
