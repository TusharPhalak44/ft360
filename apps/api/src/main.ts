import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureNestApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const config = configureNestApp(app);

  app.enableShutdownHooks();

  await app.listen(config.apiPort, config.apiHost);
  logger.log(
    `${config.brandingDefaults.productName} API listening on http://${config.apiHost}:${config.apiPort}/api/v1 (Swagger: /api/docs)`,
  );
}

void bootstrap();

