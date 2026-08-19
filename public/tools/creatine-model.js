export const MODEL_VERSION = "creatine-balance-v2";
export const LEGACY_MODEL_VERSION = "protocol-progress-v1";
export const TRACKER_SCHEMA_VERSION = 2;
export const LEGACY_TRACKER_SCHEMA_VERSION = 1;
export const DEFAULT_DOSE_GRAMS = 5;
export const MIN_DOSE_GRAMS = 0.1;
export const MAX_DOSE_GRAMS = 100;
const PLAN_INCREMENT_GRAMS = 5;
export const LOADING_DAYS = 6;
export const WASHOUT_DAYS = 42;
export const MAX_MODEL_DAYS = 3660;
export const DAILY_DECAY_POINTS = 100 / WASHOUT_DAYS;
export const FULL_LOADING_DAY_CREDIT_POINTS = (100 / LOADING_DAYS) + DAILY_DECAY_POINTS;

const SUPPORTED_MODEL_VERSIONS = new Set([LEGACY_MODEL_VERSION, MODEL_VERSION]);

function dateParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isValidTimeZone(timeZone) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export function hasUniqueDoseIds(doses) {
  const ids = new Set();
  for (const dose of doses) {
    if (ids.has(dose.id)) return false;
    ids.add(dose.id);
  }
  return true;
}

export function isValidDoseGrams(value) {
  const grams = Number(value);
  const nearestTenth = Math.round(grams * 10) / 10;
  return Number.isFinite(grams) && grams >= MIN_DOSE_GRAMS && grams <= MAX_DOSE_GRAMS && Math.abs(grams - nearestTenth) < 1e-9;
}

export function plannedDailyTarget(weightKg) {
  const rawTargetGrams = Number(weightKg) * 0.3;
  const plannedServings = Math.max(2, Math.min(5, Math.round(rawTargetGrams / PLAN_INCREMENT_GRAMS)));
  return {
    rawTargetGrams,
    plannedServings,
    plannedDailyGrams: plannedServings * PLAN_INCREMENT_GRAMS,
  };
}

export function addCalendarDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function isValidDateString(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString || "")) return false;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateString;
}

export function isSupportedTrackingDate(dateString, timeZone, evaluationAt = new Date().toISOString()) {
  if (!isValidDateString(dateString) || !isValidTimeZone(timeZone)) return false;
  const today = doseDay(evaluationAt, timeZone);
  const daysApart = Math.round((new Date(`${today}T00:00:00.000Z`) - new Date(`${dateString}T00:00:00.000Z`)) / 86_400_000);
  return daysApart >= 0 && daysApart < MAX_MODEL_DAYS;
}

export function progressToOneDecimal(progress) {
  return Math.max(0, Math.min(100, Number(progress))).toFixed(1);
}

export function phaseForProgress(progress) {
  if (progress >= 95) return "Likely near plateau";
  if (progress >= 70) return "Nearing typical plateau";
  return "Loading";
}

export function doseDay(takenAt, timeZone) {
  return dateParts(takenAt, timeZone);
}

export function migrateTrackerState(candidate, evaluationAt = new Date().toISOString()) {
  if (!candidate || ![LEGACY_TRACKER_SCHEMA_VERSION, TRACKER_SCHEMA_VERSION].includes(candidate.schemaVersion) || !SUPPORTED_MODEL_VERSIONS.has(candidate.modelVersion) || !Array.isArray(candidate.doses)) return null;
  const legacy = candidate.schemaVersion === LEGACY_TRACKER_SCHEMA_VERSION;
  const doses = [];
  for (const dose of candidate.doses) {
    const grams = Number(dose?.grams);
    if (!dose || typeof dose.id !== "string" || dose.id.length === 0 || dose.id.length > 128 || typeof dose.takenAt !== "string" || Number.isNaN(new Date(dose.takenAt).getTime()) || !isValidDoseGrams(grams) || (legacy && grams !== DEFAULT_DOSE_GRAMS)) return null;
    doses.push({ ...dose, grams });
  }
  if (!hasUniqueDoseIds(doses)) return null;
  if (candidate.profile === null) return doses.length === 0 ? { schemaVersion: TRACKER_SCHEMA_VERSION, modelVersion: MODEL_VERSION, profile: null, doses } : null;

  const { weightKg, trackingStartDate, trackerTimezone } = candidate.profile || {};
  const defaultDoseGrams = legacy ? DEFAULT_DOSE_GRAMS : Number(candidate.profile?.defaultDoseGrams);
  if (!Number.isFinite(Number(weightKg)) || Number(weightKg) < 30 || Number(weightKg) > 300 || !isSupportedTrackingDate(trackingStartDate, trackerTimezone, evaluationAt) || !isValidTimeZone(trackerTimezone) || !isValidDoseGrams(defaultDoseGrams)) return null;
  return {
    schemaVersion: TRACKER_SCHEMA_VERSION,
    modelVersion: MODEL_VERSION,
    profile: { ...candidate.profile, weightKg: Number(weightKg), trackingStartDate, trackerTimezone, defaultDoseGrams },
    doses,
  };
}

export function calculateProgress({ profile, doses = [], evaluationAt = new Date().toISOString() }) {
  const weightKg = Number(profile?.weightKg);
  const timeZone = profile?.trackerTimezone;
  const trackingStartDate = profile?.trackingStartDate;
  if (!Number.isFinite(weightKg) || weightKg <= 0 || !isSupportedTrackingDate(trackingStartDate, timeZone, evaluationAt)) {
    return null;
  }

  const plan = plannedDailyTarget(weightKg);
  const evaluationDay = doseDay(evaluationAt, timeZone);
  const dailyGrams = new Map();
  const dailyDoseCounts = new Map();
  for (const dose of doses) {
    const takenAt = new Date(dose.takenAt);
    if (!Number.isFinite(takenAt.getTime()) || takenAt.getTime() > new Date(evaluationAt).getTime()) continue;
    const grams = Number(dose.grams ?? DEFAULT_DOSE_GRAMS);
    if (!isValidDoseGrams(grams)) continue;
    const day = doseDay(takenAt.toISOString(), timeZone);
    if (day < trackingStartDate) continue;
    dailyGrams.set(day, (dailyGrams.get(day) ?? 0) + grams);
    dailyDoseCounts.set(day, (dailyDoseCounts.get(day) ?? 0) + 1);
  }

  let progress = 0;
  let plateauReachedDay = null;
  let iterations = 0;
  for (let day = trackingStartDate; day <= evaluationDay; day = addCalendarDays(day, 1)) {
    if (++iterations > MAX_MODEL_DAYS) return null;
    const loggedGrams = dailyGrams.get(day) ?? 0;
    if (day < evaluationDay) progress -= DAILY_DECAY_POINTS;
    progress = Math.max(0, progress);
    progress += (Math.min(loggedGrams, plan.plannedDailyGrams) / plan.plannedDailyGrams) * FULL_LOADING_DAY_CREDIT_POINTS;
    if (progress >= 100 && plateauReachedDay === null) plateauReachedDay = day;
    progress = Math.max(0, Math.min(100, progress));
  }

  const todayLoggedGrams = dailyGrams.get(evaluationDay) ?? 0;
  const mode = plateauReachedDay ? "maintenance" : "loading";
  const dailyTargetGrams = mode === "maintenance"
    ? Number(profile.defaultDoseGrams ?? DEFAULT_DOSE_GRAMS)
    : plan.plannedDailyGrams;
  return {
    ...plan,
    rawProgress: progress,
    phase: mode === "maintenance" ? "Maintenance" : phaseForProgress(progress),
    mode,
    plateauReachedDay,
    evaluationDay,
    todayLoggedGrams,
    todayDoseCount: dailyDoseCounts.get(evaluationDay) ?? 0,
    dailyTargetGrams,
    todayPlanPercent: Math.min(100, Math.round((todayLoggedGrams / dailyTargetGrams) * 100)),
    yesterdayLoggedGrams: dailyGrams.get(addCalendarDays(evaluationDay, -1)) ?? 0,
    dailyGrams,
    dailyDoseCounts,
  };
}
