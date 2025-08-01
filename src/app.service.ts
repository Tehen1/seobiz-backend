import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return '🚀 SEO SEA Vision Pro API - Content Brief Generator is running!';
  }
}
