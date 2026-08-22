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

  await registerTelegramWebhook(app.get(TelegramService), logger);
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

  try {
    const url = `${publicUrl}/webhook/telegram`;
    await telegram.setWebhook(url);
    logger.log(`Telegram webhook kuruldu: ${url}`);
  } catch (error: any) {
    logger.error(`Telegram webhook kurulamadi: ${error?.message}`);
  }
}

void bootstrap();
