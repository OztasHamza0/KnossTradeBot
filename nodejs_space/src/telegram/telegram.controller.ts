import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  Get,
  HttpCode,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

@ApiTags('Telegram Webhook')
@Controller('webhook')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  @Post('telegram')
  @HttpCode(200)
  @ApiOperation({ summary: 'Telegram webhook endpoint' })
  handleWebhook(
    @Body() body: any,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string,
  ): { ok: boolean } {
    // The webhook URL is public. When a secret is configured, Telegram echoes
    // it on every call, so anything without it is not Telegram.
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (expected && secretToken !== expected) {
      this.logger.warn('Rejected webhook call with invalid secret token');
      throw new UnauthorizedException();
    }

    // Telegram retries any update it does not get a prompt 200 for, and an
    // LLM turn takes far longer than that window — so acknowledge first and
    // process in the background.
    this.telegramService.processUpdate(body).catch((err) => {
      this.logger.error(
        `Error processing Telegram update: ${err?.message}`,
        err?.stack,
      );
    });

    return { ok: true };
  }

  @Get('health')
  @ApiOperation({ summary: 'Health check' })
  health(): { status: string; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
