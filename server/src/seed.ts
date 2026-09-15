/**
 * Seeds the command centre with the DAT LT Italian outstation network.
 * Figures reproduce the reference dashboard: 14 open defects, ~87 projected
 * for the year, and a repetitive ATA 36 bleed air valve as the top risk.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const YEAR = new Date().getFullYear();
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

const STATIONS = [
  {
    code: 'MXP',
    city: 'Milan',
    networkStatus: 'OPTIMAL' as const,
    complianceStatus: 'PASSED_MINOR' as const,
    lastAuditAt: days(-42),
    requiredAction: 'Order Mobil Jet Oil II',
    impediments: [{ category: 'Consumables', description: 'Consumables Shortage - engine oil below minimum stock' }],
  },
  {
    code: 'FCO',
    city: 'Rome',
    networkStatus: 'CRITICAL' as const,
    complianceStatus: 'PENDING_REVIEW' as const,
    lastAuditAt: days(-11),
    requiredAction: 'Re-arrange Shift Roster',
    impediments: [{ category: 'Manpower', description: 'B1 Engineer Sick Leave - night shift uncovered' }],
  },
  {
    code: 'BGY',
    city: 'Bergamo',
    networkStatus: 'DEGRADED' as const,
    complianceStatus: 'PASSED' as const,
    lastAuditAt: days(-77),
    requiredAction: 'Tooling Calibration',
    impediments: [{ category: 'Tooling', description: 'GSE Calibration Due - torque wrenches out of validity' }],
  },
  {
    code: 'VCE',
    city: 'Venice',
    networkStatus: 'OPTIMAL' as const,
    complianceStatus: 'PASSED' as const,
    lastAuditAt: days(-95),
    requiredAction: null,
    impediments: [],
  },
];

const AIRCRAFT = [
  { registration: 'LY-DAT', model: 'ATR 72-600', operationalStatus: 'ACTIVE' as const, station: 'MXP', flightHours: 21430.5, cycles: 18902 },
  { registration: 'LY-ABC', model: 'ATR 72-600', operationalStatus: 'AOG' as const, station: 'FCO', flightHours: 19875.2, cycles: 17344 },
  { registration: 'LY-XYZ', model: 'ATR 42-500', operationalStatus: 'MAINTENANCE' as const, station: 'VCE', flightHours: 30112.8, cycles: 26550 },
  { registration: 'LY-VNO', model: 'ATR 72-600', operationalStatus: 'ACTIVE' as const, station: 'BGY', flightHours: 12008.4, cycles: 10233 },
  { registration: 'LY-KUN', model: 'ATR 42-500', operationalStatus: 'ACTIVE' as const, station: 'MXP', flightHours: 27640.9, cycles: 24118 },
];

type SeedDefect = {
  registration: string;
  ataChapter: string;
  title: string;
  description: string;
  category: 'CRITICAL' | 'CAT_A' | 'CAT_B' | 'CAT_C' | 'CAT_D';
  repetitive?: boolean;
  status?: 'OPEN' | 'DEFERRED' | 'CLOSED';
  raisedDaysAgo: number;
  dueInDays?: number;
};

// 14 open/deferred defects + a handful of closed ones for history.
const DEFECTS: SeedDefect[] = [
  { registration: 'LY-DAT', ataChapter: '25', title: 'Cabin seat 12C recline inoperative', description: 'Passenger seat locked upright, placarded.', category: 'CAT_C', raisedDaysAgo: 4, dueInDays: 6 },
  { registration: 'LY-DAT', ataChapter: '33', title: 'Forward galley dome light flickering', description: 'Intermittent flicker on ground power.', category: 'CAT_C', raisedDaysAgo: 2, dueInDays: 8 },

  { registration: 'LY-ABC', ataChapter: '29', title: 'Green system hydraulic pump low pressure', description: 'Pressure decays below 2800 psi in cruise. No-go item.', category: 'CRITICAL', raisedDaysAgo: 1, dueInDays: 0 },
  { registration: 'LY-ABC', ataChapter: '32', title: 'Nose wheel steering hard-over on taxi', description: 'Reported twice by crew, under investigation.', category: 'CAT_A', repetitive: true, raisedDaysAgo: 3, dueInDays: 1 },
  { registration: 'LY-ABC', ataChapter: '36', title: 'Bleed air valve slow response', description: 'Repetitive snag, ATA 36 trend monitored.', category: 'CAT_B', repetitive: true, raisedDaysAgo: 6, dueInDays: 2 },
  { registration: 'LY-ABC', ataChapter: '21', title: 'Pack 2 outlet temperature fluctuation', description: 'Temperature swing of 8 C either side of selected.', category: 'CAT_C', status: 'DEFERRED', raisedDaysAgo: 9, dueInDays: 4 },
  { registration: 'LY-ABC', ataChapter: '52', title: 'Forward pax door seal wear', description: 'Seal abrasion within limits, monitor.', category: 'CAT_D', raisedDaysAgo: 20, dueInDays: 95 },

  { registration: 'LY-XYZ', ataChapter: '32', title: 'Brake unit wear indicator at limit', description: 'Both main gear units scheduled for change.', category: 'CAT_B', raisedDaysAgo: 2, dueInDays: 3 },

  { registration: 'LY-VNO', ataChapter: '36', title: 'Bleed air valve repetitive overtemp', description: 'Third occurrence in 90 days. Predictive model flagged.', category: 'CAT_B', repetitive: true, raisedDaysAgo: 5, dueInDays: 2 },
  { registration: 'LY-VNO', ataChapter: '24', title: 'TRU 2 intermittent caution', description: 'Caution clears after reset.', category: 'CAT_C', raisedDaysAgo: 7, dueInDays: 5 },
  { registration: 'LY-VNO', ataChapter: '34', title: 'Weather radar tilt drift', description: 'Drifts 2 degrees nose down.', category: 'CAT_C', status: 'DEFERRED', raisedDaysAgo: 12, dueInDays: 7 },

  { registration: 'LY-KUN', ataChapter: '27', title: 'Aileron trim indicator sticking', description: 'Needle sticks mid-travel.', category: 'CAT_C', raisedDaysAgo: 8, dueInDays: 4 },
  { registration: 'LY-KUN', ataChapter: '49', title: 'APU slow start on cold soak', description: 'Start time 6 s above nominal.', category: 'CAT_C', raisedDaysAgo: 11, dueInDays: 9 },
  { registration: 'LY-KUN', ataChapter: '38', title: 'Lavatory waste indication erratic', description: 'Level sensor intermittent.', category: 'CAT_D', raisedDaysAgo: 25, dueInDays: 80 },

  { registration: 'LY-DAT', ataChapter: '36', title: 'Bleed leak detection loop fault', description: 'Rectified by loop replacement.', category: 'CAT_B', repetitive: true, status: 'CLOSED', raisedDaysAgo: 40 },
  { registration: 'LY-XYZ', ataChapter: '23', title: 'VHF 2 weak transmission', description: 'Antenna connector re-torqued.', category: 'CAT_C', status: 'CLOSED', raisedDaysAgo: 33 },
  { registration: 'LY-KUN', ataChapter: '30', title: 'Probe heat caution on ground', description: 'Faulty sensor replaced.', category: 'CAT_A', status: 'CLOSED', raisedDaysAgo: 28 },
];

const ALERTS = [
  { registration: 'LY-VNO', component: 'Bleed Air Valve', ataChapter: '36', severity: 'CRITICAL' as const, dueInDays: 0, confidence: 0.94, recommendation: 'Replace valve at next night stop - repetitive ATA 36 trend across fleet' },
  { registration: 'LY-ABC', component: 'Hydraulic Pump', ataChapter: '29', severity: 'CRITICAL' as const, dueInDays: 0, confidence: 0.88, recommendation: 'Change Now - pressure decay beyond acceptance limits' },
  { registration: 'LY-DAT', component: 'Main Battery', ataChapter: '24', severity: 'WARNING' as const, dueInDays: 12, confidence: 0.81, recommendation: 'Capacity trending down - schedule battery change within 12 days' },
  { registration: 'LY-XYZ', component: 'Brake Unit', ataChapter: '32', severity: 'WARNING' as const, dueInDays: 5, confidence: 0.76, recommendation: 'Brakes Inspection Due - wear pin at limit' },
  { registration: 'LY-KUN', component: 'APU Starter', ataChapter: '49', severity: 'INFO' as const, dueInDays: 34, confidence: 0.62, recommendation: 'Monitor start times, order starter as attrition spare' },
];

// Monthly raised-defect history; the run rate projects ~87 by year end.
const MONTHLY_HISTORY = [8, 7, 6, 9, 5, 8, 7, 8, 7, 0, 0, 0];

async function main() {
  // Safe to run on every boot: existing data is left alone unless SEED_FORCE is set.
  if (process.env.SEED_FORCE !== 'true') {
    const existing = await prisma.aircraft.count();
    if (existing > 0) {
      console.log(`Seed skipped: ${existing} aircraft already on file (set SEED_FORCE=true to reseed).`);
      return;
    }
  }

  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'ops@dat-lt.aero').toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'CommandCenter2026!';

  const users = [
    { email: adminEmail, name: 'Operations Control', role: 'ADMIN' as const, passwordHash: await bcrypt.hash(adminPassword, 10) },
    { email: 'engineer@dat-lt.aero', name: 'Line Engineer (B1)', role: 'ENGINEER' as const, passwordHash: await bcrypt.hash('LineMaint2026!', 10) },
    { email: 'viewer@dat-lt.aero', name: 'Fleet Analyst', role: 'VIEWER' as const, passwordHash: await bcrypt.hash('FleetView2026!', 10) },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, passwordHash: user.passwordHash },
      create: user,
    });
  }

  const stationIds = new Map<string, string>();
  for (const { impediments, ...station } of STATIONS) {
    const row = await prisma.station.upsert({
      where: { code: station.code },
      update: station,
      create: station,
    });
    stationIds.set(station.code, row.id);

    await prisma.impediment.deleteMany({ where: { stationId: row.id } });
    for (const imp of impediments) {
      await prisma.impediment.create({ data: { ...imp, stationId: row.id, openedAt: days(-6) } });
    }
  }

  const aircraftIds = new Map<string, string>();
  for (const { station, ...aircraft } of AIRCRAFT) {
    const data = { ...aircraft, stationId: stationIds.get(station)! };
    const row = await prisma.aircraft.upsert({
      where: { registration: aircraft.registration },
      update: data,
      create: data,
    });
    aircraftIds.set(aircraft.registration, row.id);
  }

  await prisma.defect.deleteMany({});
  let sequence = 0;
  for (const d of DEFECTS) {
    sequence += 1;
    await prisma.defect.create({
      data: {
        reference: `DEF-${YEAR}-${String(sequence).padStart(4, '0')}`,
        aircraftId: aircraftIds.get(d.registration)!,
        ataChapter: d.ataChapter,
        title: d.title,
        description: d.description,
        category: d.category,
        status: d.status ?? 'OPEN',
        repetitive: d.repetitive ?? false,
        raisedAt: days(-d.raisedDaysAgo),
        dueAt: d.dueInDays === undefined ? null : days(d.dueInDays),
        closedAt: d.status === 'CLOSED' ? days(-(d.raisedDaysAgo - 2)) : null,
      },
    });
  }

  await prisma.predictiveAlert.deleteMany({});
  for (const a of ALERTS) {
    const { registration, ...alert } = a;
    await prisma.predictiveAlert.create({
      data: { ...alert, aircraftId: aircraftIds.get(registration)! },
    });
  }

  for (const [index, count] of MONTHLY_HISTORY.entries()) {
    const month = index + 1;
    if (count === 0) continue;
    await prisma.defectHistory.upsert({
      where: { year_month: { year: YEAR, month } },
      update: { count },
      create: { year: YEAR, month, count },
    });
  }

  const open = await prisma.defect.count({ where: { status: { not: 'CLOSED' } } });
  console.log(`Seed complete: ${AIRCRAFT.length} aircraft, ${STATIONS.length} stations, ${open} open defects.`);
  console.log(`Admin login: ${adminEmail}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
