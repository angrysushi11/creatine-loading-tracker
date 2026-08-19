import {
  DEFAULT_DOSE_GRAMS,
  MODEL_VERSION,
  TRACKER_SCHEMA_VERSION,
  addCalendarDays,
  calculateProgress,
  doseDay,
  isSupportedTrackingDate,
  isValidDoseGrams,
  isValidTimeZone,
  migrateTrackerState,
  progressToOneDecimal,
} from "/tools/creatine-model.js";
import { createCreatineCloudAdapter, createSerializedMutationQueue, planGuestMigration, prepareGuestImport, trackerContentFingerprint } from "/tools/creatine-cloud-adapter.js";
import { deriveCreatineSchedule } from "/tools/creatine-schedule.js";

const STORAGE_KEY = "doubledash.creatine-loading.v2";
const ACCOUNT_STORAGE_PREFIX = "doubledash.creatine-loading.v2.account.";
const LEGACY_STORAGE_KEY = "doubledash.creatine-loading.v1";
const SAVE_PROMPT_DISMISSED_KEY = "doubledash.creatine-save-prompt.dismissed";
const GUEST_IMPORT_INTENT_KEY = "doubledash.creatine-email.guest-import";
const GUEST_IMPORT_INTENT_TTL_MS = 60 * 60 * 1000;
const app = document.querySelector("[data-creatine-app]");
const $ = (selector) => document.querySelector(selector);
const storageWarning = $("#storageWarning");
const liveStatus = $("#liveStatus");
const setupPanel = $("#setupPanel");
const dashboardPanel = $("#dashboardPanel");
const doseDialog = $("#doseDialog");
const deleteDialog = $("#deleteDialog");
const deleteAccountDialog = $("#deleteAccountDialog");
const savePromptDialog = $("#savePromptDialog");
const emailSignInDialog = $("#emailSignInDialog");
const cloudConflictDialog = $("#cloudConflictDialog");
const cloud = createCreatineCloudAdapter();
let state;
let editingDoseId = null;
let undoPayload = null;
let undoTimer = null;
let recoveryMode = false;
let accountSession = null;
let pendingCloudState = null;
let localOwnerUserId = null;
let pendingCloudMutations = 0;
let cloudHasUnsyncedChanges = false;
let cloudSyncFailure = false;
let pendingSignOutAttempt = null;
let guestImportIntentCleanupTimer = null;
let authEpoch = 0;
let localRevision = 0;
let accountTransitioning = false;
let cloudChoiceInProgress = false;
let accountLockUserId = null;
let accountLockEpoch = null;
let accountLockRelease = null;
let accountLockRequest = null;
let accountLockReady = null;
let accountLockReleaseBarrier = Promise.resolve();
let accountTabBlocked = false;
let timeRefreshTimer = null;
let renderedEvaluationDay = null;
const cloudMutationQueue = createSerializedMutationQueue();

const safetyCopy = `
  <p><strong>For adults.</strong> Creatine loading is optional.</p>
  <p>This is a tracking and estimation tool, not medical advice.</p>
  <p>It does not diagnose, test, or measure muscle creatine.</p>
  <p><strong>How this model reads progress:</strong> 0% means the assumed start of supplemental loading, not zero creatine in muscle. 100% means this model’s typical supplemented plateau, not a measured biological maximum. Exact dose logs and the modelled estimate are shown separately.</p>
  <p><strong>Model v2 assumptions:</strong> each completed tracker-calendar day applies a 100/42 decline before logged doses are credited. A full loading day is calibrated so six target-days reach the plateau, and the estimate stays bounded from 0 to 100.</p>
  <p>Typical rapid-loading protocols are about 20 g/day (often four 5 g servings) for 5–7 days, or about 0.3 g/kg/day for 5–7 days. <a href="https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-HealthProfessional/" target="_blank" rel="noreferrer">NIH ODS</a> · <a href="https://doi.org/10.1186/s12970-021-00412-w" target="_blank" rel="noreferrer">ISSN practical review</a> · <a href="https://pubmed.ncbi.nlm.nih.gov/8828669/" target="_blank" rel="noreferrer">Hultman et al. 1996</a> · <a href="https://doi.org/10.1186/s12970-017-0173-z" target="_blank" rel="noreferrer">ISSN position stand</a> · <a href="https://doi.org/10.3390/nu14051035" target="_blank" rel="noreferrer">Kreider et al. 2022</a>.</p>
  <p><strong>Suggested timing:</strong> the tracker tries five-hour spacing, then four, then three when needed, and stops suggesting times at 23:00. These are convenience rules for spacing servings through the day. Factual logging remains available.</p>
  <p>Amounts above 5 g can be recorded as factual history; their presence in the log is not a recommendation to take that amount.</p>
  <p>If you are pregnant or breastfeeding, have kidney disease, take medication that affects kidney function, or have been told to limit creatine, check with a clinician before supplementing.</p>
  <p>Tell a clinician you use creatine when discussing kidney-related blood tests, because supplementation can affect interpretation of serum creatinine.</p>
  <p>Stop and seek clinical advice for persistent or concerning symptoms.</p>
  <p><a href="https://github.com/angrysushi11/creatine-loading-tracker" target="_blank" rel="noreferrer">Source code and exact data boundary</a>.</p>`;
document.querySelectorAll("[data-safety-copy]").forEach((element) => { element.innerHTML = safetyCopy; });

function detectedTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function blankState() {
  return { schemaVersion: TRACKER_SCHEMA_VERSION, modelVersion: MODEL_VERSION, profile: null, doses: [] };
}

function showWarning(message) {
  storageWarning.textContent = message;
  storageWarning.hidden = false;
}

function clearWarning() {
  storageWarning.textContent = "";
  storageWarning.hidden = true;
}

function announce(message, context = currentAuthContext()) {
  liveStatus.textContent = "";
  window.setTimeout(() => {
    if (authContextMatches(context)) liveStatus.textContent = message;
  }, 20);
}

function accountStorageKey(userId) {
  return `${ACCOUNT_STORAGE_PREFIX}${userId}`;
}

function legacyAccountBackupKey(userId) {
  return `${accountStorageKey(userId)}.legacy-backup`;
}

function currentAuthContext() {
  return { userId: accountSession?.user?.id || null, epoch: authEpoch };
}

function authContextMatches(context) {
  return Boolean(context) && context.epoch === authEpoch && (accountSession?.user?.id || null) === context.userId;
}

function setTrackerTransitioning(value) {
  accountTransitioning = Boolean(value);
  setupPanel.inert = accountTransitioning;
  dashboardPanel.inert = accountTransitioning;
  const settingsPanel = $("#settingsPanel");
  if (settingsPanel) settingsPanel.inert = accountTransitioning;
  app?.setAttribute("aria-busy", String(accountTransitioning));
  const signOutButton = $("#signOut");
  if (signOutButton) signOutButton.disabled = accountTransitioning && !accountTabBlocked;
}

function sameLockContext(context) {
  return Boolean(context) && accountLockUserId === context.userId && accountLockEpoch === context.epoch;
}

function releaseAccountTabLock(expectedContext = null) {
  if (expectedContext && !sameLockContext(expectedContext)) return false;
  const finishingRequest = accountLockRequest;
  accountLockRelease?.();
  if (finishingRequest) accountLockReleaseBarrier = Promise.resolve(finishingRequest).catch(() => undefined);
  accountLockRelease = null;
  accountLockRequest = null;
  accountLockReady = null;
  accountLockUserId = null;
  accountLockEpoch = null;
  accountTabBlocked = false;
  return true;
}

async function acquireAccountTabLock(context) {
  if (!authContextMatches(context) || !context.userId) return false;
  if (sameLockContext(context) && accountLockRelease) return true;
  if (sameLockContext(context) && accountLockReady) return accountLockReady;
  releaseAccountTabLock();
  await accountLockReleaseBarrier;
  if (!authContextMatches(context)) return false;
  accountLockUserId = context.userId;
  accountLockEpoch = context.epoch;
  if (!navigator.locks?.request) {
    accountLockReady = Promise.resolve(false);
    return false;
  }

  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  accountLockReady = ready;
  accountLockRequest = navigator.locks.request(
    `doubledash-creatine-account-${context.userId}`,
    { mode: "exclusive", ifAvailable: true },
    (lock) => {
      if (!lock || !authContextMatches(context) || !sameLockContext(context)) {
        resolveReady(false);
        return undefined;
      }
      const held = new Promise((resolve) => { accountLockRelease = resolve; });
      accountLockUserId = context.userId;
      resolveReady(true);
      return held;
    },
  ).catch(() => resolveReady(false));
  return ready;
}

function clearPendingCloudChoice() {
  pendingCloudState = null;
  cloudChoiceInProgress = false;
  if ($("#useAccountData")) $("#useAccountData").disabled = false;
  if ($("#keepBrowserData")) $("#keepBrowserData").disabled = false;
  if ($("#downloadBrowserBackup")) $("#downloadBrowserBackup").disabled = false;
  if (cloudConflictDialog?.open) cloudConflictDialog.close();
}

function claimPendingCloudChoice() {
  if (cloudChoiceInProgress || !pendingCloudState || !authContextMatches(pendingCloudState)) return null;
  const choice = pendingCloudState;
  pendingCloudState = null;
  cloudChoiceInProgress = true;
  $("#useAccountData").disabled = true;
  $("#keepBrowserData").disabled = true;
  $("#downloadBrowserBackup").disabled = true;
  return choice;
}

function releasePendingCloudChoice(choice) {
  if (!choice || !authContextMatches(choice) || pendingCloudState) return;
  pendingCloudState = choice;
  cloudChoiceInProgress = false;
  $("#useAccountData").disabled = false;
  $("#keepBrowserData").disabled = false;
  $("#downloadBrowserBackup").disabled = false;
}

function resetSetupInputs() {
  const weight = $("#weight");
  const weightUnit = $("#weightUnit");
  const trackingStartDate = $("#trackingStartDate");
  const setupTimezone = $("#setupTimezone");
  const defaultFive = document.querySelector('input[name="defaultDose"][value="5"]');
  if (weight) weight.value = "";
  if (weightUnit) weightUnit.value = "kg";
  if (trackingStartDate) trackingStartDate.value = "";
  if (setupTimezone) setupTimezone.value = "";
  if (defaultFive) defaultFive.checked = true;
  $("#setupCustomDoseWrap")?.setAttribute("hidden", "");
  if ($("#setupCustomDose")) {
    $("#setupCustomDose").value = "";
    $("#setupCustomDose").required = false;
    $("#setupCustomDose").disabled = true;
  }
  if ($("#setupDoseWarning")) setInlineWarning($("#setupDoseWarning"), "");
}

function quarantineAccountState() {
  state = blankState();
  localOwnerUserId = null;
  cloudHasUnsyncedChanges = false;
  cloudSyncFailure = false;
  resetSetupInputs();
}

function storedEnvelope(candidate) {
  return { ...candidate, localOwnerUserId, cloudUnsynced: Boolean(localOwnerUserId && cloudHasUnsyncedChanges) };
}

function writeState(candidate) {
  try {
    const key = localOwnerUserId ? accountStorageKey(localOwnerUserId) : STORAGE_KEY;
    window.localStorage.setItem(key, JSON.stringify(storedEnvelope(candidate)));
    return true;
  } catch {
    showWarning("This browser could not save tracker data. Keep this tab open and export a backup if possible.");
    return false;
  }
}

function loadState() {
  try {
    cleanupExpiredGuestImportIntent();
    const currentRaw = window.localStorage.getItem(STORAGE_KEY);
    if (currentRaw) {
      const parsed = JSON.parse(currentRaw);
      const current = migrateTrackerState(parsed);
      const previousOwner = typeof parsed?.localOwnerUserId === "string" && parsed.localOwnerUserId ? parsed.localOwnerUserId : null;
      if (current && previousOwner) {
        const destinationKey = accountStorageKey(previousOwner);
        const migratedEnvelope = JSON.stringify({ ...current, localOwnerUserId: previousOwner, cloudUnsynced: Boolean(parsed.cloudUnsynced) });
        const existingAccountCache = window.localStorage.getItem(destinationKey);
        if (existingAccountCache === null) {
          window.localStorage.setItem(destinationKey, migratedEnvelope);
        } else if (existingAccountCache !== migratedEnvelope && window.localStorage.getItem(legacyAccountBackupKey(previousOwner)) === null) {
          window.localStorage.setItem(legacyAccountBackupKey(previousOwner), migratedEnvelope);
        }
        window.localStorage.removeItem(STORAGE_KEY);
        return blankState();
      }
      if (current) return current;
      recoveryMode = true;
      showWarning("Saved tracker data looks invalid. It has not been deleted. Replace it by importing a valid backup, or delete the tracker data if you no longer need it.");
      return blankState();
    }

    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) return blankState();
    const migrated = migrateTrackerState(JSON.parse(legacyRaw));
    if (!migrated) {
      recoveryMode = true;
      showWarning("Saved tracker data looks invalid. It has not been deleted. Replace it by importing a valid backup, or delete the tracker data if you no longer need it.");
      return blankState();
    }
    if (writeState(migrated) && window.localStorage.getItem(STORAGE_KEY)) {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
    return migrated;
  } catch {
    recoveryMode = true;
    showWarning("This browser could not read the tracker’s local data. Your existing data has not been changed.");
    return blankState();
  }
}

function activateAccountCache(userId) {
  try {
    const raw = window.localStorage.getItem(accountStorageKey(userId));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const cached = migrateTrackerState(parsed);
    if (!cached || parsed.localOwnerUserId !== userId) {
      showWarning("This account’s browser cache looks invalid. It was not loaded or deleted; cloud data will be checked instead.");
      return false;
    }
    state = cached;
    localOwnerUserId = userId;
    cloudHasUnsyncedChanges = Boolean(parsed.cloudUnsynced);
    cloudSyncFailure = cloudHasUnsyncedChanges;
    return true;
  } catch {
    showWarning("This account’s browser cache could not be read. Cloud data will be checked instead.");
    return false;
  }
}

function saveState({ cloudSynced = false, localMutation = !cloudSynced } = {}) {
  if (localMutation) localRevision += 1;
  if (accountSession?.user?.id) {
    localOwnerUserId = accountSession.user.id;
    cloudHasUnsyncedChanges = !cloudSynced;
    if (cloudSynced) cloudSyncFailure = false;
  }
  return writeState(state);
}

function removeStoredState() {
  try {
    if (localOwnerUserId) {
      window.localStorage.removeItem(accountStorageKey(localOwnerUserId));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      window.localStorage.removeItem(GUEST_IMPORT_INTENT_KEY);
      window.clearTimeout(guestImportIntentCleanupTimer);
      guestImportIntentCleanupTimer = null;
    }
    localOwnerUserId = null;
    cloudHasUnsyncedChanges = false;
    cloudSyncFailure = false;
    return true;
  } catch {
    showWarning("This browser could not remove the stored tracker data.");
    return false;
  }
}

function removeGuestStoredState() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    window.localStorage.removeItem(GUEST_IMPORT_INTENT_KEY);
    window.clearTimeout(guestImportIntentCleanupTimer);
    guestImportIntentCleanupTimer = null;
    return true;
  } catch {
    showWarning("The account is saved, but this browser could not remove the old guest copy.");
    return false;
  }
}

function cloneTrackerState(candidate) {
  return JSON.parse(JSON.stringify(candidate));
}

function captureLocalTrackerContext() {
  try {
    const keys = new Set([STORAGE_KEY, LEGACY_STORAGE_KEY, GUEST_IMPORT_INTENT_KEY]);
    if (localOwnerUserId) {
      keys.add(accountStorageKey(localOwnerUserId));
      keys.add(legacyAccountBackupKey(localOwnerUserId));
    }
    if (accountSession?.user?.id) {
      keys.add(accountStorageKey(accountSession.user.id));
      keys.add(legacyAccountBackupKey(accountSession.user.id));
    }
    return {
      state: cloneTrackerState(state),
      localOwnerUserId,
      cloudHasUnsyncedChanges,
      cloudSyncFailure,
      authContext: currentAuthContext(),
      storage: [...keys].map((key) => [key, window.localStorage.getItem(key)]),
    };
  } catch {
    showWarning("This browser’s tracker copy could not be verified, so the action was stopped.");
    return null;
  }
}

function sealLocalTrackerRollback(snapshot) {
  if (!snapshot) return;
  try {
    snapshot.rollbackStorage = snapshot.storage.map(([key]) => [key, window.localStorage.getItem(key)]);
  } catch {
    snapshot.rollbackStorage = [];
  }
}

function restoreLocalTrackerContext(snapshot) {
  if (!snapshot) return false;
  try {
    const rollbackValues = new Map(snapshot.rollbackStorage ?? snapshot.storage);
    snapshot.storage.forEach(([key, value]) => {
      if (window.localStorage.getItem(key) !== rollbackValues.get(key)) return;
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    });
  } catch {
    showWarning("The action failed, and this browser could not fully restore its stored tracker copy. Keep this tab open and export a backup.");
    return false;
  }

  if (authContextMatches(snapshot.authContext)) {
    state = cloneTrackerState(snapshot.state);
    localOwnerUserId = snapshot.localOwnerUserId;
    cloudHasUnsyncedChanges = snapshot.cloudHasUnsyncedChanges;
    cloudSyncFailure = snapshot.cloudSyncFailure;
  }
  return true;
}

function accountCacheHasUnsyncedChanges(userId) {
  try {
    const raw = window.localStorage.getItem(accountStorageKey(userId));
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.localOwnerUserId !== userId || Boolean(parsed.cloudUnsynced);
  } catch {
    return true;
  }
}

function removeAccountCacheIfUnchanged(userId, expectedRaw) {
  if (expectedRaw === null || expectedRaw === undefined) return true;
  try {
    const key = accountStorageKey(userId);
    if (window.localStorage.getItem(key) === expectedRaw) window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function formatGrams(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, "");
}

function doseInputError(grams) {
  if (!Number.isFinite(grams) || grams < 0.1 || grams > 100) return "Enter an amount from 0.1 to 100 g.";
  if (!isValidDoseGrams(grams)) return "Use increments of 0.1 g, such as 3, 3.5, or 5.";
  return "";
}

function doseWarning(grams) {
  const inputError = doseInputError(grams);
  if (inputError) return inputError;
  if (grams <= 5) return "";
  const maintenance = "This is above the common 3–5 g/day maintenance range. Confirm this is the amount you actually took; the tracker is not recommending it.";
  if (grams < 10) return maintenance;
  return `${maintenance} Larger single servings may be harder to tolerate. Loading protocols usually divide the daily amount into 5 g servings.`;
}

function setInlineWarning(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function confirmAboveFive(grams, purpose) {
  const warning = doseWarning(grams);
  return !warning || window.confirm(`${warning}\n\nConfirm ${formatGrams(grams)} g as ${purpose}.`);
}

function selectedDose(name, customInput) {
  const selected = document.querySelector(`input[name="${name}"]:checked`);
  const grams = selected?.value === "custom" ? Number(customInput.value) : Number(selected?.value);
  return isValidDoseGrams(grams) ? grams : null;
}

function updateDoseChoice(name, customWrap, customInput, warningElement) {
  const selected = document.querySelector(`input[name="${name}"]:checked`);
  const custom = selected?.value === "custom";
  customWrap.hidden = !custom;
  customInput.required = custom;
  customInput.disabled = !custom;
  const grams = custom ? Number(customInput.value) : Number(selected?.value);
  setInlineWarning(warningElement, doseWarning(grams));
}

function setDoseChoice(name, customWrap, customInput, warningElement, grams) {
  const standard = grams === 3 || grams === 5;
  const value = standard ? String(grams) : "custom";
  const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (radio) radio.checked = true;
  if (!standard) customInput.value = formatGrams(grams);
  updateDoseChoice(name, customWrap, customInput, warningElement);
}

function dateTimeParts(iso, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, time: `${value.hour}:${value.minute}` };
}

function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute), Number(value.second)) - instant;
}

function zonedInputToIso(date, time, timeZone) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallTime - zoneOffsetMs(wallTime, timeZone);
  instant = wallTime - zoneOffsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

function isExactWallTime(iso, date, time, timeZone) {
  const roundTrip = dateTimeParts(iso, timeZone);
  return roundTrip.date === date && roundTrip.time === time;
}

function nowInZone(timeZone) { return dateTimeParts(new Date().toISOString(), timeZone); }

function id() { return globalThis.crypto?.randomUUID?.() ?? `dose-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

function renderHistory() {
  const history = $("#historyList");
  const historyCount = $("#historyCount");
  if (historyCount) {
    const count = state.doses.length;
    historyCount.textContent = count === 0 ? "No entries" : `${count} ${count === 1 ? "entry" : "entries"}`;
  }
  history.replaceChildren();
  if (!state.doses.length) {
    history.innerHTML = '<p class="creatine-empty">No doses logged yet. Your first reported amount will appear here.</p>';
    return;
  }
  const byDay = new Map();
  for (const dose of state.doses) {
    const day = doseDay(dose.takenAt, state.profile.trackerTimezone);
    byDay.set(day, [...(byDay.get(day) || []), dose]);
  }
  [...byDay.entries()].sort(([a], [b]) => b.localeCompare(a)).forEach(([day, doses]) => {
    const group = document.createElement("section");
    group.className = "creatine-history-day";
    const total = doses.reduce((sum, dose) => sum + Number(dose.grams), 0);
    const heading = document.createElement("div");
    heading.className = "creatine-history-day__heading";
    const dateLabel = document.createElement("span");
    dateLabel.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
    const totalLabel = document.createElement("span");
    totalLabel.textContent = `${formatGrams(total)} g`;
    heading.append(dateLabel, totalLabel);
    group.append(heading);
    doses.sort((a, b) => b.takenAt.localeCompare(a.takenAt)).forEach((dose) => {
      const row = document.createElement("div");
      row.className = "creatine-history-entry";
      const local = dateTimeParts(dose.takenAt, state.profile.trackerTimezone);
      const time = document.createElement("span");
      time.textContent = `${local.time} · ${formatGrams(dose.grams)} g`;
      const actions = document.createElement("div");
      actions.className = "creatine-history-actions";
      const context = `${local.time} on ${day}`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Edit";
      edit.setAttribute("aria-label", `Edit ${formatGrams(dose.grams)} g dose at ${context}`);
      edit.addEventListener("click", () => openDoseDialog(dose));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${formatGrams(dose.grams)} g dose at ${context}`);
      remove.addEventListener("click", () => removeDose(dose.id));
      actions.append(edit, remove);
      row.append(time, actions);
      group.append(row);
    });
    history.append(group);
  });
}

function renderSchedule(model, evaluationAt) {
  const region = $("#todaySchedule");
  if (!region) return;
  const heading = $("#todayScheduleHeading");
  const context = $("#todayScheduleContext");
  const list = $("#todayScheduleList");
  const note = $("#todayScheduleNote");
  list.replaceChildren();
  if (model.mode === "maintenance") {
    region.hidden = true;
    return;
  }

  const schedule = deriveCreatineSchedule({
    doses: state.doses,
    plannedDailyGrams: model.plannedDailyGrams,
    defaultDoseGrams: state.profile.defaultDoseGrams,
    trackerTimezone: state.profile.trackerTimezone,
    evaluationAt,
  });

  if (schedule.status === "awaiting_first_dose") {
    region.hidden = true;
    return;
  }

  region.hidden = false;
  if (schedule.status === "complete") {
    heading.textContent = "Today’s planned amount is logged";
    setInlineWarning(context, "No more servings are suggested today.");
    setInlineWarning(note, "You can still add or edit factual dose records.");
    return;
  }

  if (schedule.status === "unavailable") {
    heading.textContent = "Timing suggestions paused";
    setInlineWarning(context, schedule.reasonCode === "non_5g_default"
      ? "Your quick-log amount is not 5 g, so the tracker won’t turn it into a loading schedule."
      : "Today includes an amount other than 5 g, so the tracker won’t guess how to split the rest.");
    setInlineWarning(note, "You can keep logging what you actually take.");
    return;
  }

  if (schedule.status === "day_closed") {
    heading.textContent = "No more times suggested today";
    setInlineWarning(context, "No more suggested times fit before 23:00. Continue tomorrow.");
    setInlineWarning(note, "You can still log what you actually take.");
    return;
  }

  heading.textContent = "Suggested timing today";
  setInlineWarning(context, "");
  schedule.slots.forEach((slot, index) => {
    const item = document.createElement("li");
    item.className = "creatine-schedule-slot";
    const label = document.createElement("span");
    label.className = "creatine-schedule-slot__label";
    label.textContent = index === 0 ? "Next" : "Later";
    const time = document.createElement("time");
    time.className = "creatine-schedule-slot__time";
    time.dateTime = slot.at;
    time.textContent = slot.kind === "due_now" ? "Now" : `Around ${dateTimeParts(slot.at, state.profile.trackerTimezone).time}`;
    item.append(label, time);
    list.append(item);
  });
  setInlineWarning(note, schedule.omittedSlotCount > 0
    ? `${schedule.slots.length === 1 ? "This is" : "These are"} the last suggested ${schedule.slots.length === 1 ? "time" : "times"} today. The rest do not fit before 23:00, so continue tomorrow.`
    : "");
}

function renderAccount() {
  $("#accountLoading").hidden = true;
  $("#guestAccount").hidden = Boolean(accountSession);
  $("#signedInAccount").hidden = !accountSession;
  $("#deleteAccount").hidden = !accountSession;
  $("#openEmailSignIn").disabled = !cloud;
  $("#promptEmailSignIn").disabled = !cloud;
  if (accountSession) {
    $("#accountEmail").textContent = accountSession.user?.email || "Signed in";
    $("#privacySummary").textContent = "Cloud saving is on. A browser copy remains available on this device for recovery and offline use.";
  } else {
    $("#privacySummary").textContent = "Without an account, your weight and dose history exist only in this browser and can be lost.";
  }
}

function render() {
  const ready = Boolean(state.profile);
  setupPanel.hidden = ready;
  dashboardPanel.hidden = !ready;
  const settingsPanel = $("#settingsPanel");
  if (settingsPanel) settingsPanel.hidden = !ready;
  $("#recoveryActions").hidden = ready || !recoveryMode;
  if (!ready) {
    renderedEvaluationDay = null;
    const timezone = detectedTimeZone();
    if (!$("#setupTimezone").value) $("#setupTimezone").value = timezone;
    if (!$("#trackingStartDate").value) $("#trackingStartDate").value = nowInZone(timezone).date;
    return;
  }

  const evaluationAt = new Date().toISOString();
  const model = calculateProgress({ profile: state.profile, doses: state.doses, evaluationAt });
  if (!model) {
    showWarning("This tracking timeline is too large for model v1. Check the tracking-start date in settings.");
    return;
  }
  renderedEvaluationDay = model.evaluationDay;
  const displayProgress = progressToOneDecimal(model.rawProgress);
  const maintenance = model.mode === "maintenance";
  const maintained = maintenance && Number(displayProgress) >= 100;
  $("#dashboardTitle").textContent = maintenance ? "Creatine maintenance" : "Creatine loading";
  $("#progressTitle").textContent = maintenance ? "Estimated creatine level" : "Estimated loading progress";
  const progressValue = $("#progressValue");
  progressValue.textContent = maintained ? "Maintained" : `${displayProgress}%`;
  progressValue.dataset.state = maintained ? "maintained" : "percentage";
  const bar = $("#progressBar");
  bar.style.setProperty("--progress", `${model.rawProgress}%`);
  bar.setAttribute("aria-valuenow", displayProgress);
  bar.setAttribute("aria-valuetext", maintained
    ? "Estimated creatine level maintained"
    : `${displayProgress} percent ${maintenance ? "estimated creatine level" : "estimated loading progress"}`);
  $("#todayLine").textContent = maintenance
    ? `${formatGrams(model.todayLoggedGrams)} g logged today · target ${formatGrams(model.dailyTargetGrams)} g`
    : `${formatGrams(model.todayLoggedGrams)} g logged today · target about ${formatGrams(model.plannedDailyGrams)} g`;
  const logNow = $("#logNow");
  logNow.disabled = model.todayPlanPercent >= 100;
  logNow.textContent = model.todayPlanPercent >= 100
    ? (maintenance ? "Maintenance logged today" : "Today’s target complete")
    : `Log ${formatGrams(state.profile.defaultDoseGrams)} g now`;
  $("#missedDay").hidden = model.yesterdayLoggedGrams !== 0 || model.evaluationDay <= state.profile.trackingStartDate;
  $("#settingsWeight").value = state.profile.weightKg;
  $("#settingsStartDate").value = state.profile.trackingStartDate;
  $("#settingsTimezone").value = state.profile.trackerTimezone;
  setDoseChoice("settingsDose", $("#settingsCustomDoseWrap"), $("#settingsCustomDose"), $("#settingsDoseWarning"), state.profile.defaultDoseGrams);
  renderSchedule(model, evaluationAt);
  renderHistory();
}

function refreshTimeDependentDisplay() {
  if (!state?.profile || accountTransitioning || document.visibilityState === "hidden") return;
  const evaluationAt = new Date().toISOString();
  const model = calculateProgress({ profile: state.profile, doses: state.doses, evaluationAt });
  if (!model) return;
  if (model.evaluationDay !== renderedEvaluationDay) {
    render();
    return;
  }
  renderSchedule(model, evaluationAt);
}

function scheduleTimeRefresh() {
  window.clearTimeout(timeRefreshTimer);
  const untilNextMinute = 60_000 - (Date.now() % 60_000) + 50;
  timeRefreshTimer = window.setTimeout(() => {
    refreshTimeDependentDisplay();
    scheduleTimeRefresh();
  }, untilNextMinute);
}

function showDoseError(message) {
  const error = $("#doseError");
  error.textContent = message;
  error.hidden = !message;
}

function openDoseDialog(dose = null) {
  editingDoseId = dose?.id || null;
  const defaults = dose ? dateTimeParts(dose.takenAt, state.profile.trackerTimezone) : nowInZone(state.profile.trackerTimezone);
  const grams = dose?.grams ?? state.profile.defaultDoseGrams;
  $("#doseDialogTitle").textContent = dose ? `Edit ${formatGrams(grams)} g dose` : "Add a dose";
  $("#saveDose").textContent = dose ? "Save changes" : "Add dose";
  $("#doseAmount").value = formatGrams(grams);
  $("#doseDate").value = defaults.date;
  $("#doseTime").value = defaults.time;
  setInlineWarning($("#doseAmountWarning"), doseWarning(grams));
  showDoseError("");
  doseDialog.showModal();
}

function moveTrackingStartIfNeeded(iso) {
  const eventDay = doseDay(iso, state.profile.trackerTimezone);
  if (eventDay < state.profile.trackingStartDate) {
    state.profile.trackingStartDate = eventDay;
    return eventDay;
  }
  return null;
}

function confirmNearDuplicate(iso, grams, excludedDoseId = null) {
  const target = new Date(iso).getTime();
  const isNearDuplicate = state.doses.some((dose) => dose.id !== excludedDoseId && Math.abs(target - new Date(dose.takenAt).getTime()) < 10 * 60 * 1000);
  return !isNearDuplicate || window.confirm(`A dose was logged within the last 10 minutes. Log another real ${formatGrams(grams)} g dose?`);
}

function savedMessage(saved, persisted, tabOnly) {
  return saved ? persisted : tabOnly;
}

function setCloudStatus(message) {
  $("#cloudStatus").textContent = message;
}

async function cloudMutation(action, { persistState = true, expectedContext = currentAuthContext() } = {}) {
  if (!cloud || !accountSession) return true;
  if (!expectedContext?.userId || !authContextMatches(expectedContext)) return false;
  const scheduledUserId = expectedContext.userId;
  pendingCloudMutations += 1;
  setCloudStatus("Saving…");
  try {
    await cloudMutationQueue.run(async () => {
      if (!authContextMatches(expectedContext)) throw new Error("The signed-in account changed before this update could sync.");
      await action(scheduledUserId);
      if (!authContextMatches(expectedContext)) throw new Error("The signed-in account changed while this update was syncing.");
    });
    return true;
  } catch (error) {
    if (authContextMatches(expectedContext)) {
      cloudHasUnsyncedChanges = true;
      cloudSyncFailure = true;
      if (persistState) writeState(state);
      setCloudStatus("Not synced");
      showWarning(error?.message || "This change is saved in this browser but not in the cloud.");
    }
    return false;
  } finally {
    pendingCloudMutations -= 1;
    if (authContextMatches(expectedContext) && pendingCloudMutations > 0 && !cloudSyncFailure) {
      setCloudStatus("Saving…");
    } else if (authContextMatches(expectedContext) && pendingCloudMutations === 0 && !cloudSyncFailure) {
      cloudHasUnsyncedChanges = false;
      if (persistState) writeState(state);
      setCloudStatus("Saved");
    }
  }
}

function addDoseAt(iso, entryMethod, grams) {
  const priorStart = moveTrackingStartIfNeeded(iso);
  const addedDose = { id: id(), takenAt: iso, timezone: state.profile.trackerTimezone, grams, createdAt: new Date().toISOString(), entryMethod };
  const profileSnapshot = priorStart ? { ...state.profile } : null;
  const doseSnapshot = { ...addedDose };
  state.doses.push(addedDose);
  const saved = saveState();
  render();
  void cloudMutation(async (expectedUserId) => {
    if (profileSnapshot) await cloud.upsertProfile(profileSnapshot, expectedUserId);
    await cloud.upsertDose(doseSnapshot, expectedUserId);
  });
  const amount = formatGrams(grams);
  const persisted = priorStart ? `${amount} g dose ${entryMethod === "now" ? "logged" : "added"}. Tracking start moved to ${priorStart} to include this dose.` : `${amount} g dose ${entryMethod === "now" ? "logged" : "added"}.`;
  const tabOnly = `${persisted} This change is only in this tab and was not saved in this browser.`;
  if (entryMethod === "now") offerUndo({ type: "added", dose: addedDose }, savedMessage(saved, persisted, tabOnly));
  else announce(savedMessage(saved, persisted, tabOnly));
}

function offerUndo(payload, message) {
  undoPayload = payload;
  $("#undoText").textContent = message;
  $("#undoToast").hidden = false;
  announce(`${message} Undo is available.`);
  window.clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => { $("#undoToast").hidden = true; undoPayload = null; }, 8000);
}

function removeDose(doseId) {
  const index = state.doses.findIndex((dose) => dose.id === doseId);
  if (index < 0) return;
  const removed = state.doses[index];
  state.doses.splice(index, 1);
  const saved = saveState();
  render();
  void cloudMutation((expectedUserId) => cloud.deleteDose(removed.id, expectedUserId));
  offerUndo({ type: "removed", dose: removed }, savedMessage(saved, "Dose removed.", "Dose removed in this tab only; the change was not saved in this browser."));
}

function normalizedCloudState(candidate) {
  if (!candidate?.profile && (candidate?.doses?.length || 0) > 0) return null;
  return migrateTrackerState({
    schemaVersion: candidate?.schemaVersion ?? TRACKER_SCHEMA_VERSION,
    modelVersion: candidate?.modelVersion ?? MODEL_VERSION,
    profile: candidate?.profile || null,
    doses: candidate?.doses || [],
  });
}

async function reconcileCloud(expectedContext = currentAuthContext()) {
  if (!cloud || !expectedContext?.userId || !authContextMatches(expectedContext)) return;
  setTrackerTransitioning(true);
  try {
    const hasAccountLock = await acquireAccountTabLock(expectedContext);
    if (!authContextMatches(expectedContext)) return;
    if (!hasAccountLock) {
      accountTabBlocked = true;
      quarantineAccountState();
      setTrackerTransitioning(true);
      renderAccount();
      render();
      showWarning(navigator.locks?.request
        ? "This account is already open in another tab. Close that tab, then reload this page to protect unsynced tracker data."
        : "This browser cannot safely coordinate account data across tabs. Sign out to use browser-only tracking here, or open the account in a supported current browser.");
      return;
    }
    accountTabBlocked = false;
    await cloudMutationQueue.idle();
    if (!authContextMatches(expectedContext)) return;
    const currentUserId = expectedContext.userId;

    if (localOwnerUserId && localOwnerUserId !== currentUserId) quarantineAccountState();
    if (!localOwnerUserId && !hasTrackerData(state)) {
      if (!activateAccountCache(currentUserId)) {
        state = blankState();
        localOwnerUserId = currentUserId;
        cloudHasUnsyncedChanges = false;
        cloudSyncFailure = false;
      }
    }

    const localStateIsGuest = !localOwnerUserId;
    const startingRevision = localRevision;
    const guestImportWasRequested = await consumeGuestImportIntent(accountSession.user?.email, state);
    if (!authContextMatches(expectedContext) || localRevision !== startingRevision) return;
    setCloudStatus("Checking cloud data…");
    const remote = normalizedCloudState(await cloud.loadTracker(currentUserId));
    if (!authContextMatches(expectedContext) || localRevision !== startingRevision) return;
    if (!remote) throw new Error("Cloud tracker data is incomplete. Nothing in this browser was overwritten.");
    const plan = planGuestMigration(state, remote);

    if (plan.action === "import_local") {
      if (localOwnerUserId === currentUserId && !cloudHasUnsyncedChanges) {
        state = remote;
        saveState({ cloudSynced: true });
        render();
        setCloudStatus("Ready");
        announce("The account’s empty tracker was used; a previously synced browser cache was not restored.");
        return;
      }
      const canImportAutomatically = (localOwnerUserId === currentUserId && cloudHasUnsyncedChanges) || guestImportWasRequested;
      if (!canImportAutomatically) {
        pendingCloudState = { ...expectedContext, mode: "guest-import", state: remote, sourceWasGuest: localStateIsGuest };
        render();
        showCloudChoice("guest-import");
        setCloudStatus("Needs your choice");
        return;
      }
      const localToImport = cloneTrackerState(state);
      await cloud.importGuestState(localToImport, currentUserId);
      if (!authContextMatches(expectedContext) || localRevision !== startingRevision) return;
      const verified = normalizedCloudState(await cloud.loadTracker(currentUserId));
      if (!authContextMatches(expectedContext) || localRevision !== startingRevision) return;
      if (!verified || trackerContentFingerprint(verified) !== trackerContentFingerprint(localToImport)) throw new Error("Cloud import could not be verified. The browser copy is unchanged.");
      state = localToImport;
      localOwnerUserId = currentUserId;
      saveState({ cloudSynced: true });
      if (localStateIsGuest) removeGuestStoredState();
      clearPendingCloudChoice();
      render();
      setCloudStatus("Saved");
      return;
    }
    if (plan.action === "use_cloud") {
      state = remote;
      localOwnerUserId = currentUserId;
      saveState({ cloudSynced: true });
      if (localStateIsGuest) removeGuestStoredState();
      clearPendingCloudChoice();
      render();
      setCloudStatus("Saved");
      return;
    }
    if (plan.action === "conflict") {
      pendingCloudState = { ...expectedContext, mode: "conflict", state: remote, browserState: cloneTrackerState(state), sourceWasGuest: localStateIsGuest };
      render();
      showCloudChoice("conflict");
      setCloudStatus("Needs your choice");
      return;
    }
    localOwnerUserId = currentUserId;
    saveState({ cloudSynced: true });
    if (localStateIsGuest) removeGuestStoredState();
    clearPendingCloudChoice();
    render();
    setCloudStatus(plan.action === "empty" ? "Ready" : "Saved");
  } catch (error) {
    if (!authContextMatches(expectedContext)) return;
    setCloudStatus("Not synced");
    render();
    showWarning(error?.message || "Cloud data could not be checked. Your browser copy is unchanged.");
  } finally {
    if (authContextMatches(expectedContext) && !accountTabBlocked) setTrackerTransitioning(false);
  }
}

function hasTrackerData(candidate) {
  return Boolean(candidate?.profile) || Boolean(candidate?.doses?.length);
}

function storeGuestImportIntent(email, payloadSha256) {
  try {
    window.localStorage.setItem(GUEST_IMPORT_INTENT_KEY, JSON.stringify({
      email: String(email).trim().toLowerCase(),
      payloadSha256,
      createdAt: Date.now(),
    }));
    scheduleGuestImportIntentCleanup(GUEST_IMPORT_INTENT_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

function scheduleGuestImportIntentCleanup(delayMs) {
  window.clearTimeout(guestImportIntentCleanupTimer);
  guestImportIntentCleanupTimer = window.setTimeout(cleanupExpiredGuestImportIntent, Math.max(0, delayMs) + 100);
}

function cleanupExpiredGuestImportIntent() {
  try {
    const raw = window.localStorage.getItem(GUEST_IMPORT_INTENT_KEY);
    if (!raw) {
      window.clearTimeout(guestImportIntentCleanupTimer);
      guestImportIntentCleanupTimer = null;
      return;
    }
    const intent = JSON.parse(raw);
    const age = Date.now() - intent?.createdAt;
    const fresh = Number.isFinite(intent?.createdAt) && age >= 0 && age < GUEST_IMPORT_INTENT_TTL_MS;
    const validHash = typeof intent?.payloadSha256 === "string" && /^[0-9a-f]{64}$/.test(intent.payloadSha256);
    if (!fresh || typeof intent?.email !== "string" || !validHash) {
      clearGuestImportIntent();
      return;
    }
    scheduleGuestImportIntentCleanup(GUEST_IMPORT_INTENT_TTL_MS - age);
  } catch {
    clearGuestImportIntent();
  }
}

async function consumeGuestImportIntent(email, candidateState) {
  try {
    const raw = window.localStorage.getItem(GUEST_IMPORT_INTENT_KEY);
    if (!raw) return false;
    const intent = JSON.parse(raw);
    const expectedEmail = String(email || "").trim().toLowerCase();
    const age = Date.now() - intent?.createdAt;
    const fresh = Number.isFinite(intent?.createdAt) && age >= 0 && age < GUEST_IMPORT_INTENT_TTL_MS;
    const matches = expectedEmail && intent?.email === expectedEmail;
    let payloadMatches = false;
    if (fresh && matches && hasTrackerData(candidateState)) {
      const prepared = await prepareGuestImport(candidateState);
      payloadMatches = prepared.payloadSha256 === intent?.payloadSha256;
    }
    clearGuestImportIntent();
    return Boolean(fresh && matches && payloadMatches);
  } catch {
    clearGuestImportIntent();
    return false;
  }
}

function clearGuestImportIntent() {
  window.clearTimeout(guestImportIntentCleanupTimer);
  guestImportIntentCleanupTimer = null;
  try { window.localStorage.removeItem(GUEST_IMPORT_INTENT_KEY); } catch { /* no-op */ }
}

function showCloudChoice(mode) {
  cloudChoiceInProgress = false;
  $("#useAccountData").disabled = false;
  $("#keepBrowserData").disabled = false;
  $("#downloadBrowserBackup").disabled = false;
  cloudConflictDialog.dataset.mode = mode;
  const guestImport = mode === "guest-import";
  $("#downloadBrowserBackup").hidden = guestImport;
  $("#cloudConflictTitle").textContent = guestImport ? "Save this device’s tracker to your account?" : "Two tracker histories found";
  $("#cloudConflictCopy").textContent = guestImport
    ? "This account is empty. Save this device’s tracker to your account, or sign out and keep it only on this device."
    : "Your account and this device contain different entries. Using the account history replaces the tracker currently stored on this device.";
  $("#useAccountData").textContent = guestImport ? "Save to account" : "Use account history";
  $("#keepBrowserData").textContent = guestImport ? "Keep on this device and sign out" : "Keep device history and sign out";
  if (!cloudConflictDialog.open) cloudConflictDialog.showModal();
  $("#keepBrowserData").focus();
}

function downloadState(candidate, filename = "creatine-loading-backup.json") {
  const blob = new Blob([JSON.stringify(candidate, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function openEmailSignIn() {
  if (!cloud) {
    showWarning("Account saving is temporarily unavailable. Your browser data is unchanged.");
    return;
  }
  if (savePromptDialog.open) savePromptDialog.close();
  $("#emailSignInStatus").textContent = "";
  if (!emailSignInDialog.open) emailSignInDialog.showModal();
  $("#signInEmail").focus();
}

async function startEmailSignIn(event) {
  event.preventDefault();
  if (!cloud) {
    showWarning("Account saving is temporarily unavailable. Your browser data is unchanged.");
    return;
  }
  const emailInput = $("#signInEmail");
  if (!emailInput.reportValidity()) return;
  const email = emailInput.value.trim().toLowerCase();
  if (!saveState({ localMutation: false })) {
    showWarning("The sign-in link was not sent because this tab’s tracker could not be saved first.");
    return;
  }
  const needsGuestImport = !localOwnerUserId && hasTrackerData(state);
  if (needsGuestImport) {
    try {
      const prepared = await prepareGuestImport(state);
      if (!storeGuestImportIntent(email, prepared.payloadSha256)) throw new Error("intent_not_saved");
    } catch {
      showWarning("The sign-in link was not sent because this browser could not safely bind it to the current guest tracker.");
      return;
    }
  }
  const submit = $("#sendSignInLink");
  submit.disabled = true;
  $("#emailSignInStatus").textContent = "Sending a secure link…";
  try {
    await cloud.signInWithEmail(email);
    $("#emailSignInStatus").textContent = `Check ${email} and open the sign-in link on this device.`;
    submit.textContent = "Send another link";
    announce("Secure sign-in link sent. Check your email.");
  } catch (error) {
    if (needsGuestImport) clearGuestImportIntent();
    $("#emailSignInStatus").textContent = "";
    showWarning(error?.message || "The secure sign-in link could not be sent.");
  } finally {
    submit.disabled = false;
  }
}

async function initializeAccount() {
  if (!cloud) {
    renderAccount();
    render();
    return;
  }
  try {
    const params = new URL(window.location.href).searchParams;
    const authError = params.get("error_description");
    if (authError) showWarning(`Email sign-in did not finish: ${authError}`);
    let activeUserId = null;
    let authEventRevision = 0;
    cloud.subscribeToSession((nextSession) => {
      authEventRevision += 1;
      const nextUserId = nextSession?.user?.id || null;
      if (nextUserId === activeUserId) {
        accountSession = nextSession;
        renderAccount();
        if (!nextSession) {
          setTrackerTransitioning(false);
          render();
        }
        return;
      }
      const previousUserId = activeUserId;
      const previousContext = { userId: previousUserId, epoch: authEpoch };
      const matchingSignOut = pendingSignOutAttempt
        && pendingSignOutAttempt.context.userId === previousContext.userId
        && pendingSignOutAttempt.context.epoch === previousContext.epoch
        ? pendingSignOutAttempt
        : null;
      pendingSignOutAttempt = null;
      activeUserId = nextUserId;
      releaseAccountTabLock();
      authEpoch += 1;
      accountSession = nextSession;
      clearPendingCloudChoice();
      if (doseDialog.open) doseDialog.close();
      if (deleteDialog.open) deleteDialog.close();
      if (deleteAccountDialog.open) deleteAccountDialog.close();
      $("#confirmDeleteAccount").disabled = false;
      if (emailSignInDialog.open) emailSignInDialog.close();
      if (savePromptDialog.open) savePromptDialog.close();
      if (nextUserId) {
        setTrackerTransitioning(true);
        if (previousUserId || localOwnerUserId) quarantineAccountState();
        renderAccount();
        render();
        void reconcileCloud(currentAuthContext());
      } else if (previousUserId) {
        setTrackerTransitioning(false);
        if (!matchingSignOut?.keepGuest) {
          quarantineAccountState();
          if (!matchingSignOut) showWarning("The account session ended. Sign in again to load its cloud tracker; its browser cache was preserved without being shown in guest mode.");
        }
        renderAccount();
        render();
      }
    });
    const revisionBeforeInitialSession = authEventRevision;
    let initialSession;
    try {
      initialSession = await cloud.completeAuthCallback();
    } catch (error) {
      if (authEventRevision !== revisionBeforeInitialSession) return;
      throw error;
    }
    if (authEventRevision !== revisionBeforeInitialSession) return;
    accountSession = initialSession;
    activeUserId = initialSession?.user?.id || null;
    authEpoch += 1;
    renderAccount();
    if (accountSession) {
      await reconcileCloud(currentAuthContext());
    } else {
      setTrackerTransitioning(false);
      render();
    }
  } catch (error) {
    authEpoch += 1;
    accountSession = null;
    if (localOwnerUserId) quarantineAccountState();
    setTrackerTransitioning(false);
    renderAccount();
    render();
    showWarning(error?.message || "Account saving could not initialize. Browser-only tracking is still available.");
  }
}

function maybeOfferSavePrompt() {
  if (accountSession || !cloud) return;
  try {
    if (window.sessionStorage.getItem(SAVE_PROMPT_DISMISSED_KEY)) return;
  } catch {
    // The prompt can still be shown when session storage is unavailable.
  }
  window.setTimeout(() => { if (!savePromptDialog.open) savePromptDialog.showModal(); }, 250);
}

document.querySelectorAll('input[name="defaultDose"]').forEach((input) => input.addEventListener("change", () => updateDoseChoice("defaultDose", $("#setupCustomDoseWrap"), $("#setupCustomDose"), $("#setupDoseWarning"))));
$("#setupCustomDose").addEventListener("input", () => updateDoseChoice("defaultDose", $("#setupCustomDoseWrap"), $("#setupCustomDose"), $("#setupDoseWarning")));
document.querySelectorAll('input[name="settingsDose"]').forEach((input) => input.addEventListener("change", () => updateDoseChoice("settingsDose", $("#settingsCustomDoseWrap"), $("#settingsCustomDose"), $("#settingsDoseWarning"))));
$("#settingsCustomDose").addEventListener("input", () => updateDoseChoice("settingsDose", $("#settingsCustomDoseWrap"), $("#settingsCustomDose"), $("#settingsDoseWarning")));

$("#setupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const input = Number(form.get("weight"));
  const weightKg = form.get("weightUnit") === "lb" ? input * 0.45359237 : input;
  const trackingStartDate = String(form.get("trackingStartDate"));
  const trackerTimezone = detectedTimeZone();
  const defaultDoseGrams = selectedDose("defaultDose", $("#setupCustomDose"));
  if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 300 || !isSupportedTrackingDate(trackingStartDate, trackerTimezone)) {
    showWarning("Enter a weight from 30 to 300 kg and a real tracking-start date that is not in the future for your tracker timezone.");
    return;
  }
  if (!defaultDoseGrams) {
    const message = doseInputError(Number($("#setupCustomDose").value)) || "Choose 3 g, 5 g, or enter a custom quick-log amount from 0.1 to 100 g.";
    setInlineWarning($("#setupDoseWarning"), message);
    showWarning(message);
    return;
  }
  if (!confirmAboveFive(defaultDoseGrams, "your usual quick-log amount")) return;
  state = { ...blankState(), profile: { weightKg: Math.round(weightKg * 10) / 10, trackingStartDate, trackerTimezone, defaultDoseGrams } };
  recoveryMode = false;
  const saved = saveState();
  render();
  if (saved) clearWarning();
  const profileSnapshot = { ...state.profile };
  void cloudMutation((expectedUserId) => cloud.upsertProfile(profileSnapshot, expectedUserId));
  announce(savedMessage(saved, `Tracking started. Log a real ${formatGrams(defaultDoseGrams)} g dose when you take it.`, "Tracking started in this tab only; it could not be saved in this browser."));
  maybeOfferSavePrompt();
});

$("#logNow").addEventListener("click", () => {
  const current = new Date();
  const grams = state.profile.defaultDoseGrams || DEFAULT_DOSE_GRAMS;
  if (!confirmNearDuplicate(current.toISOString(), grams)) return;
  addDoseAt(current.toISOString(), "now", grams);
});
$("#addEarlier").addEventListener("click", () => openDoseDialog());
$("#closeDoseDialog").addEventListener("click", () => doseDialog.close());
document.querySelectorAll("[data-dose-grams]").forEach((button) => button.addEventListener("click", () => {
  $("#doseAmount").value = button.dataset.doseGrams;
  setInlineWarning($("#doseAmountWarning"), doseWarning(Number(button.dataset.doseGrams)));
}));
$("#doseAmount").addEventListener("input", () => setInlineWarning($("#doseAmountWarning"), doseWarning(Number($("#doseAmount").value))));
function releaseNativeDatePickerFocus(event) {
  const input = event.currentTarget;
  window.requestAnimationFrame(() => {
    if (document.activeElement === input) input.blur();
  });
}
$("#doseDate").addEventListener("input", releaseNativeDatePickerFocus);
$("#doseDate").addEventListener("change", releaseNativeDatePickerFocus);
document.querySelectorAll("[data-dose-shortcut]").forEach((button) => button.addEventListener("click", () => {
  const date = nowInZone(state.profile.trackerTimezone).date;
  $("#doseDate").value = button.dataset.doseShortcut === "yesterday" ? addCalendarDays(date, -1) : date;
}));
$("#doseForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const date = $("#doseDate").value;
  const time = $("#doseTime").value;
  const grams = Number($("#doseAmount").value);
  if (!isValidDoseGrams(grams)) { showDoseError(doseInputError(grams)); return; }
  if (!date || !time) { showDoseError("Enter both a date and time."); return; }
  const iso = zonedInputToIso(date, time, state.profile.trackerTimezone);
  if (!isExactWallTime(iso, date, time, state.profile.trackerTimezone)) { showDoseError("That local time does not exist in your tracker timezone. Choose another time."); return; }
  if (new Date(iso).getTime() > Date.now()) { showDoseError("Choose a time that has already happened."); return; }
  if (!confirmAboveFive(grams, "the amount actually taken")) return;
  if (!confirmNearDuplicate(iso, grams, editingDoseId)) return;
  if (editingDoseId) {
    const dose = state.doses.find((item) => item.id === editingDoseId);
    dose.takenAt = iso;
    dose.timezone = state.profile.trackerTimezone;
    dose.grams = grams;
    const priorStart = moveTrackingStartIfNeeded(iso);
    const profileSnapshot = priorStart ? { ...state.profile } : null;
    const doseSnapshot = { ...dose };
    const saved = saveState();
    render();
    void cloudMutation(async (expectedUserId) => {
      if (profileSnapshot) await cloud.upsertProfile(profileSnapshot, expectedUserId);
      await cloud.upsertDose(doseSnapshot, expectedUserId);
    });
    announce(savedMessage(saved, priorStart ? `Dose updated. Tracking start moved to ${priorStart} to include it.` : "Dose updated.", "Dose updated in this tab only; the change was not saved in this browser."));
  } else {
    addDoseAt(iso, "backfill", grams);
  }
  doseDialog.close();
});

$("#undoRemoval").addEventListener("click", () => {
  if (!undoPayload) return;
  const payload = { type: undoPayload.type, dose: { ...undoPayload.dose } };
  const restored = payload.type === "removed";
  if (restored) state.doses.push(payload.dose);
  else state.doses = state.doses.filter((dose) => dose.id !== payload.dose.id);
  const saved = saveState();
  render();
  void cloudMutation((expectedUserId) => restored ? cloud.upsertDose(payload.dose, expectedUserId) : cloud.deleteDose(payload.dose.id, expectedUserId));
  announce(savedMessage(saved, restored ? "Dose restored." : "Logged dose undone.", `${restored ? "Dose restored" : "Logged dose undone"} in this tab only; the change was not saved in this browser.`));
  $("#undoToast").hidden = true;
  undoPayload = null;
  window.clearTimeout(undoTimer);
});

$("#settingsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const weightKg = Number($("#settingsWeight").value);
  const trackingStartDate = $("#settingsStartDate").value;
  const trackerTimezone = $("#settingsTimezone").value.trim();
  const defaultDoseGrams = selectedDose("settingsDose", $("#settingsCustomDose"));
  if (!defaultDoseGrams) {
    const message = doseInputError(Number($("#settingsCustomDose").value)) || "Choose 3 g, 5 g, or enter a custom quick-log amount from 0.1 to 100 g.";
    setInlineWarning($("#settingsDoseWarning"), message);
    announce(message);
    return;
  }
  if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 300 || !isSupportedTrackingDate(trackingStartDate, trackerTimezone) || !isValidTimeZone(trackerTimezone)) {
    announce("Check the weight, quick-log amount, a real start date in the last 3,660 tracker-calendar days, and IANA timezone before saving settings.");
    return;
  }
  if (!confirmAboveFive(defaultDoseGrams, "your usual quick-log amount")) return;
  state.profile = { ...state.profile, weightKg, trackingStartDate, trackerTimezone, defaultDoseGrams };
  const profileSnapshot = { ...state.profile };
  const saved = saveState();
  render();
  void cloudMutation((expectedUserId) => cloud.upsertProfile(profileSnapshot, expectedUserId));
  announce(savedMessage(saved, "Settings saved. Progress was recalculated from the full dose history.", "Settings changed in this tab only; they were not saved in this browser."));
});

$("#exportData").addEventListener("click", () => { downloadState(state); announce("Backup exported."); });
$("#importTrigger").addEventListener("click", () => $("#importData").click());
async function importBackup(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  const operationContext = currentAuthContext();
  try {
    const imported = migrateTrackerState(JSON.parse(await file.text()));
    if (!imported) throw new Error("invalid");
    if (!authContextMatches(operationContext)) {
      showWarning("Backup import was stopped because the signed-in account changed while the file was being read.");
      return;
    }
    state = imported;
    recoveryMode = false;
    const saved = saveState();
    render();
    if (saved) clearWarning();
    announce(savedMessage(saved, "Backup imported and recalculated.", "Backup imported in this tab only; it was not saved in this browser."));
    if (accountSession) await reconcileCloud(operationContext);
  } catch {
    showWarning("That backup is not a valid creatine tracker file. Your current data was not changed.");
  } finally {
    input.value = "";
  }
}
$("#importData").addEventListener("change", importBackup);
$("#recoveryImportTrigger").addEventListener("click", () => $("#recoveryImportData").click());
$("#recoveryImportData").addEventListener("change", importBackup);

$("#deleteData").addEventListener("click", () => {
  $("#deleteDialogCopy").textContent = accountSession ? "This permanently removes your tracker profile and dose history from this browser and your account. Your login will remain." : "This permanently removes your locally stored profile and dose history from this browser.";
  deleteDialog.showModal();
});
$("#recoveryDelete").addEventListener("click", () => deleteDialog.showModal());
$("#confirmDelete").addEventListener("click", async (event) => {
  event.preventDefault();
  const operationContext = currentAuthContext();
  await cloudMutationQueue.idle();
  if (!authContextMatches(operationContext)) {
    showWarning("Tracker deletion was stopped because the signed-in account changed.");
    return;
  }
  const localSnapshot = captureLocalTrackerContext();
  if (!localSnapshot) return;
  if (!removeStoredState()) {
    sealLocalTrackerRollback(localSnapshot);
    restoreLocalTrackerContext(localSnapshot);
    return;
  }
  if (operationContext.userId && !removeGuestStoredState()) {
    sealLocalTrackerRollback(localSnapshot);
    restoreLocalTrackerContext(localSnapshot);
    showWarning("Tracker deletion was stopped because every browser copy could not be cleared safely.");
    return;
  }
  if (operationContext.userId) {
    try {
      window.localStorage.removeItem(legacyAccountBackupKey(operationContext.userId));
    } catch {
      sealLocalTrackerRollback(localSnapshot);
      restoreLocalTrackerContext(localSnapshot);
      showWarning("Tracker deletion was stopped because an older browser backup could not be cleared safely.");
      return;
    }
  }
  sealLocalTrackerRollback(localSnapshot);
  if (operationContext.userId) {
    try {
      await cloudMutationQueue.run(() => cloud.deleteTrackerData(operationContext.userId));
    } catch (error) {
      restoreLocalTrackerContext(localSnapshot);
      if (authContextMatches(operationContext)) {
        render();
        showWarning(error?.message || "Cloud tracker data could not be deleted. Nothing was deleted, and the browser copy was restored.");
      }
      return;
    }
  }
  if (!authContextMatches(operationContext)) return;
  state = blankState();
  resetSetupInputs();
  recoveryMode = false;
  cloudHasUnsyncedChanges = false;
  cloudSyncFailure = false;
  pendingCloudState = null;
  deleteDialog.close();
  render();
  clearWarning();
  announce(operationContext.userId ? "Tracker data was deleted from this browser and your account." : "All tracker data was deleted from this browser.");
});

$("#openEmailSignIn").addEventListener("click", openEmailSignIn);
$("#promptEmailSignIn").addEventListener("click", openEmailSignIn);
$("#closeEmailSignIn").addEventListener("click", () => emailSignInDialog.close());
$("#emailSignInForm").addEventListener("submit", startEmailSignIn);
savePromptDialog.addEventListener("close", () => {
  try { window.sessionStorage.setItem(SAVE_PROMPT_DISMISSED_KEY, "1"); } catch { /* no-op */ }
});
cloudConflictDialog.addEventListener("cancel", (event) => event.preventDefault());
$("#downloadBrowserBackup").addEventListener("click", () => {
  if (cloudChoiceInProgress || pendingCloudState?.mode !== "conflict" || !authContextMatches(pendingCloudState)) return;
  try {
    downloadState(pendingCloudState.browserState || state, `creatine-browser-backup-${new Date().toISOString().slice(0, 10)}.json`);
    announce("Device tracker backup downloaded.");
  } catch {
    showWarning("The device tracker backup could not be downloaded. Nothing was changed.");
  }
});
$("#signOut").addEventListener("click", async () => {
  const operationContext = currentAuthContext();
  if (!operationContext.userId) return;
  try {
    await cloudMutationQueue.idle();
    if (!authContextMatches(operationContext)) {
      showWarning("Sign-out was stopped because the signed-in account changed.");
      return;
    }
    if (!accountTabBlocked && (cloudHasUnsyncedChanges || accountCacheHasUnsyncedChanges(operationContext.userId))) {
      showWarning("Sign-out was stopped because at least one browser change is not synced. Keep this page open and export a backup before trying again.");
      return;
    }
    pendingSignOutAttempt = { context: operationContext, keepGuest: false };
    const result = await cloud.signOut(operationContext.userId);
    if (accountSession?.user?.id && accountSession.user.id !== operationContext.userId) {
      if (pendingSignOutAttempt?.context === operationContext) pendingSignOutAttempt = null;
      return;
    }
    releaseAccountTabLock(operationContext);
    if (authContextMatches(operationContext)) {
      accountSession = null;
      quarantineAccountState();
      setTrackerTransitioning(false);
      render();
      renderAccount();
    }
    window.setTimeout(() => {
      if (pendingSignOutAttempt?.context === operationContext && !accountSession) pendingSignOutAttempt = null;
    }, 1000);
    announce("Signed out. This account’s browser cache is preserved but hidden; sign in again to load it.");
    if (result?.localSignOutError || result?.localSignOutSkipped) showWarning("You were signed out on the server, but this browser could not clear the exact expired local session. Reload this page to finish cleanup.");
  } catch (error) {
    if (pendingSignOutAttempt?.context === operationContext) pendingSignOutAttempt = null;
    if (authContextMatches(operationContext)) showWarning(error?.message || "Sign-out failed.");
  }
});

$("#useAccountData").addEventListener("click", async () => {
  if (cloudChoiceInProgress) return;
  if (!pendingCloudState || !authContextMatches(pendingCloudState)) {
    clearPendingCloudChoice();
    showWarning("That cloud choice expired because the signed-in account changed.");
    return;
  }
  const choice = claimPendingCloudChoice();
  if (!choice) return;
  const startingRevision = localRevision;
  if (choice.mode === "guest-import") {
    const localToImport = cloneTrackerState(state);
    try {
      const imported = await cloudMutation(
        (expectedUserId) => cloud.importGuestState(localToImport, expectedUserId),
        { persistState: false, expectedContext: choice },
      );
      if (!imported) {
        releasePendingCloudChoice(choice);
        return;
      }
      if (!authContextMatches(choice)) return;
      if (localRevision !== startingRevision) {
        releasePendingCloudChoice(choice);
        showWarning("The browser tracker changed before the cloud import finished. Review the choice again.");
        return;
      }
      const verified = normalizedCloudState(await cloud.loadTracker(choice.userId));
      if (!authContextMatches(choice)) return;
      if (localRevision !== startingRevision) {
        releasePendingCloudChoice(choice);
        showWarning("The browser tracker changed before the cloud import was verified. Review the choice again.");
        return;
      }
      if (!verified || trackerContentFingerprint(verified) !== trackerContentFingerprint(localToImport)) {
        releasePendingCloudChoice(choice);
        setCloudStatus("Not synced");
        showWarning("Cloud import could not be verified. The browser copy is unchanged.");
        return;
      }
    } catch (error) {
      releasePendingCloudChoice(choice);
      if (authContextMatches(choice)) showWarning(error?.message || "Cloud import could not be verified. The browser copy is unchanged.");
      return;
    }
    state = localToImport;
    localOwnerUserId = choice.userId;
    saveState({ cloudSynced: true });
    if (choice.sourceWasGuest) removeGuestStoredState();
    clearPendingCloudChoice();
    render();
    setCloudStatus("Saved");
    announce("This browser tracker is now saved to your account.");
    return;
  }
  const localSnapshot = captureLocalTrackerContext();
  if (!localSnapshot) {
    releasePendingCloudChoice(choice);
    return;
  }
  try {
    state = cloneTrackerState(choice.state);
    localOwnerUserId = choice.userId;
    if (!saveState({ cloudSynced: true })) throw new Error("The account history could not be saved safely in this browser.");
    if (choice.sourceWasGuest && !removeGuestStoredState()) throw new Error("The previous device history could not be cleared safely.");
    clearPendingCloudChoice();
    render();
    setCloudStatus("Saved");
    announce("Account history is now in use on this device.");
  } catch (error) {
    sealLocalTrackerRollback(localSnapshot);
    restoreLocalTrackerContext(localSnapshot);
    releasePendingCloudChoice(choice);
    render();
    renderAccount();
    setCloudStatus("Needs your choice");
    showWarning(error?.message || "The account history was not loaded. The device history is unchanged.");
  }
});
$("#keepBrowserData").addEventListener("click", async () => {
  if (cloudChoiceInProgress) return;
  if (!pendingCloudState?.userId || !authContextMatches(pendingCloudState)) {
    clearPendingCloudChoice();
    showWarning("That cloud choice expired because the signed-in account changed.");
    return;
  }
  const choice = claimPendingCloudChoice();
  if (!choice) return;
  await cloudMutationQueue.idle();
  if (!authContextMatches(choice)) return;
  const localSnapshot = captureLocalTrackerContext();
  if (!localSnapshot) {
    releasePendingCloudChoice(choice);
    return;
  }
  const accountKey = accountStorageKey(choice.userId);
  const capturedAccountCache = localSnapshot.storage.find(([key]) => key === accountKey)?.[1] ?? null;
  localOwnerUserId = null;
  cloudHasUnsyncedChanges = false;
  cloudSyncFailure = false;
  if (!writeState(state)) {
    sealLocalTrackerRollback(localSnapshot);
    restoreLocalTrackerContext(localSnapshot);
    releasePendingCloudChoice(choice);
    showWarning("Sign-out was stopped because the browser tracker could not be saved safely.");
    return;
  }
  sealLocalTrackerRollback(localSnapshot);
  pendingSignOutAttempt = { context: choice, keepGuest: true };
  let signOutResult;
  try {
    signOutResult = await cloud.signOut(choice.userId);
  } catch (error) {
    if (pendingSignOutAttempt?.context === choice) pendingSignOutAttempt = null;
    restoreLocalTrackerContext(localSnapshot);
    if (authContextMatches(choice)) {
      releasePendingCloudChoice(choice);
      render();
      renderAccount();
      showWarning(error?.message || "Sign-out failed. The prior browser and account copies were restored.");
    }
    return;
  }
  if (accountSession?.user?.id && accountSession.user.id !== choice.userId) {
    if (pendingSignOutAttempt?.context === choice) pendingSignOutAttempt = null;
    return;
  }
  const removedStaleCache = removeAccountCacheIfUnchanged(choice.userId, capturedAccountCache);
  releaseAccountTabLock(choice);
  if (authContextMatches(choice)) {
    accountSession = null;
    setTrackerTransitioning(false);
  }
  window.setTimeout(() => {
    if (pendingSignOutAttempt?.context === choice && !accountSession) pendingSignOutAttempt = null;
  }, 1000);
  clearPendingCloudChoice();
  render();
  renderAccount();
  if (!removedStaleCache) showWarning("You were signed out and the browser tracker was kept, but an older account cache could not be removed from this browser.");
  if (signOutResult?.localSignOutError || signOutResult?.localSignOutSkipped) showWarning("The account session ended on the server, but this browser could not clear the exact expired local session. Reload this page to finish cleanup.");
  announce("Browser tracker kept. You were signed out so neither history was overwritten.");
});

$("#deleteAccount").addEventListener("click", () => deleteAccountDialog.showModal());
$("#confirmDeleteAccount").addEventListener("click", async () => {
  $("#confirmDeleteAccount").disabled = true;
  const operationContext = currentAuthContext();
  let localSnapshot = null;
  try {
    if (!operationContext.userId) throw new Error("Sign in again before deleting this account.");
    await cloudMutationQueue.idle();
    if (!authContextMatches(operationContext)) throw new Error("Account deletion was stopped because the signed-in account changed.");
    localSnapshot = captureLocalTrackerContext();
    if (!localSnapshot) return;
    if (!removeStoredState()) {
      sealLocalTrackerRollback(localSnapshot);
      throw new Error("Account deletion was stopped because this browser’s tracker copy could not be cleared safely.");
    }
    if (!removeGuestStoredState()) {
      sealLocalTrackerRollback(localSnapshot);
      throw new Error("Account deletion was stopped because every browser tracker copy could not be cleared safely.");
    }
    window.localStorage.removeItem(accountStorageKey(operationContext.userId));
    window.localStorage.removeItem(legacyAccountBackupKey(operationContext.userId));
    sealLocalTrackerRollback(localSnapshot);
    pendingSignOutAttempt = { context: operationContext, keepGuest: false };
    const deletion = await cloud.deleteAccount(operationContext.userId);
    if (!accountSession?.user?.id || accountSession.user.id === operationContext.userId) {
      releaseAccountTabLock(operationContext);
      accountSession = null;
      quarantineAccountState();
      setTrackerTransitioning(false);
      deleteAccountDialog.close();
      render();
      renderAccount();
      clearWarning();
      announce("Your account and all tracker data were deleted.");
      if (deletion?.localSignOutError || deletion?.localSignOutSkipped) showWarning("The account was deleted, but this browser could not fully clear the exact expired local sign-in session. Reloading the page will finish cleanup.");
      window.setTimeout(() => {
        if (pendingSignOutAttempt?.context === operationContext && !accountSession) pendingSignOutAttempt = null;
      }, 1000);
    }
  } catch (error) {
    if (pendingSignOutAttempt?.context === operationContext) pendingSignOutAttempt = null;
    if (localSnapshot) {
      if (localSnapshot.rollbackStorage === undefined) sealLocalTrackerRollback(localSnapshot);
      restoreLocalTrackerContext(localSnapshot);
      if (authContextMatches(operationContext)) {
        render();
        renderAccount();
      }
    }
    if (authContextMatches(operationContext)) showWarning(error?.message || "The account deletion could not be confirmed. The browser copy was restored.");
  } finally {
    if (authContextMatches(operationContext) || !accountSession) $("#confirmDeleteAccount").disabled = false;
  }
});

state = loadState();
if (!app) showWarning("The tracker interface did not initialize.");
window.addEventListener("pagehide", (event) => {
  const lockedContext = accountLockUserId ? { userId: accountLockUserId, epoch: accountLockEpoch } : null;
  if (event.persisted && accountSession) {
    authEpoch += 1;
    clearPendingCloudChoice();
    setTrackerTransitioning(true);
    quarantineAccountState();
    render();
  }
  releaseAccountTabLock(lockedContext);
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  setTrackerTransitioning(true);
  quarantineAccountState();
  render();
  window.location.reload();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshTimeDependentDisplay();
});
await initializeAccount();
scheduleTimeRefresh();
