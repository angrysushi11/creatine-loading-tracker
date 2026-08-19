import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEDULE_CUTOFF_MINUTES,
  SCHEDULE_INTERVAL_MINUTES,
  SCHEDULE_INTERVAL_OPTIONS_MINUTES,
  SCHEDULE_SERVING_TENTHS,
  deriveCreatineSchedule,
} from "../public/tools/creatine-schedule.js";

const zone = "Asia/Makassar";
const dose = (id, takenAt, grams = 5) => ({ id, takenAt, grams });
const derive = (overrides = {}) => deriveCreatineSchedule({
  doses: [],
  plannedDailyGrams: 20,
  defaultDoseGrams: 5,
  trackerTimezone: zone,
  evaluationAt: "2026-08-10T02:00:00.000Z",
  ...overrides,
});

test("publishes the locked five-gram, 5-4-3-hour, 23:00 schedule constants", () => {
  assert.equal(SCHEDULE_SERVING_TENTHS, 50);
  assert.equal(SCHEDULE_INTERVAL_MINUTES, 300);
  assert.deepEqual(SCHEDULE_INTERVAL_OPTIONS_MINUTES, [300, 240, 180]);
  assert.equal(SCHEDULE_CUTOFF_MINUTES, 1380);
});

test("waits for the first factual dose instead of inventing a starting time", () => {
  assert.deepEqual(derive(), {
    status: "awaiting_first_dose",
    reasonCode: "no_first_dose",
    evaluationDay: "2026-08-10",
    targetTenths: 200,
    loggedTenths: 0,
    remainingTenths: 200,
    servingTenths: 50,
    intervalMinutes: 300,
    cutoffMinutes: 1380,
    latestDoseAt: null,
    nominalNextAt: null,
    slots: [],
    omittedSlotCount: 0,
    omittedTenths: 0,
  });
});

test("still waits for a first dose when opened after the scheduling cutoff", () => {
  const result = derive({ evaluationAt: "2026-08-10T16:00:00.000Z" });
  assert.equal(result.status, "awaiting_first_dose");
  assert.equal(result.reasonCode, "no_first_dose");
  assert.deepEqual(result.slots, []);
});

test("anchors a full schedule to the latest actual dose regardless of input order", () => {
  const doses = [
    dose("later", "2026-08-10T03:36:00.000Z"),
    dose("first", "2026-08-09T22:36:00.000Z"),
  ];
  const result = derive({ doses, evaluationAt: "2026-08-10T04:00:00.000Z" });

  assert.equal(result.status, "active");
  assert.equal(result.reasonCode, "schedule_ready");
  assert.equal(result.latestDoseAt, "2026-08-10T03:36:00.000Z");
  assert.equal(result.loggedTenths, 100);
  assert.equal(result.remainingTenths, 100);
  assert.deepEqual(result.slots, [
    { kind: "scheduled", at: "2026-08-10T08:36:00.000Z" },
    { kind: "scheduled", at: "2026-08-10T13:36:00.000Z" },
  ]);
});

test("an edited latest timestamp deterministically moves the projection", () => {
  const beforeEdit = derive({
    doses: [dose("same-id", "2026-08-10T00:00:00.000Z")],
    evaluationAt: "2026-08-10T01:00:00.000Z",
  });
  const afterEdit = derive({
    doses: [dose("same-id", "2026-08-10T01:00:00.000Z")],
    evaluationAt: "2026-08-10T01:00:00.000Z",
  });

  assert.equal(beforeEdit.intervalMinutes, 240);
  assert.equal(afterEdit.intervalMinutes, 240);
  assert.equal(beforeEdit.slots[0].at, "2026-08-10T04:00:00.000Z");
  assert.equal(afterEdit.slots[0].at, "2026-08-10T05:00:00.000Z");
});

test("uses four-hour spacing when a 10:30 first dose would push the fourth serving past 23:00", () => {
  const result = derive({
    doses: [dose("first", "2026-08-10T02:30:00.000Z")],
    evaluationAt: "2026-08-10T02:31:00.000Z",
  });

  assert.equal(result.intervalMinutes, 240);
  assert.equal(result.reasonCode, "schedule_ready");
  assert.deepEqual(result.slots, [
    { kind: "scheduled", at: "2026-08-10T06:30:00.000Z" },
    { kind: "scheduled", at: "2026-08-10T10:30:00.000Z" },
    { kind: "scheduled", at: "2026-08-10T14:30:00.000Z" },
  ]);
});

test("uses three-hour spacing when four hours still cannot fit the remaining servings", () => {
  const result = derive({
    doses: [dose("first", "2026-08-10T04:00:00.000Z")],
    evaluationAt: "2026-08-10T04:01:00.000Z",
  });

  assert.equal(result.intervalMinutes, 180);
  assert.equal(result.reasonCode, "schedule_ready");
  assert.deepEqual(result.slots, [
    { kind: "scheduled", at: "2026-08-10T07:00:00.000Z" },
    { kind: "scheduled", at: "2026-08-10T10:00:00.000Z" },
    { kind: "scheduled", at: "2026-08-10T13:00:00.000Z" },
  ]);
});

test("turns an elapsed suggestion into one due-now slot and never stacks misses", () => {
  const result = derive({
    doses: [dose("first", "2026-08-09T22:00:00.000Z")],
    evaluationAt: "2026-08-10T09:30:00.000Z",
  });

  assert.equal(result.intervalMinutes, 180);
  assert.equal(result.nominalNextAt, "2026-08-10T01:00:00.000Z");
  assert.deepEqual(result.slots, [
    { kind: "due_now", at: "2026-08-10T09:30:00.000Z" },
    { kind: "scheduled", at: "2026-08-10T12:30:00.000Z" },
  ]);
  assert.equal(result.omittedSlotCount, 1);
  assert.equal(result.omittedTenths, 50);
});

test("treats exact due-time equality as one due-now slot", () => {
  const result = derive({
    doses: [dose("first", "2026-08-10T01:00:00.000Z")],
    evaluationAt: "2026-08-10T06:00:00.000Z",
  });
  assert.deepEqual(result.slots[0], { kind: "due_now", at: "2026-08-10T06:00:00.000Z" });
});

test("allows suggestions before 23:00 but excludes the exact 23:00 boundary", () => {
  const beforeBoundary = derive({
    doses: [dose("first", "2026-08-10T11:59:00.000Z")],
    evaluationAt: "2026-08-10T12:00:00.000Z",
  });
  assert.equal(beforeBoundary.intervalMinutes, 180);
  assert.equal(beforeBoundary.slots[0].at, "2026-08-10T14:59:00.000Z");

  const atBoundary = derive({
    doses: [dose("first", "2026-08-10T12:00:00.000Z")],
    evaluationAt: "2026-08-10T12:01:00.000Z",
  });
  assert.equal(atBoundary.status, "day_closed");
  assert.equal(atBoundary.reasonCode, "no_slot_before_cutoff");
  assert.equal(atBoundary.slots.length, 0);
  assert.equal(atBoundary.omittedSlotCount, 3);
});

test("closes suggestions at 23:00 without changing any logging state", () => {
  const result = derive({
    doses: [dose("first", "2026-08-10T10:00:00.000Z")],
    evaluationAt: "2026-08-10T15:00:00.000Z",
  });
  assert.equal(result.status, "day_closed");
  assert.equal(result.reasonCode, "after_cutoff");
  assert.equal(result.remainingTenths, 150);
  assert.equal(result.omittedSlotCount, 3);
});

test("closes a 22:00 first-dose day when even the three-hour slot is tomorrow", () => {
  const result = derive({
    doses: [dose("late", "2026-08-10T14:00:00.000Z")],
    evaluationAt: "2026-08-10T14:10:00.000Z",
  });
  assert.equal(result.latestDoseAt, "2026-08-10T14:00:00.000Z");
  assert.equal(result.status, "day_closed");
  assert.equal(result.reasonCode, "no_slot_before_cutoff");
  assert.equal(result.omittedSlotCount, 3);
});

test("uses tracker-local today at a timezone boundary", () => {
  const result = derive({
    trackerTimezone: "America/Los_Angeles",
    evaluationAt: "2026-08-10T07:30:00.000Z",
    doses: [
      dose("la-today", "2026-08-10T07:10:00.000Z"),
      dose("utc-today-la-yesterday", "2026-08-10T06:50:00.000Z"),
    ],
  });
  assert.equal(result.evaluationDay, "2026-08-10");
  assert.equal(result.loggedTenths, 50);
  assert.equal(result.latestDoseAt, "2026-08-10T07:10:00.000Z");
});

test("ignores future doses, including future custom amounts", () => {
  const result = derive({
    doses: [
      dose("actual", "2026-08-10T01:00:00.000Z"),
      dose("future-custom", "2026-08-10T03:00:00.000Z", 3),
    ],
    evaluationAt: "2026-08-10T02:00:00.000Z",
  });
  assert.equal(result.status, "active");
  assert.equal(result.loggedTenths, 50);
  assert.equal(result.latestDoseAt, "2026-08-10T01:00:00.000Z");
});

test("fails closed for non-five-gram defaults and factual custom doses", () => {
  const nonFiveDefault = derive({ defaultDoseGrams: 3 });
  assert.equal(nonFiveDefault.status, "unavailable");
  assert.equal(nonFiveDefault.reasonCode, "non_5g_default");

  const customFact = derive({ doses: [dose("custom", "2026-08-10T01:00:00.000Z", 3)] });
  assert.equal(customFact.status, "unavailable");
  assert.equal(customFact.reasonCode, "non_5g_dose");
  assert.equal(customFact.loggedTenths, 30);
  assert.equal(customFact.remainingTenths, 170);
});

test("fails closed when the target leaves a non-five-gram residual", () => {
  const result = derive({ plannedDailyGrams: 17.5 });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reasonCode, "non_divisible_residual");
  assert.equal(result.targetTenths, 175);
});

test("fails closed without an explicit valid tracker timezone", () => {
  assert.equal(derive({ trackerTimezone: undefined }).reasonCode, "invalid_input");
  assert.equal(derive({ trackerTimezone: "Not/AZone" }).reasonCode, "invalid_input");
});

test("returns only the slots that fit today and counts omitted servings", () => {
  const result = derive({
    doses: [dose("first", "2026-08-10T07:00:00.000Z")],
    evaluationAt: "2026-08-10T07:10:00.000Z",
  });
  assert.equal(result.status, "active");
  assert.equal(result.reasonCode, "partial_fit_before_cutoff");
  assert.equal(result.intervalMinutes, 180);
  assert.deepEqual(result.slots, [
    { kind: "scheduled", at: "2026-08-10T10:00:00.000Z" },
    { kind: "scheduled", at: "2026-08-10T13:00:00.000Z" },
  ]);
  assert.equal(result.omittedSlotCount, 1);
  assert.equal(result.omittedTenths, 50);
});

test("reports a clean completed target without producing suggestions", () => {
  const result = derive({
    doses: [
      dose("one", "2026-08-09T22:00:00.000Z"),
      dose("two", "2026-08-10T03:00:00.000Z"),
      dose("three", "2026-08-10T08:00:00.000Z"),
      dose("four", "2026-08-10T13:00:00.000Z"),
    ],
    evaluationAt: "2026-08-10T13:00:00.000Z",
  });
  assert.equal(result.status, "complete");
  assert.equal(result.reasonCode, "target_complete");
  assert.equal(result.loggedTenths, 200);
  assert.equal(result.remainingTenths, 0);
  assert.deepEqual(result.slots, []);
});
