import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../../common/auth/auth.types';
import { CurrentUser } from '../../../common/auth/current-user.decorator';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import {
  CalendarQueryDto,
  LibraryQueryDto,
  PeriodQueryDto,
  SessionsQueryDto,
} from './stats.dto';
import { StatsService } from './stats.service';
import {
  DayPoint,
  GameDetail,
  LibraryEntry,
  Overview,
  Period,
  SessionRow,
} from './stats.types';

@Controller('games')
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser): Promise<Overview> {
    return this.stats.overview(user.userId);
  }

  @Get('sessions')
  sessions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: SessionsQueryDto,
  ): Promise<SessionRow[]> {
    return this.stats.sessions(user.userId, q);
  }

  @Get('library')
  library(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: LibraryQueryDto,
  ): Promise<LibraryEntry[]> {
    return this.stats.library(user.userId, q);
  }

  @Get('library/:id')
  game(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<GameDetail> {
    return this.stats.game(user.userId, id);
  }

  @Get('calendar')
  calendar(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: CalendarQueryDto,
  ): Promise<DayPoint[]> {
    return this.stats.calendar(user.userId, q.year);
  }

  @Get('period')
  period(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: PeriodQueryDto,
  ): Promise<Period> {
    return this.stats.period(user.userId, q);
  }
}
