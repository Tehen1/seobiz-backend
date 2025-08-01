import Redis from 'ioredis';
import { logger } from '../utils/logger';

export class RedisService {
  private redis: Redis;
  private isConnected = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    this.redis = new Redis(redisUrl, {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      maxLoadingTimeout: 10000,
      enableOfflineQueue: false,
      keepAlive: 30000,
      // Configuration pour la performance
      family: 4,
      connectTimeout: 5000,
      commandTimeout: 5000,
    });

    // Événements de connexion
    this.redis.on('connect', () => {
      logger.info('✅ Connexion Redis établie');
      this.isConnected = true;
    });

    this.redis.on('error', (error) => {
      logger.error('❌ Erreur Redis:', error);
      this.isConnected = false;
    });

    this.redis.on('close', () => {
      logger.warn('⚠️ Connexion Redis fermée');
      this.isConnected = false;
    });

    this.redis.on('reconnecting', () => {
      logger.info('🔄 Reconnexion Redis en cours...');
    });
  }

  async connect(): Promise<void> {
    try {
      await this.redis.connect();
      this.isConnected = true;
      logger.info('✅ Redis connecté avec succès');
    } catch (error) {
      logger.error('❌ Erreur de connexion Redis:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.redis.quit();
      this.isConnected = false;
      logger.info('✅ Connexion Redis fermée');
    } catch (error) {
      logger.error('❌ Erreur lors de la fermeture Redis:', error);
      throw error;
    }
  }

  isHealthy(): boolean {
    return this.isConnected && this.redis.status === 'ready';
  }

  // ============ CACHE BASIQUE ============

  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value);
      
      if (ttlSeconds) {
        await this.redis.setex(key, ttlSeconds, serializedValue);
      } else {
        await this.redis.set(key, serializedValue);
      }
      
      logger.debug(`Cache SET: ${key} (TTL: ${ttlSeconds || 'permanent'}s)`);
    } catch (error) {
      logger.error(`Erreur SET cache ${key}:`, error);
      throw error;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.redis.get(key);
      
      if (!value) {
        logger.debug(`Cache MISS: ${key}`);
        return null;
      }
      
      logger.debug(`Cache HIT: ${key}`);
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error(`Erreur GET cache ${key}:`, error);
      return null;
    }
  }

  async del(...keys: string[]): Promise<number> {
    try {
      const result = await this.redis.del(...keys);
      logger.debug(`Cache DEL: ${keys.join(', ')} (${result} supprimés)`);
      return result;
    } catch (error) {
      logger.error(`Erreur DEL cache:`, error);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.redis.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`Erreur EXISTS cache ${key}:`, error);
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.redis.ttl(key);
    } catch (error) {
      logger.error(`Erreur TTL cache ${key}:`, error);
      return -1;
    }
  }

  // ============ CACHE AVEC PATTERN ============

  async setPattern(pattern: string, value: any, ttlSeconds?: number): Promise<void> {
    const key = this.buildKey(pattern);
    await this.set(key, value, ttlSeconds);
  }

  async getPattern<T>(pattern: string): Promise<T | null> {
    const key = this.buildKey(pattern);
    return await this.get<T>(key);
  }

  async delPattern(pattern: string): Promise<number> {
    const keys = await this.redis.keys(this.buildKey(pattern));
    if (keys.length === 0) return 0;
    return await this.del(...keys);
  }

  private buildKey(pattern: string): string {
    return `staking:${pattern}`;
  }

  // ============ CACHE SPÉCIALISÉ STAKING ============

  // Cache des données d'institution
  async cacheInstitution(address: string, data: any, ttl = 300): Promise<void> {
    await this.setPattern(`institution:${address}`, data, ttl);
  }

  async getCachedInstitution<T>(address: string): Promise<T | null> {
    return await this.getPattern<T>(`institution:${address}`);
  }

  // Cache des stakes
  async cacheStakes(institutionId: string, stakes: any[], ttl = 180): Promise<void> {
    await this.setPattern(`stakes:${institutionId}`, stakes, ttl);
  }

  async getCachedStakes<T>(institutionId: string): Promise<T | null> {
    return await this.getPattern<T>(`stakes:${institutionId}`);
  }

  // Cache des métriques globales
  async cacheGlobalMetrics(metrics: any, ttl = 60): Promise<void> {
    await this.setPattern('metrics:global', metrics, ttl);
  }

  async getCachedGlobalMetrics<T>(): Promise<T | null> {
    return await this.getPattern<T>('metrics:global');
  }

  // Cache des transactions récentes
  async cacheRecentTransactions(transactions: any[], ttl = 30): Promise<void> {
    await this.setPattern('transactions:recent', transactions, ttl);
  }

  async getCachedRecentTransactions<T>(): Promise<T | null> {
    return await this.getPattern<T>('transactions:recent');
  }

  // ============ RATE LIMITING ============

  async checkRateLimit(identifier: string, limit: number, windowSeconds: number): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
  }> {
    const key = `ratelimit:${identifier}`;
    
    try {
      const current = await this.redis.incr(key);
      
      if (current === 1) {
        await this.redis.expire(key, windowSeconds);
      }
      
      const ttl = await this.redis.ttl(key);
      const resetTime = Date.now() + (ttl * 1000);
      
      return {
        allowed: current <= limit,
        remaining: Math.max(0, limit - current),
        resetTime
      };
    } catch (error) {
      logger.error(`Erreur rate limiting ${identifier}:`, error);
      // En cas d'erreur, on autorise la requête
      return {
        allowed: true,
        remaining: limit - 1,
        resetTime: Date.now() + (windowSeconds * 1000)
      };
    }
  }

  // ============ SESSIONS & AUTH ============

  async setSession(sessionId: string, data: any, ttl = 3600): Promise<void> {
    await this.setPattern(`session:${sessionId}`, data, ttl);
  }

  async getSession<T>(sessionId: string): Promise<T | null> {
    return await this.getPattern<T>(`session:${sessionId}`);
  }

  async extendSession(sessionId: string, ttl = 3600): Promise<boolean> {
    try {
      const key = this.buildKey(`session:${sessionId}`);
      const result = await this.redis.expire(key, ttl);
      return result === 1;
    } catch (error) {
      logger.error(`Erreur extension session ${sessionId}:`, error);
      return false;
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.delPattern(`session:${sessionId}`);
  }

  // ============ PUBSUB POUR TEMPS RÉEL ============

  async publish(channel: string, message: any): Promise<void> {
    try {
      const serializedMessage = JSON.stringify(message);
      await this.redis.publish(channel, serializedMessage);
      logger.debug(`Published to ${channel}:`, message);
    } catch (error) {
      logger.error(`Erreur publish ${channel}:`, error);
      throw error;
    }
  }

  async subscribe(channel: string, callback: (message: any) => void): Promise<void> {
    try {
      const subscriber = this.redis.duplicate();
      
      subscriber.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          try {
            const parsedMessage = JSON.parse(message);
            callback(parsedMessage);
          } catch (error) {
            logger.error(`Erreur parsing message ${channel}:`, error);
          }
        }
      });
      
      await subscriber.subscribe(channel);
      logger.info(`Subscribed to channel: ${channel}`);
    } catch (error) {
      logger.error(`Erreur subscribe ${channel}:`, error);
      throw error;
    }
  }

  // ============ LOCK DISTRIBUÉ ============

  async acquireLock(lockKey: string, ttl = 30, maxWait = 5000): Promise<string | null> {
    const lockValue = `${Date.now()}-${Math.random()}`;
    const key = `lock:${lockKey}`;
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      try {
        const result = await this.redis.set(key, lockValue, 'PX', ttl * 1000, 'NX');
        
        if (result === 'OK') {
          logger.debug(`Lock acquired: ${lockKey}`);
          return lockValue;
        }
        
        // Attendre un peu avant de réessayer
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        logger.error(`Erreur acquire lock ${lockKey}:`, error);
        break;
      }
    }
    
    logger.warn(`Failed to acquire lock: ${lockKey}`);
    return null;
  }

  async releaseLock(lockKey: string, lockValue: string): Promise<boolean> {
    const key = `lock:${lockKey}`;
    
    try {
      // Script Lua pour une libération atomique
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      
      const result = await this.redis.eval(script, 1, key, lockValue);
      const released = result === 1;
      
      if (released) {
        logger.debug(`Lock released: ${lockKey}`);
      } else {
        logger.warn(`Failed to release lock: ${lockKey} (value mismatch)`);
      }
      
      return released;
    } catch (error) {
      logger.error(`Erreur release lock ${lockKey}:`, error);
      return false;
    }
  }

  // ============ MÉTRIQUES & MONITORING ============

  async incrementCounter(key: string, increment = 1): Promise<number> {
    try {
      const fullKey = this.buildKey(`counter:${key}`);
      return await this.redis.incrby(fullKey, increment);
    } catch (error) {
      logger.error(`Erreur increment counter ${key}:`, error);
      return 0;
    }
  }

  async getCounter(key: string): Promise<number> {
    try {
      const fullKey = this.buildKey(`counter:${key}`);
      const value = await this.redis.get(fullKey);
      return value ? parseInt(value, 10) : 0;
    } catch (error) {
      logger.error(`Erreur get counter ${key}:`, error);
      return 0;
    }
  }

  async setGauge(key: string, value: number): Promise<void> {
    try {
      const fullKey = this.buildKey(`gauge:${key}`);
      await this.redis.set(fullKey, value.toString());
    } catch (error) {
      logger.error(`Erreur set gauge ${key}:`, error);
    }
  }

  async getGauge(key: string): Promise<number> {
    try {
      const fullKey = this.buildKey(`gauge:${key}`);
      const value = await this.redis.get(fullKey);
      return value ? parseFloat(value) : 0;
    } catch (error) {
      logger.error(`Erreur get gauge ${key}:`, error);
      return 0;
    }
  }

  // ============ NETTOYAGE ============

  async cleanupExpiredKeys(): Promise<number> {
    try {
      const pattern = this.buildKey('*');
      const keys = await this.redis.keys(pattern);
      let cleanedCount = 0;
      
      for (const key of keys) {
        const ttl = await this.redis.ttl(key);
        if (ttl === -1) continue; // Clé permanente
        if (ttl === -2) {
          // Clé expirée mais pas encore supprimée
          await this.redis.del(key);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`🧹 ${cleanedCount} clés expirées nettoyées dans Redis`);
      }
      
      return cleanedCount;
    } catch (error) {
      logger.error('Erreur nettoyage Redis:', error);
      return 0;
    }
  }

  async getMemoryUsage(): Promise<{
    used: number;
    peak: number;
    fragmentation: number;
  }> {
    try {
      const info = await this.redis.memory('USAGE');
      const stats = await this.redis.memory('STATS');
      
      return {
        used: info || 0,
        peak: stats?.['peak.allocated'] || 0,
        fragmentation: stats?.['fragmentation.ratio'] || 0
      };
    } catch (error) {
      logger.error('Erreur memory usage Redis:', error);
      return { used: 0, peak: 0, fragmentation: 0 };
    }
  }
}
