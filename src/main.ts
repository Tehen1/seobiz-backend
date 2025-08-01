import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Configuration globale
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));
  
  // CORS pour le développement
  app.enableCors({
    origin: ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
  });
  
  // Configuration du port
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  
  await app.listen(port);
  console.log(`🚀 SEO SEA Vision Pro API démarrée sur http://localhost:${port}`);
  console.log(`📊 Health Check: http://localhost:${port}/health`);
}

bootstrap();
