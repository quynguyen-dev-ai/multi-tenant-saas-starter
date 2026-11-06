import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody is required to verify Stripe webhook signatures.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableCors({ origin: process.env.APP_URL ?? 'http://localhost:3000' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('Multi-tenant SaaS Starter API')
    .setDescription('Organizations, RBAC, invitations, plan limits, Stripe billing and audit log')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc));

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  Logger.log(`API on :${port} · docs at /docs`, 'Bootstrap');
}

void bootstrap();
