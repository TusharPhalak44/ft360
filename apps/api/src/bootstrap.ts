import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { APP_CONFIG, type AppEnvConfig } from './config/env.config';

export function configureNestApp(app: INestApplication): AppEnvConfig {
  const config = app.get<AppEnvConfig>(APP_CONFIG);

  app.setGlobalPrefix('api/v1');

  app.enableCors({
    origin: config.corsAllowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  if (config.swaggerEnabled) {
    const swaggerDocConfig = new DocumentBuilder()
      .setTitle(`${config.brandingDefaults.productName} REST API`)
      .setDescription(config.brandingDefaults.tagline)
      .setContact('Platform Engineering', config.brandingDefaults.websiteUrl, config.brandingDefaults.supportEmail)
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerDocConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  return config;
}

