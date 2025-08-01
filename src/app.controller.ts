import { Controller, Get, Post, Body, Headers } from '@nestjs/common';
import { AppService } from './app.service';

export interface ContentBriefDto {
  prompt: string;
  contentType: 'blog' | 'landing' | 'product' | 'social';
  targetKeywords: string[];
  targetAudience: string;
  tone: 'professional' | 'casual' | 'technical' | 'friendly';
  language: string;
}

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'SEO SEA Vision Pro API',
      version: '1.0.0',
      redis: 'Not connected (simplified version)',
      perplexity: 'Not configured (simplified version)',
    };
  }

  @Post('api/content-brief')
  async generateContentBrief(
    @Body() body: ContentBriefDto,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    if (!tenantId) {
      return { error: 'x-tenant-id header required' };
    }

    // Version simplifiée pour tester l'API
    return {
      success: true,
      message: 'ContentBrief API is working! Configure Perplexity API for full functionality.',
      data: {
        id: 'test-' + Date.now(),
        title: `Generated brief for: ${body.prompt}`,
        contentType: body.contentType,
        targetKeywords: body.targetKeywords,
        cached: false,
        generatedAt: new Date(),
        note: 'This is a test response. Configure Redis and Perplexity API for full functionality.',
      },
      tenantId,
    };
  }
}
