import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { authenticate } from '../auth.js';

/**
 * Projects the year-end defect count from the monthly history plus what has been
 * raised so far this year: actual-to-date + (run rate x remaining months).
 */
async function projectYearEndDefects(year: number) {
  const history = await prisma.defectHistory.findMany({ where: { year }, orderBy: { month: 'asc' } });
  const now = new Date();
  const monthsElapsed = now.getFullYear() === year ? now.getMonth() + 1 : 12;

  const raisedThisYear = await prisma.defect.count({
    where: { raisedAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
  });

  const historic = history.reduce((sum, h) => sum + h.count, 0);
  const actualToDate = Math.max(historic, raisedThisYear);
  if (monthsElapsed >= 12) return actualToDate;

  const runRate = actualToDate / monthsElapsed;
  return Math.round(actualToDate + runRate * (12 - monthsElapsed));
}

/**
 * The headline predictive risk: the unacknowledged alert with the highest
 * severity-and-urgency score, enriched with how often that ATA chapter repeats.
 */
async function criticalPredictiveRisk() {
  const severityWeight = { CRITICAL: 3, WARNING: 2, INFO: 1 } as const;

  const alerts = await prisma.predictiveAlert.findMany({
    where: { acknowledged: false },
    include: { aircraft: { select: { registration: true } } },
  });
  if (alerts.length === 0) return null;

  const scored = alerts
    .map((a) => ({
      alert: a,
      score: severityWeight[a.severity] * 100 - a.dueInDays + a.confidence * 10,
    }))
    .sort((x, y) => y.score - x.score);

  const top = scored[0].alert;
  const repetitions = await prisma.defect.count({
    where: { ataChapter: top.ataChapter, repetitive: true },
  });

  return {
    component: top.component,
    ataChapter: top.ataChapter,
    severity: top.severity,
    dueInDays: top.dueInDays,
    confidence: top.confidence,
    recommendation: top.recommendation,
    registration: top.aircraft.registration,
    repetitive: repetitions > 0,
    repetitionCount: repetitions,
  };
}

export async function overviewRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/', async () => {
    const year = new Date().getFullYear();

    const [openDefects, criticalDefects, fleetSize, aog, stations, degradedStations, projected, risk, ataBreakdown] =
      await Promise.all([
        prisma.defect.count({ where: { status: { not: 'CLOSED' } } }),
        prisma.defect.count({ where: { status: { not: 'CLOSED' }, category: 'CRITICAL' } }),
        prisma.aircraft.count(),
        prisma.aircraft.count({ where: { operationalStatus: 'AOG' } }),
        prisma.station.count(),
        prisma.station.count({ where: { networkStatus: { not: 'OPTIMAL' } } }),
        projectYearEndDefects(year),
        criticalPredictiveRisk(),
        prisma.defect.groupBy({
          by: ['ataChapter'],
          _count: { _all: true },
          where: { status: { not: 'CLOSED' } },
          orderBy: { _count: { ataChapter: 'desc' } },
          take: 6,
        }),
      ]);

    const history = await prisma.defectHistory.findMany({ where: { year }, orderBy: { month: 'asc' } });

    return {
      year,
      openDefects,
      criticalDefects,
      projectedDefects: projected,
      criticalPredictiveRisk: risk,
      fleet: { total: fleetSize, aog, availability: fleetSize ? Math.round(((fleetSize - aog) / fleetSize) * 100) : 100 },
      network: { stations, degraded: degradedStations },
      defectTrend: history.map((h) => ({ month: h.month, count: h.count })),
      ataBreakdown: ataBreakdown.map((a) => ({ ataChapter: a.ataChapter, count: a._count._all })),
    };
  });
}
