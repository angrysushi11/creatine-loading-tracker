import { DEFAULT_DOSE_GRAMS, doseDay, isValidDoseGrams, isValidTimeZone } from "./creatine-model.js";

export const SCHEDULE_SERVING_TENTHS = 50;
export const SCHEDULE_INTERVAL_MINUTES = 300;
export const SCHEDULE_INTERVAL_OPTIONS_MINUTES = Object.freeze([300, 240, 180]);
export const SCHEDULE_CUTOFF_MINUTES = 23 * 60;

const MINUTE_MS = 60_000;

function toTenths(value) {
  const numeric = Number(value);
  const tenths = Math.round(numeric * 10);
  if (!Number.isFinite(numeric) || Math.abs((numeric * 10) - tenths) > 1e-9) return null;
  return tenths;
}

function localMinuteOfDay(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return (Number(values.hour) * 60) + Number(values.minute);
}

function resultBase({
  evaluationDay = null,
  targetTenths = null,
  loggedTenths = 0,
  remainingTenths = null,
  latestDoseAt = null,
} = {}) {
  return {
    status: "unavailable",
    reasonCode: "invalid_input",
    evaluationDay,
    targetTenths,
    loggedTenths,
    remainingTenths,
    servingTenths: SCHEDULE_SERVING_TENTHS,
    intervalMinutes: SCHEDULE_INTERVAL_MINUTES,
    cutoffMinutes: SCHEDULE_CUTOFF_MINUTES,
    latestDoseAt,
    nominalNextAt: null,
    slots: [],
    omittedSlotCount: 0,
    omittedTenths: 0,
  };
}

function projectSlots({
  intervalMinutes,
  latestDoseMs,
  evaluationMs,
  evaluationDay,
  trackerTimezone,
  remainingSlotCount,
}) {
  const intervalMs = intervalMinutes * MINUTE_MS;
  const nominalNextMs = latestDoseMs + intervalMs;
  const firstSlotIsDueNow = nominalNextMs <= evaluationMs;
  const projectionStartMs = firstSlotIsDueNow ? evaluationMs : nominalNextMs;
  const slots = [];

  for (let index = 0; index < remainingSlotCount; index += 1) {
    const atMs = projectionStartMs + (index * intervalMs);
    const at = new Date(atMs).toISOString();
    const fitsToday = doseDay(at, trackerTimezone) === evaluationDay;
    const fitsCutoff = localMinuteOfDay(at, trackerTimezone) < SCHEDULE_CUTOFF_MINUTES;
    if (!fitsToday || !fitsCutoff) break;
    slots.push({
      kind: index === 0 && firstSlotIsDueNow ? "due_now" : "scheduled",
      at,
    });
  }

  return {
    intervalMinutes,
    nominalNextAt: new Date(nominalNextMs).toISOString(),
    slots,
  };
}

/**
 * Derives today's optional five-gram spacing suggestions from factual dose events.
 * It prefers five-hour spacing, then four, then three when needed before 23:00.
 * The result contains codes and timestamps only; factual logging remains separate.
 */
export function deriveCreatineSchedule({
  doses = [],
  plannedDailyGrams,
  defaultDoseGrams,
  trackerTimezone,
  evaluationAt = new Date().toISOString(),
} = {}) {
  const evaluation = new Date(evaluationAt);
  const targetTenths = toTenths(plannedDailyGrams);
  const defaultTenths = toTenths(defaultDoseGrams);

  if (typeof trackerTimezone !== "string" || trackerTimezone.length === 0 || !isValidTimeZone(trackerTimezone) || !Number.isFinite(evaluation.getTime()) || !Array.isArray(doses) || targetTenths === null || targetTenths <= 0) {
    return resultBase({ targetTenths });
  }

  const evaluationIso = evaluation.toISOString();
  const evaluationDay = doseDay(evaluationIso, trackerTimezone);
  const base = resultBase({ evaluationDay, targetTenths, remainingTenths: targetTenths });

  if (defaultTenths !== SCHEDULE_SERVING_TENTHS) {
    return { ...base, reasonCode: "non_5g_default" };
  }

  if (targetTenths % SCHEDULE_SERVING_TENTHS !== 0) {
    return { ...base, reasonCode: "non_divisible_residual" };
  }

  const todayFacts = [];
  for (const dose of doses) {
    const takenAt = new Date(dose?.takenAt);
    if (!Number.isFinite(takenAt.getTime()) || takenAt.getTime() > evaluation.getTime()) continue;
    const takenAtIso = takenAt.toISOString();
    if (doseDay(takenAtIso, trackerTimezone) !== evaluationDay) continue;

    const grams = Number(dose?.grams ?? DEFAULT_DOSE_GRAMS);
    if (!isValidDoseGrams(grams)) {
      return { ...base, reasonCode: "invalid_dose" };
    }
    todayFacts.push({ takenAtMs: takenAt.getTime(), takenAt: takenAtIso, tenths: toTenths(grams) });
  }

  todayFacts.sort((left, right) => left.takenAtMs - right.takenAtMs);
  const loggedTenths = todayFacts.reduce((sum, dose) => sum + dose.tenths, 0);
  const remainingTenths = Math.max(0, targetTenths - loggedTenths);
  const latestDoseAt = todayFacts.at(-1)?.takenAt ?? null;
  const factualBase = {
    ...base,
    loggedTenths,
    remainingTenths,
    latestDoseAt,
  };

  if (todayFacts.some((dose) => dose.tenths !== SCHEDULE_SERVING_TENTHS)) {
    return { ...factualBase, reasonCode: "non_5g_dose" };
  }

  if (remainingTenths % SCHEDULE_SERVING_TENTHS !== 0) {
    return { ...factualBase, reasonCode: "non_divisible_residual" };
  }

  if (remainingTenths === 0) {
    return { ...factualBase, status: "complete", reasonCode: "target_complete" };
  }

  if (todayFacts.length === 0) {
    return { ...factualBase, status: "awaiting_first_dose", reasonCode: "no_first_dose" };
  }

  const remainingSlotCount = remainingTenths / SCHEDULE_SERVING_TENTHS;
  if (localMinuteOfDay(evaluationIso, trackerTimezone) >= SCHEDULE_CUTOFF_MINUTES) {
    return {
      ...factualBase,
      status: "day_closed",
      reasonCode: "after_cutoff",
      omittedSlotCount: remainingSlotCount,
      omittedTenths: remainingTenths,
    };
  }

  const projections = SCHEDULE_INTERVAL_OPTIONS_MINUTES.map((intervalMinutes) => projectSlots({
    intervalMinutes,
    latestDoseMs: todayFacts.at(-1).takenAtMs,
    evaluationMs: evaluation.getTime(),
    evaluationDay,
    trackerTimezone,
    remainingSlotCount,
  }));
  const projection = projections.find((candidate) => candidate.slots.length === remainingSlotCount) ?? projections.at(-1);
  const { intervalMinutes, nominalNextAt, slots } = projection;

  const omittedSlotCount = remainingSlotCount - slots.length;
  if (slots.length === 0) {
    return {
      ...factualBase,
      status: "day_closed",
      reasonCode: "no_slot_before_cutoff",
      intervalMinutes,
      nominalNextAt,
      omittedSlotCount,
      omittedTenths: omittedSlotCount * SCHEDULE_SERVING_TENTHS,
    };
  }

  return {
    ...factualBase,
    status: "active",
    reasonCode: omittedSlotCount > 0 ? "partial_fit_before_cutoff" : "schedule_ready",
    intervalMinutes,
    nominalNextAt,
    slots,
    omittedSlotCount,
    omittedTenths: omittedSlotCount * SCHEDULE_SERVING_TENTHS,
  };
}
