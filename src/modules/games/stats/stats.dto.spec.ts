import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PeriodQueryDto } from './stats.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const validate = (from: string, to: string) =>
  pipe.transform({ from, to }, { type: 'query', metatype: PeriodQueryDto });

describe('PeriodQueryDto (I2)', () => {
  it('accepts years 2000-2100', async () => {
    await expect(validate('2000-01-01', '2100-12-31')).resolves.toBeDefined();
  });

  it('rejects other years as a 400', async () => {
    for (const d of ['0099-01-01', '1999-12-31', '2101-01-01', '9999-12-31'])
      await expect(validate(d, '2026-01-01')).rejects.toBeInstanceOf(
        BadRequestException,
      );
  });
});
