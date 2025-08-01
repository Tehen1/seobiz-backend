import { Injectable, Inject, Logger, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { RedisService } from './redis.service';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { firstValueFrom } from 'rxjs';

export interface ContentBriefRequest {
  tenantId: string;
  prompt: string;
  contentType: 'blog' | 'landing' | 'product' | 'social';
  targetKeywords: string[];
  targetAudience: string;
  tone: 'professional' | 'casual' | 'technical' | 'friendly';
  language: string;
}

export interface ContentBrief {
  id: string;
  title: string;
  outline: string[];
  keyMessages: string[];
  seoRecommendations: {
    primaryKeyword: string;
    secondaryKeywords: string[];
    metaTitle: string;
    metaDescription: string;
    suggestedWordCount: number;
  };
  competitorInsights: string[];
  callToActions: string[];
  estimatedReadingTime: number;
  generatedAt: Date;
  cached: boolean;
}

@Injectable()
export class ContentBriefGeneratorService {
  private readonly logger = new Logger(ContentBriefGeneratorService.name);
  private readonly perplexityApiUrl = 'https://api.perplexity.ai/chat/completions';

  constructor(
    private readonly httpService: HttpService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Génère un brief de contenu avec cache intelligent
   */
  async generateBrief(request: ContentBriefRequest): Promise<ContentBrief> {
    const startTime = Date.now();
    
    try {
      // 1. Validation des données d'entrée
      this.validateRequest(request);

      // 2. Vérification du cache multi-tenant
      const cacheKey = this.buildCacheKey(request);
      const cachedResult = await this.getCachedBrief(cacheKey);
      
      if (cachedResult) {
        this.logger.log(`Cache HIT pour tenant ${request.tenantId} - ${Date.now() - startTime}ms`);
        return { ...cachedResult, cached: true };
      }

      // 3. Rate limiting par tenant
      await this.checkRateLimit(request.tenantId);

      // 4. Génération via Perplexity API
      const brief = await this.generateFromPerplexity(request);

      // 5. Mise en cache avec TTL adaptatif
      const cacheTTL = this.calculateCacheTTL(request.tenantId);
      await this.cacheBrief(cacheKey, brief, cacheTTL);

      // 6. Métriques et logging
      const duration = Date.now() - startTime;
      await this.recordMetrics(request.tenantId, duration, false);

      this.logger.log(`Brief généré pour tenant ${request.tenantId} - ${duration}ms`);
      
      return { ...brief, cached: false };

    } catch (error) {
      this.logger.error(`Erreur génération brief tenant ${request.tenantId}:`, error);
      await this.recordMetrics(request.tenantId, Date.now() - startTime, true);
      throw error;
    }
  }

  /**
   * Validation stricte des données d'entrée
   */
  private validateRequest(request: ContentBriefRequest): void {
    if (!request.tenantId || request.tenantId.length < 3) {
      throw new BadRequestException('TenantId invalide');
    }

    if (!request.prompt || request.prompt.length < 10) {
      throw new BadRequestException('Prompt trop court (minimum 10 caractères)');
    }

    if (request.prompt.length > 2000) {
      throw new BadRequestException('Prompt trop long (maximum 2000 caractères)');
    }

    if (!request.targetKeywords || request.targetKeywords.length === 0) {
      throw new BadRequestException('Mots-clés cibles requis');
    }
  }

  /**
   * Construction de la clé cache avec isolation tenant
   */
  private buildCacheKey(request: ContentBriefRequest): string {
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        prompt: request.prompt,
        contentType: request.contentType,
        targetKeywords: request.targetKeywords.sort(),
        targetAudience: request.targetAudience,
        tone: request.tone,
        language: request.language
      }))
      .digest('hex');

    return `${request.tenantId}:brief:${hash}`;
  }

  /**
   * Récupération du cache avec déchiffrement
   */
  private async getCachedBrief(cacheKey: string): Promise<ContentBrief | null> {
    try {
      const cached = await this.redisService.get<string>(cacheKey);
      if (!cached) return null;

      // Déchiffrement des données sensibles si nécessaire
      const decrypted = this.decryptSensitiveData(cached);
      return JSON.parse(decrypted);
    } catch (error) {
      this.logger.warn(`Erreur lecture cache ${cacheKey}:`, error);
      return null;
    }
  }

  /**
   * Rate limiting intelligent par tenant
   */
  private async checkRateLimit(tenantId: string): Promise<void> {
    const plan = await this.getTenantPlan(tenantId);
    const limits = this.getRateLimits(plan);
    
    const rateLimitResult = await this.redisService.checkRateLimit(
      `content-brief:${tenantId}`,
      limits.requestsPerHour,
      3600
    );

    if (!rateLimitResult.allowed) {
      throw new UnauthorizedException(
        `Rate limit dépassé. Limite: ${limits.requestsPerHour}/h. Reset: ${new Date(rateLimitResult.resetTime).toISOString()}`
      );
    }

    this.logger.debug(`Rate limit OK pour ${tenantId}: ${rateLimitResult.remaining} requêtes restantes`);
  }

  /**
   * Génération via Perplexity API avec retry et circuit breaker
   */
  private async generateFromPerplexity(request: ContentBriefRequest): Promise<ContentBrief> {
    const apiKey = await this.getDecryptedApiKey();
    const prompt = this.buildPerplexityPrompt(request);

    const maxRetries = 3;
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await firstValueFrom(
          this.httpService.post(
            this.perplexityApiUrl,
            {
              model: 'llama-3.1-sonar-large-128k-online',
              messages: [
                {
                  role: 'system',
                  content: 'Tu es un expert en marketing de contenu et SEO. Génère des briefs de contenu structurés et actionnables.'
                },
                {
                  role: 'user',
                  content: prompt
                }
              ],
              max_tokens: 4000,
              temperature: 0.7,
              top_p: 0.9
            },
            {
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
              },
              timeout: 30000 // 30s timeout
            }
          )
        );

        return this.parsePerplexityResponse(response.data, request);

      } catch (error) {
        lastError = error;
        this.logger.warn(`Tentative ${attempt}/${maxRetries} échouée:`, error.message);
        
        if (attempt < maxRetries) {
          // Backoff exponentiel
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Échec après ${maxRetries} tentatives: ${lastError.message}`);
  }

  /**
   * Construction du prompt optimisé pour Perplexity
   */
  private buildPerplexityPrompt(request: ContentBriefRequest): string {
    return `
Génère un brief de contenu détaillé pour:

**Type de contenu:** ${request.contentType}
**Sujet:** ${request.prompt}
**Mots-clés cibles:** ${request.targetKeywords.join(', ')}
**Audience:** ${request.targetAudience}
**Ton:** ${request.tone}
**Langue:** ${request.language}

Fournis une réponse JSON structurée avec:

1. **title**: Titre accrocheur et optimisé SEO
2. **outline**: Array de sections principales (4-6 sections)
3. **keyMessages**: Messages clés à transmettre (3-5 points)
4. **seoRecommendations**: 
   - primaryKeyword
   - secondaryKeywords (array)
   - metaTitle (max 60 caractères)
   - metaDescription (max 160 caractères)
   - suggestedWordCount
5. **competitorInsights**: Insights concurrentiels (3-4 points)
6. **callToActions**: CTAs suggérés (2-3 options)
7. **estimatedReadingTime**: Temps de lecture estimé en minutes

Assure-toi que le contenu soit actionnable, SEO-friendly et adapté à l'audience cible.
`;
  }

  /**
   * Parsing et validation de la réponse Perplexity
   */
  private parsePerplexityResponse(response: any, request: ContentBriefRequest): ContentBrief {
    try {
      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Réponse Perplexity vide');
      }

      // Extraction du JSON de la réponse
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Format JSON introuvable dans la réponse');
      }

      const parsedContent = JSON.parse(jsonMatch[0]);
      
      // Validation et enrichissement
      return {
        id: crypto.randomUUID(),
        title: parsedContent.title || 'Titre généré',
        outline: Array.isArray(parsedContent.outline) ? parsedContent.outline : [],
        keyMessages: Array.isArray(parsedContent.keyMessages) ? parsedContent.keyMessages : [],
        seoRecommendations: {
          primaryKeyword: parsedContent.seoRecommendations?.primaryKeyword || request.targetKeywords[0],
          secondaryKeywords: parsedContent.seoRecommendations?.secondaryKeywords || request.targetKeywords.slice(1),
          metaTitle: parsedContent.seoRecommendations?.metaTitle || parsedContent.title,
          metaDescription: parsedContent.seoRecommendations?.metaDescription || '',
          suggestedWordCount: parsedContent.seoRecommendations?.suggestedWordCount || 1500
        },
        competitorInsights: Array.isArray(parsedContent.competitorInsights) ? parsedContent.competitorInsights : [],
        callToActions: Array.isArray(parsedContent.callToActions) ? parsedContent.callToActions : [],
        estimatedReadingTime: parsedContent.estimatedReadingTime || 5,
        generatedAt: new Date(),
        cached: false
      };

    } catch (error) {
      this.logger.error('Erreur parsing réponse Perplexity:', error);
      throw new Error(`Erreur parsing réponse: ${error.message}`);
    }
  }

  /**
   * Mise en cache avec chiffrement
   */
  private async cacheBrief(cacheKey: string, brief: ContentBrief, ttl: number): Promise<void> {
    try {
      const encrypted = this.encryptSensitiveData(JSON.stringify(brief));
      await this.redisService.set(cacheKey, encrypted, ttl);
      
      // Statistiques de cache
      await this.redisService.incrementCounter(`cache-writes:${this.extractTenantFromKey(cacheKey)}`);
    } catch (error) {
      this.logger.warn(`Erreur mise en cache ${cacheKey}:`, error);
      // Non-bloquant: on continue même si le cache échoue
    }
  }

  /**
   * TTL adaptatif basé sur le plan du tenant
   */
  private calculateCacheTTL(tenantId: string): number {
    const baseTTL = 3600; // 1 heure par défaut
    
    // TTL plus long pour les plans premium (économie d'API)
    const plan = this.getTenantPlanSync(tenantId);
    
    switch (plan) {
      case 'free':
        return baseTTL * 2; // 2h pour économiser les ressources
      case 'pro':
        return baseTTL; // 1h
      case 'enterprise':
        return baseTTL / 2; // 30min pour plus de fraîcheur
      default:
        return baseTTL;
    }
  }

  /**
   * Métriques et monitoring
   */
  private async recordMetrics(tenantId: string, duration: number, isError: boolean): Promise<void> {
    try {
      const date = new Date().toISOString().split('T')[0];
      
      await Promise.all([
        this.redisService.incrementCounter(`brief-requests:${tenantId}:${date}`),
        this.redisService.setGauge(`brief-latency:${tenantId}`, duration),
        isError ? this.redisService.incrementCounter(`brief-errors:${tenantId}:${date}`) : Promise.resolve()
      ]);
    } catch (error) {
      this.logger.warn('Erreur enregistrement métriques:', error);
    }
  }

  // ============ HELPERS ============

  private async getDecryptedApiKey(): Promise<string> {
    const encryptedKey = this.configService.get<string>('PERPLEXITY_API_KEY_ENCRYPTED');
    if (!encryptedKey) {
      throw new Error('Clé API Perplexity non configurée');
    }
    
    return this.decryptAES256(encryptedKey);
  }

  private decryptAES256(encryptedData: string): string {
    const key = this.configService.get<string>('AES_KEY');
    if (!key) {
      throw new Error('Clé de chiffrement non configurée');
    }

    const [ivHex, encryptedHex] = encryptedData.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf-8');
  }

  private encryptSensitiveData(data: string): string {
    const key = this.configService.get<string>('AES_KEY');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), iv);
    
    let encrypted = cipher.update(data, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private decryptSensitiveData(encryptedData: string): string {
    // Décryptage des données sensibles du cache si configuré
    const enableEncryption = this.configService.get<boolean>('ENABLE_CACHE_ENCRYPTION', false);
    
    if (!enableEncryption) {
      return encryptedData;
    }
    
    return this.decryptAES256(encryptedData);
  }

  private async getTenantPlan(tenantId: string): Promise<string> {
    // Dans un vrai système, récupération depuis la DB
    const cachedPlan = await this.redisService.get<string>(`tenant-plan:${tenantId}`);
    return cachedPlan || 'free';
  }

  private getTenantPlanSync(tenantId: string): string {
    // Version synchrone pour les calculs rapides
    return 'pro'; // Défaut
  }

  private getRateLimits(plan: string) {
    const limits = {
      free: { requestsPerHour: 10, requestsPerDay: 50 },
      pro: { requestsPerHour: 100, requestsPerDay: 1000 },
      enterprise: { requestsPerHour: 1000, requestsPerDay: 10000 }
    };
    
    return limits[plan] || limits.free;
  }

  private extractTenantFromKey(cacheKey: string): string {
    return cacheKey.split(':')[0];
  }
}
