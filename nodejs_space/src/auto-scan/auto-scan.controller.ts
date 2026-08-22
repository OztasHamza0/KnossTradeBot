import {
  Controller,
  Post,
  Headers,
  Query,
  HttpCode,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiQuery } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AutoScanService } from './auto-scan.service';

@ApiTags('Auto Scan')
@Controller('auto-scan')
export class AutoScanController {
  private readonly logger = new Logger(AutoScanController.name);

  constructor(
    private readonly autoScanService: AutoScanService,
    private readonly config: ConfigService,
  ) {}

  @Post('execute')
  @HttpCode(200)
  @ApiOperation({ summary: 'Execute hourly auto-scan (cron endpoint)' })
  @ApiHeader({
    name: 'x-api-key',
    description: 'API key for cron authentication',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    description: 'true ise sohbet basina aralik beklenmez, hepsi hemen taranir',
  })
  async execute(
    @Headers('x-api-key') apiKey: string,
    @Query('force') force?: string,
  ): Promise<{ success: boolean; signalsSent: number }> {
    const expectedKey = this.config.get<string>('CRON_API_KEY');
    if (!expectedKey || apiKey !== expectedKey) {
      throw new UnauthorizedException('Geçersiz API anahtarı');
    }

    this.logger.log(
      `Auto-scan triggered externally (force=${force === 'true'})`,
    );
    const count = await this.autoScanService.runAutoScan(force === 'true');
    return { success: true, signalsSent: count };
  }
}
