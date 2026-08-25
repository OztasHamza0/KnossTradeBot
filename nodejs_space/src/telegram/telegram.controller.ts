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
    // Webhook adresi herkese acik. Telegram, ayarlanmis secret'i her cagrida
    // geri gonderiyor; dolayisiyla secret tasimayan istek Telegram degildir.
    //
    // Eskiden secret TANIMSIZ oldugunda dogrulama tamamen atlaniyordu — yani
    // degiskeni unutmak, endpoint'i sessizce herkese acik birakiyordu.
    // Ayni dosyadaki cron endpoint'i zaten tam tersini yapiyor (anahtar yoksa
    // reddediyor); ikisi ayni davranmali. render.yaml bu degeri kendisi
    // uretiyor, o yuzden uretimde her zaman tanimli olur.
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    if (!expected) {
      this.logger.error(
        'TELEGRAM_WEBHOOK_SECRET tanimli degil — webhook istekleri REDDEDILIYOR. ' +
          'Degiskeni ayarlayip servisi yeniden baslat.',
      );
      throw new UnauthorizedException();
    }
    if (secretToken !== expected) {
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
