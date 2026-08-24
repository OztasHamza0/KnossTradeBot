import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TelegramService } from './telegram/telegram.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.enableCors();
  app.enableShutdownHooks();

  const swaggerPath = 'api-docs';
  app.use(
    `/${swaggerPath}`,
    (req: Request, res: Response, next: NextFunction) => {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, proxy-revalidate',
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
      next();
    },
  );

  const config = new DocumentBuilder()
    .setTitle('Kripto Trading Bot API')
    .setDescription('Telegram kripto trading asistanı bot API dokümantasyonu')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(swaggerPath, app, document, {
    customSiteTitle: 'Kripto Trading Bot API',
    customCss: `
      .swagger-ui .topbar { display: none; }
      .swagger-ui .info { margin: 30px 0; }
      .swagger-ui .info .title { font-size: 2em; color: #1a1a2e; }
      .swagger-ui .scheme-container { background: #f8f9fa; padding: 15px; }
    `,
  });

  // Hosting platforms assign the port; 3000 is only the local default.
  const port = parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port, '0.0.0.0');

  logger.log(`Kripto Trading Bot ${port} portunda calisiyor`);
  logger.log(`Swagger: /${swaggerPath}`);

  const telegram = app.get(TelegramService);
  await registerTelegramWebhook(telegram, logger);
  await registerTelegramCommands(telegram, logger);
}

/**
 * Retries a boot-time Telegram call.
 *
 * A freshly started container's network is not always ready the instant the
 * app is: in production both boot calls timed out at 20s on the first try.
 * One attempt is too few — a failed setWebhook leaves the bot unable to
 * receive anything if the URL has changed.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  logger: Logger,
  attempts = 4,
): Promise<T | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error: any) {
      const last = i === attempts;
      if (last) {
        logger.error(
          `${label} basarisiz (${i}/${attempts}): ${error?.message}`,
        );
        return null;
      }
      // 3s, 9s, 27s — enough spread to outlast a slow cold start.
      const waitMs = 3000 * Math.pow(3, i - 1);
      logger.warn(
        `${label} basarisiz (${i}/${attempts}): ${error?.message} — ` +
          `${waitMs / 1000}s sonra tekrar denenecek`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  return null;
}

/**
 * Publishes the "/" menu. Independent of the webhook: it needs only the bot
 * token, so it still works when PUBLIC_URL is unset.
 */
async function registerTelegramCommands(
  telegram: TelegramService,
  logger: Logger,
): Promise<void> {
  // Cosmetic only — the bot still answers typed commands without a menu, so
  // this gets fewer attempts than the webhook.
  const ok = await withRetry(
    'Telegram komut menusu',
    () => telegram.setMyCommands(),
    logger,
    2,
  );
  if (ok !== null) logger.log('Telegram komut menusu guncellendi');
}

/**
 * Points Telegram at this deployment on every boot. PUBLIC_URL changes each
 * time the app is redeployed on most platforms, so this is re-run rather than
 * being a one-off manual curl.
 */
async function registerTelegramWebhook(
  telegram: TelegramService,
  logger: Logger,
): Promise<void> {
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '');

  if (!publicUrl) {
    logger.warn(
      'PUBLIC_URL tanimli degil — webhook otomatik kurulmadi. ' +
        'Telegram mesajlari GELMEZ. Canli URL ile PUBLIC_URL ayarla ve yeniden baslat.',
    );
    return;
  }

  const url = `${publicUrl}/webhook/telegram`;
  const ok = await withRetry(
    'Telegram webhook kurulumu',
    () => telegram.setWebhook(url),
    logger,
  );

  if (ok !== null) {
    logger.log(`Telegram webhook kuruldu: ${url}`);
  } else {
    logger.error(
      `Telegram webhook KURULAMADI: ${url}\n` +
        `Adres degismediyse Telegram'daki onceki kayit gecerli kalir ve ` +
        `mesajlar gelmeye devam eder. Adres degistiyse bot mesaj ALAMAZ — ` +
        `servisi yeniden baslat ya da setWebhook'u elle cagir.`,
    );
  }
}

void bootstrap();
