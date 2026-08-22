import {
  Controller,
  Post,
  Headers,
  HttpCode,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
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
  async execute(
    @Headers('x-api-key') apiKey: string,
  ): Promise<{ success: boolean; signalsSent: number }> {
    const expectedKey = this.config.get<string>('CRON_API_KEY');
    if (!expectedKey || apiKey !== expectedKey) {
      throw new UnauthorizedException('Geçersiz API anahtarı');
    }

    this.logger.log('Auto-scan triggered by cron');
    const count = await this.autoScanService.runAutoScan();
    return { success: true, signalsSent: count };
  }
}
