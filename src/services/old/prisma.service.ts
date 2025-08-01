import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../utils/logger';

export class PrismaService {
  private prisma: PrismaClient;
  private isConnected = false;

  constructor() {
    this.prisma = new PrismaClient({
      log: [
        {
          emit: 'event',
          level: 'query',
        },
        {
          emit: 'event',
          level: 'error',
        },
        {
          emit: 'event',
          level: 'info',
        },
        {
          emit: 'event',
          level: 'warn',
        },
      ],
      errorFormat: 'colorless'
    });

    // Logging des requêtes en mode développement
    if (process.env.NODE_ENV === 'development') {
      this.prisma.$on('query', (e) => {
        logger.debug('Prisma Query:', {
          query: e.query,
          params: e.params,
          duration: `${e.duration}ms`
        });
      });
    }

    this.prisma.$on('error', (e) => {
      logger.error('Prisma Error:', e);
    });

    this.prisma.$on('info', (e) => {
      logger.info('Prisma Info:', e.message);
    });

    this.prisma.$on('warn', (e) => {
      logger.warn('Prisma Warning:', e.message);
    });
  }

  async connect(): Promise<void> {
    try {
      await this.prisma.$connect();
      this.isConnected = true;
      logger.info('✅ Connexion Prisma établie');
    } catch (error) {
      logger.error('❌ Erreur de connexion Prisma:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.prisma.$disconnect();
      this.isConnected = false;
      logger.info('✅ Connexion Prisma fermée');
    } catch (error) {
      logger.error('❌ Erreur lors de la fermeture Prisma:', error);
      throw error;
    }
  }

  getClient(): PrismaClient {
    if (!this.isConnected) {
      throw new Error('Prisma client non connecté');
    }
    return this.prisma;
  }

  // ============ INSTITUTIONS ============

  async createInstitution(data: {
    address: string;
    name: string;
    institutionId: string;
    riskScore: number;
  }) {
    try {
      return await this.prisma.institution.create({
        data: {
          ...data,
          verified: false,
          totalStaked: new Prisma.Decimal(0),
          totalRewards: new Prisma.Decimal(0)
        }
      });
    } catch (error) {
      logger.error('Erreur création institution:', error);
      throw error;
    }
  }

  async getInstitution(address: string) {
    try {
      return await this.prisma.institution.findUnique({
        where: { address },
        include: {
          stakes: {
            where: { isActive: true },
            orderBy: { createdAt: 'desc' }
          },
          transactions: {
            orderBy: { timestamp: 'desc' },
            take: 10
          }
        }
      });
    } catch (error) {
      logger.error('Erreur récupération institution:', error);
      throw error;
    }
  }

  async updateInstitution(address: string, data: Partial<{
    name: string;
    riskScore: number;
    verified: boolean;
    totalStaked: Prisma.Decimal;
    totalRewards: Prisma.Decimal;
  }>) {
    try {
      return await this.prisma.institution.update({
        where: { address },
        data
      });
    } catch (error) {
      logger.error('Erreur mise à jour institution:', error);
      throw error;
    }
  }

  async getAllInstitutions(skip = 0, take = 50) {
    try {
      return await this.prisma.institution.findMany({
        skip,
        take,
        orderBy: { totalStaked: 'desc' },
        include: {
          _count: {
            select: {
              stakes: { where: { isActive: true } }
            }
          }
        }
      });
    } catch (error) {
      logger.error('Erreur récupération institutions:', error);
      throw error;
    }
  }

  // ============ STAKES ============

  async createStake(data: {
    stakeId: number;
    amount: Prisma.Decimal;
    lockPeriod: number;
    timestamp: Date;
    institutionId: string;
  }) {
    try {
      return await this.prisma.stake.create({
        data: {
          ...data,
          isActive: true,
          rewards: new Prisma.Decimal(0)
        },
        include: {
          institution: true
        }
      });
    } catch (error) {
      logger.error('Erreur création stake:', error);
      throw error;
    }
  }

  async getStake(id: string) {
    try {
      return await this.prisma.stake.findUnique({
        where: { id },
        include: {
          institution: true,
          transactions: {
            orderBy: { timestamp: 'desc' }
          }
        }
      });
    } catch (error) {
      logger.error('Erreur récupération stake:', error);
      throw error;
    }
  }

  async updateStake(id: string, data: Partial<{
    isActive: boolean;
    rewards: Prisma.Decimal;
  }>) {
    try {
      return await this.prisma.stake.update({
        where: { id },
        data
      });
    } catch (error) {
      logger.error('Erreur mise à jour stake:', error);
      throw error;
    }
  }

  async getStakesByInstitution(institutionId: string, activeOnly = true) {
    try {
      return await this.prisma.stake.findMany({
        where: {
          institutionId,
          ...(activeOnly ? { isActive: true } : {})
        },
        orderBy: { timestamp: 'desc' },
        include: {
          institution: true
        }
      });
    } catch (error) {
      logger.error('Erreur récupération stakes institution:', error);
      throw error;
    }
  }

  // ============ TRANSACTIONS ============

  async createTransaction(data: {
    txHash: string;
    type: 'STAKE_CREATE' | 'STAKE_WITHDRAW' | 'REWARD_CLAIM' | 'INSTITUTION_REGISTER';
    amount: Prisma.Decimal;
    institutionId?: string;
    stakeId?: string;
    gasUsed?: bigint;
    gasPrice?: bigint;
    blockNumber?: bigint;
  }) {
    try {
      return await this.prisma.transaction.create({
        data: {
          ...data,
          status: 'PENDING'
        },
        include: {
          institution: true,
          stake: true
        }
      });
    } catch (error) {
      logger.error('Erreur création transaction:', error);
      throw error;
    }
  }

  async updateTransaction(txHash: string, data: {
    status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERTED';
    gasUsed?: bigint;
    gasPrice?: bigint;
    blockNumber?: bigint;
  }) {
    try {
      return await this.prisma.transaction.update({
        where: { txHash },
        data
      });
    } catch (error) {
      logger.error('Erreur mise à jour transaction:', error);
      throw error;
    }
  }

  async getRecentTransactions(limit = 100) {
    try {
      return await this.prisma.transaction.findMany({
        take: limit,
        orderBy: { timestamp: 'desc' },
        include: {
          institution: {
            select: {
              name: true,
              address: true
            }
          }
        }
      });
    } catch (error) {
      logger.error('Erreur récupération transactions récentes:', error);
      throw error;
    }
  }

  // ============ MÉTRIQUES ============

  async saveSystemMetric(metric: string, value: Prisma.Decimal) {
    try {
      return await this.prisma.systemMetric.create({
        data: {
          metric,
          value
        }
      });
    } catch (error) {
      logger.error('Erreur sauvegarde métrique:', error);
      throw error;
    }
  }

  async getSystemMetrics(metric: string, from?: Date, to?: Date) {
    try {
      return await this.prisma.systemMetric.findMany({
        where: {
          metric,
          ...(from || to ? {
            timestamp: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {})
            }
          } : {})
        },
        orderBy: { timestamp: 'desc' },
        take: 1000
      });
    } catch (error) {
      logger.error('Erreur récupération métriques:', error);
      throw error;
    }
  }

  // ============ CACHE ============

  async setCacheEntry(key: string, value: any, expiresAt: Date) {
    try {
      return await this.prisma.cacheEntry.upsert({
        where: { key },
        update: {
          value,
          expiresAt
        },
        create: {
          key,
          value,
          expiresAt
        }
      });
    } catch (error) {
      logger.error('Erreur cache entry:', error);
      throw error;
    }
  }

  async getCacheEntry(key: string) {
    try {
      const entry = await this.prisma.cacheEntry.findUnique({
        where: { key }
      });

      if (!entry || entry.expiresAt < new Date()) {
        return null;
      }

      return entry.value;
    } catch (error) {
      logger.error('Erreur récupération cache:', error);
      throw error;
    }
  }

  async cleanExpiredCache() {
    try {
      const result = await this.prisma.cacheEntry.deleteMany({
        where: {
          expiresAt: {
            lt: new Date()
          }
        }
      });
      
      if (result.count > 0) {
        logger.info(`🧹 ${result.count} entrées de cache expirées supprimées`);
      }
      
      return result;
    } catch (error) {
      logger.error('Erreur nettoyage cache:', error);
      throw error;
    }
  }

  // ============ ALERTES ============

  async createAlert(data: {
    type: 'GAS_BUDGET_WARNING' | 'SYSTEM_HEALTH' | 'SECURITY_INCIDENT' | 'PERFORMANCE_DEGRADATION' | 'CONTRACT_ERROR';
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    title: string;
    message: string;
  }) {
    try {
      return await this.prisma.alert.create({
        data
      });
    } catch (error) {
      logger.error('Erreur création alerte:', error);
      throw error;
    }
  }

  async getUnresolvedAlerts() {
    try {
      return await this.prisma.alert.findMany({
        where: { resolved: false },
        orderBy: [
          { severity: 'desc' },
          { createdAt: 'desc' }
        ]
      });
    } catch (error) {
      logger.error('Erreur récupération alertes:', error);
      throw error;
    }
  }

  async resolveAlert(id: string) {
    try {
      return await this.prisma.alert.update({
        where: { id },
        data: {
          resolved: true,
          resolvedAt: new Date()
        }
      });
    } catch (error) {
      logger.error('Erreur résolution alerte:', error);
      throw error;
    }
  }

  // ============ CONFIGURATION ============

  async getConfig(key: string) {
    try {
      const config = await this.prisma.config.findUnique({
        where: { key }
      });
      return config?.value;
    } catch (error) {
      logger.error('Erreur récupération config:', error);
      throw error;
    }
  }

  async setConfig(key: string, value: any) {
    try {
      return await this.prisma.config.upsert({
        where: { key },
        update: { value },
        create: { key, value }
      });
    } catch (error) {
      logger.error('Erreur sauvegarde config:', error);
      throw error;
    }
  }

  // ============ STATISTIQUES ============

  async getGlobalStats() {
    try {
      const [
        totalValueLocked,
        totalInstitutions,
        activeStakes,
        totalTransactions
      ] = await Promise.all([
        this.prisma.institution.aggregate({
          _sum: { totalStaked: true }
        }),
        this.prisma.institution.count({
          where: { verified: true }
        }),
        this.prisma.stake.count({
          where: { isActive: true }
        }),
        this.prisma.transaction.count({
          where: { status: 'CONFIRMED' }
        })
      ]);

      return {
        totalValueLocked: totalValueLocked._sum.totalStaked || new Prisma.Decimal(0),
        totalInstitutions,
        activeStakes,
        totalTransactions
      };
    } catch (error) {
      logger.error('Erreur statistiques globales:', error);
      throw error;
    }
  }
}
