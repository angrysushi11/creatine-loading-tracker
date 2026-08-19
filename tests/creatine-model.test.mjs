import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_DECAY_POINTS,
  DEFAULT_DOSE_GRAMS,
  FULL_LOADING_DAY_CREDIT_POINTS,
  LEGACY_MODEL_VERSION,
  MODEL_VERSION,
  TRACKER_SCHEMA_VERSION,
  calculateProgress,
  hasUniqueDoseIds,
  isSupportedTrackingDate,
  isValidDateString,
  isValidDoseGrams,
  migrateTrackerState,
  plannedDailyTarget,
  progressToOneDecimal,
} from "../public/tools/creatine-model.js";

const profile = { weightKg: 60, trackingStartDate: "2026-08-01", trackerTimezone: "Asia/Makassar" };
const dose = (id, takenAt) => ({ id, takenAt, timezone: "Asia/Makassar", grams: 5 });
const sixDayLoad = () => Array.from({ length: 6 }, (_, dayIndex) => (
  Array.from({ length: 4 }, (_, servingIndex) => dose(
    `day-${dayIndex + 1}-serving-${servingIndex + 1}`,
    `2026-08-0${dayIndex + 1}T0${servingIndex + 1}:00:00.000Z`,
  ))
)).flat();

test("uses the transparent, clamped five-gram plan", () => {
  assert.deepEqual(plannedDailyTarget(60), { rawTargetGrams: 18, plannedServings: 4, plannedDailyGrams: 20 });
  assert.equal(plannedDailyTarget(20).plannedServings, 2);
  assert.equal(plannedDailyTarget(100).plannedServings, 5);
});

test("credits a partial day and formats the display to one decimal", () => {
  const result = calculateProgress({ profile, doses: [dose("a", "2026-08-01T01:00:00.000Z")], evaluationAt: "2026-08-01T02:00:00.000Z" });
  assert.equal(result.rawProgress, FULL_LOADING_DAY_CREDIT_POINTS / 4);
  assert.equal(progressToOneDecimal(result.rawProgress), "4.8");
  assert.equal(progressToOneDecimal(42.49), "42.5");
});

test("caps a day at its plan and ignores input order", () => {
  const doses = [dose("a", "2026-08-01T01:00:00.000Z"), dose("b", "2026-08-01T02:00:00.000Z"), dose("c", "2026-08-01T03:00:00.000Z"), dose("d", "2026-08-01T04:00:00.000Z"), dose("e", "2026-08-01T05:00:00.000Z")];
  const normal = calculateProgress({ profile, doses, evaluationAt: "2026-08-01T08:00:00.000Z" });
  const reversed = calculateProgress({ profile, doses: [...doses].reverse(), evaluationAt: "2026-08-01T08:00:00.000Z" });
  assert.equal(normal.rawProgress, FULL_LOADING_DAY_CREDIT_POINTS);
  assert.equal(normal.rawProgress, reversed.rawProgress);
});

test("applies a gradual completed-day no-dose decline without resetting", () => {
  const result = calculateProgress({ profile, doses: [dose("a", "2026-08-01T01:00:00.000Z"), dose("b", "2026-08-01T02:00:00.000Z"), dose("c", "2026-08-01T03:00:00.000Z"), dose("d", "2026-08-01T04:00:00.000Z")], evaluationAt: "2026-08-03T01:00:00.000Z" });
  assert.equal(result.rawProgress, FULL_LOADING_DAY_CREDIT_POINTS - DAILY_DECAY_POINTS);
});

test("applies the daily balance even when a small dose was logged", () => {
  const result = calculateProgress({
    profile,
    doses: [
      dose("a", "2026-08-01T01:00:00.000Z"),
      dose("b", "2026-08-01T02:00:00.000Z"),
      dose("c", "2026-08-01T03:00:00.000Z"),
      dose("d", "2026-08-01T04:00:00.000Z"),
      { ...dose("tiny", "2026-08-02T01:00:00.000Z"), grams: 0.1 },
    ],
    evaluationAt: "2026-08-03T01:00:00.000Z",
  });
  assert.equal(result.rawProgress, FULL_LOADING_DAY_CREDIT_POINTS - DAILY_DECAY_POINTS + ((0.1 / 20) * FULL_LOADING_DAY_CREDIT_POINTS));
});

test("switches permanently to maintenance when six target days first reach the plateau", () => {
  const result = calculateProgress({
    profile: { ...profile, defaultDoseGrams: 5 },
    doses: sixDayLoad(),
    evaluationAt: "2026-08-06T08:00:00.000Z",
  });
  assert.equal(result.rawProgress, 100);
  assert.equal(result.mode, "maintenance");
  assert.equal(result.phase, "Maintenance");
  assert.equal(result.plateauReachedDay, "2026-08-06");
  assert.equal(result.dailyTargetGrams, 5);
  assert.equal(result.todayPlanPercent, 100);
});

test("keeps maintenance mode after a missed day and restores the estimate with the usual five grams", () => {
  const loaded = sixDayLoad();
  const afterMiss = calculateProgress({
    profile: { ...profile, defaultDoseGrams: 5 },
    doses: loaded,
    evaluationAt: "2026-08-08T01:00:00.000Z",
  });
  assert.equal(afterMiss.rawProgress, 100 - DAILY_DECAY_POINTS);
  assert.equal(afterMiss.mode, "maintenance");
  assert.equal(afterMiss.dailyTargetGrams, 5);
  assert.equal(afterMiss.todayPlanPercent, 0);

  const afterResume = calculateProgress({
    profile: { ...profile, defaultDoseGrams: 5 },
    doses: [...loaded, dose("resume", "2026-08-08T01:00:00.000Z")],
    evaluationAt: "2026-08-08T02:00:00.000Z",
  });
  assert.equal(afterResume.rawProgress, 100);
  assert.equal(afterResume.mode, "maintenance");
  assert.equal(afterResume.todayPlanPercent, 100);
});

test("a three-gram usual amount can maintain the plateau while setting the maintenance target", () => {
  const result = calculateProgress({
    profile: { ...profile, defaultDoseGrams: 3 },
    doses: [...sixDayLoad(), { ...dose("maintenance", "2026-08-07T01:00:00.000Z"), grams: 3 }],
    evaluationAt: "2026-08-08T01:00:00.000Z",
  });
  assert.equal(result.rawProgress, 100);
  assert.equal(result.mode, "maintenance");
  assert.equal(result.dailyTargetGrams, 3);
});

test("editing history so the plateau was never reached returns the derived mode to loading", () => {
  const result = calculateProgress({
    profile: { ...profile, defaultDoseGrams: 5 },
    doses: sixDayLoad().slice(0, 20),
    evaluationAt: "2026-08-08T01:00:00.000Z",
  });
  assert.equal(result.mode, "loading");
  assert.equal(result.plateauReachedDay, null);
  assert.equal(result.dailyTargetGrams, 20);
});

test("uses tracker-calendar days at a timezone boundary", () => {
  const result = calculateProgress({ profile, doses: [dose("a", "2026-07-31T17:30:00.000Z")], evaluationAt: "2026-07-31T18:00:00.000Z" });
  assert.equal(result.evaluationDay, "2026-08-01");
  assert.equal(result.todayLoggedGrams, 5);
});

test("remains bounded after long periods and future doses", () => {
  const result = calculateProgress({ profile, doses: [dose("future", "2026-12-01T00:00:00.000Z")], evaluationAt: "2026-08-09T00:00:00.000Z" });
  assert.equal(result.rawProgress, 0);
  assert.equal(progressToOneDecimal(result.rawProgress), "0.0");
});

test("uses the actual amount for variable-dose progress and keeps dose counts factual", () => {
  const result = calculateProgress({
    profile: { ...profile, defaultDoseGrams: 3 },
    doses: [
      { ...dose("a", "2026-08-01T01:00:00.000Z"), grams: 3 },
      { ...dose("b", "2026-08-01T02:00:00.000Z"), grams: 7.5 },
    ],
    evaluationAt: "2026-08-01T08:00:00.000Z",
  });
  assert.equal(result.todayLoggedGrams, 10.5);
  assert.equal(result.todayDoseCount, 2);
  assert.equal(result.rawProgress, (10.5 / 20) * FULL_LOADING_DAY_CREDIT_POINTS);
});

test("caps variable-dose credit at the daily target without changing the factual total", () => {
  const result = calculateProgress({
    profile,
    doses: [{ ...dose("a", "2026-08-01T01:00:00.000Z"), grams: 25 }],
    evaluationAt: "2026-08-01T08:00:00.000Z",
  });
  assert.equal(result.todayLoggedGrams, 25);
  assert.equal(result.rawProgress, FULL_LOADING_DAY_CREDIT_POINTS);
});

test("rejects impossible dates and bounds pathological timelines", () => {
  assert.equal(isValidDateString("2026-02-29"), false);
  assert.equal(isValidDateString("2024-02-29"), true);
  assert.equal(calculateProgress({ profile: { ...profile, trackingStartDate: "1900-01-01" }, doses: [], evaluationAt: "2026-08-09T00:00:00.000Z" }), null);
});

test("allows the tracker-local date when it is ahead of UTC", () => {
  const afterMakassarMidnight = "2026-08-09T16:30:00.000Z";
  assert.equal(isSupportedTrackingDate("2026-08-10", "Asia/Makassar", afterMakassarMidnight), true);
  assert.equal(isSupportedTrackingDate("2026-08-10", "UTC", afterMakassarMidnight), false);
  assert.equal(isSupportedTrackingDate("2016-08-01", "Asia/Makassar", afterMakassarMidnight), false);
});

test("requires unique dose IDs before a tracker state can be trusted", () => {
  assert.equal(hasUniqueDoseIds([dose("a", "2026-08-01T01:00:00.000Z"), dose("b", "2026-08-01T02:00:00.000Z")]), true);
  assert.equal(hasUniqueDoseIds([dose("a", "2026-08-01T01:00:00.000Z"), dose("a", "2026-08-01T02:00:00.000Z")]), false);
});

test("accepts factual custom amounts within the typo guardrail", () => {
  assert.equal(isValidDoseGrams(0.1), true);
  assert.equal(isValidDoseGrams(3), true);
  assert.equal(isValidDoseGrams(3.1), true);
  assert.equal(isValidDoseGrams(100), true);
  assert.equal(isValidDoseGrams(3.14), false);
  assert.equal(isValidDoseGrams(0), false);
  assert.equal(isValidDoseGrams(100.1), false);
  assert.equal(isValidDoseGrams(Number.NaN), false);
});

test("rejects v2 tracker data with precision finer than one tenth of a gram", () => {
  const validState = {
    schemaVersion: TRACKER_SCHEMA_VERSION,
    modelVersion: MODEL_VERSION,
    profile: { ...profile, defaultDoseGrams: 3.1 },
    doses: [{ ...dose("a", "2026-08-01T01:00:00.000Z"), grams: 3.1 }],
  };
  assert.ok(migrateTrackerState(validState, "2026-08-09T00:00:00.000Z"));
  assert.equal(migrateTrackerState({ ...validState, profile: { ...validState.profile, defaultDoseGrams: 3.14 } }, "2026-08-09T00:00:00.000Z"), null);
  assert.equal(migrateTrackerState({ ...validState, doses: [{ ...validState.doses[0], grams: 3.14 }] }, "2026-08-09T00:00:00.000Z"), null);
});

test("rejects a dose history that has no tracker profile", () => {
  const blankState = { schemaVersion: TRACKER_SCHEMA_VERSION, modelVersion: MODEL_VERSION, profile: null, doses: [] };
  assert.deepEqual(migrateTrackerState(blankState, "2026-08-09T00:00:00.000Z"), blankState);
  assert.equal(migrateTrackerState({ ...blankState, doses: [dose("orphan", "2026-08-01T01:00:00.000Z")] }, "2026-08-09T00:00:00.000Z"), null);
});

test("ignores model inputs with precision finer than one tenth of a gram", () => {
  const result = calculateProgress({
    profile,
    doses: [
      { ...dose("valid", "2026-08-01T01:00:00.000Z"), grams: 3.1 },
      { ...dose("invalid", "2026-08-01T02:00:00.000Z"), grams: 3.14 },
    ],
    evaluationAt: "2026-08-01T08:00:00.000Z",
  });
  assert.equal(result.todayLoggedGrams, 3.1);
  assert.equal(result.todayDoseCount, 1);
});

test("migrates v1 state to v2 without changing dose identity or timestamps", () => {
  const legacy = {
    schemaVersion: 1,
    modelVersion: LEGACY_MODEL_VERSION,
    profile: { ...profile, defaultDoseGrams: DEFAULT_DOSE_GRAMS },
    doses: [{ ...dose("legacy-id", "2026-08-01T01:00:00.000Z"), createdAt: "2026-08-01T01:01:00.000Z", entryMethod: "now" }],
  };
  const migrated = migrateTrackerState(legacy, "2026-08-09T00:00:00.000Z");
  assert.equal(migrated.schemaVersion, TRACKER_SCHEMA_VERSION);
  assert.equal(migrated.modelVersion, MODEL_VERSION);
  assert.equal(migrated.profile.defaultDoseGrams, 5);
  assert.equal(migrated.doses[0].id, "legacy-id");
  assert.equal(migrated.doses[0].takenAt, "2026-08-01T01:00:00.000Z");
  assert.equal(migrated.doses[0].createdAt, "2026-08-01T01:01:00.000Z");
});

test("rejects legacy states that pretend to contain non-5 g entries", () => {
  const malformedLegacy = {
    schemaVersion: 1,
    modelVersion: LEGACY_MODEL_VERSION,
    profile: { ...profile, defaultDoseGrams: 5 },
    doses: [{ ...dose("a", "2026-08-01T01:00:00.000Z"), grams: 3 }],
  };
  assert.equal(migrateTrackerState(malformedLegacy, "2026-08-09T00:00:00.000Z"), null);
});
