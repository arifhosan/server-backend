import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TokenDaysDto } from './dto/token-days.dto';
import { TokenDay } from './entities/token-day.entity';
import { TokensAuthGuard } from './tokens-auth.guard';
import { berlinToday, lastDays, PublicTokenDay } from './tokens.util';

@Controller('tokens')
export class TokensController {
  constructor(
    @InjectRepository(TokenDay)
    private readonly repository: Repository<TokenDay>,
  ) {}

  /** Public, read by the portfolio hero. Only per-day totals leave the server. */
  @Get('last7')
  async last7(): Promise<PublicTokenDay[]> {
    const rows = await this.repository.find({
      order: { date: 'DESC' },
      take: 7,
    });
    return lastDays(rows, berlinToday(), 7);
  }

  /** Upsert by date. The poster resends the last 8 days so a missed run heals itself. */
  @Post()
  @UseGuards(TokensAuthGuard)
  async upsert(@Body() body: TokenDaysDto): Promise<{ stored: number }> {
    await this.repository.upsert(body.days, ['date']);
    return { stored: body.days.length };
  }
}
