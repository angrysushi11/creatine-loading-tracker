import assert from "node:assert/strict";
import test from "node:test";
import { createCreatineCloudAdapter, createSerializedMutationQueue, planGuestMigration, prepareGuestImport, trackerContentFingerprint } from "../public/tools/creatine-cloud-adapter.js";
import { LEGACY_MODEL_VERSION, MODEL_VERSION } from "../public/tools/creatine-model.js";

const state = {
  schemaVersion: 2,
  modelVersion: MODEL_VERSION,
  profile: {
    weightKg: 60,
    trackingStartDate: "2026-08-01",
    trackerTimezone: "Asia/Makassar",
    defaultDoseGrams: 5,
  },
  doses: [
    { id: "b", takenAt: "2026-08-02T01:00:00.000Z", timezone: "Asia/Makassar", grams: 3, createdAt: "2026-08-02T01:01:00.000Z", entryMethod: "now" },
    { id: "a", takenAt: "2026-08-01T01:00:00.000Z", timezone: "Asia/Makassar", grams: 5, createdAt: "2026-08-01T01:01:00.000Z", entryMethod: "backfill" },
  ],
};

const authStorageKey = "doubledash.creatine-auth.v1";

function storedSession(userId) {
  return JSON.stringify({ access_token: `${userId}-token`, refresh_token: `${userId}-refresh`, user: { id: userId } });
}

function memoryAuthStorage(userId = null) {
  const values = new Map(userId ? [[authStorageKey, storedSession(userId)]] : []);
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

test("prepares a deterministic, idempotent guest import", async () => {
  const first = await prepareGuestImport(state, globalThis.crypto);
  const second = await prepareGuestImport({ ...state, doses: [...state.doses].reverse() }, globalThis.crypto);
  assert.equal(first.importId, second.importId);
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.match(first.importId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(first.payloadSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.payload.doses.map((dose) => dose.id), ["a", "b"]);
});

test("plans only non-destructive browser-to-account migrations", () => {
  const empty = { schemaVersion: 2, modelVersion: MODEL_VERSION, profile: null, doses: [] };
  assert.equal(planGuestMigration(empty, empty).action, "empty");
  assert.equal(planGuestMigration(state, empty).action, "import_local");
  assert.equal(planGuestMigration(empty, state).action, "use_cloud");
  assert.equal(planGuestMigration(state, state).action, "already_synced");
  assert.equal(planGuestMigration(state, { ...state, profile: { ...state.profile, weightKg: 61 } }).action, "conflict");
});

test("treats equivalent database timestamp formats as the same tracker history", () => {
  const databaseState = {
    ...state,
    doses: state.doses.map((dose, index) => ({
      ...dose,
      takenAt: index === 0 ? "2026-08-02T01:00:00+00:00" : "2026-08-01T09:00:00+08:00",
      createdAt: index === 0 ? "2026-08-02T01:01:00+00:00" : "2026-08-01T01:01:05+00:00",
      entryMethod: "unknown",
    })),
  };

  assert.equal(new Date(state.doses[0].takenAt).getTime(), new Date(databaseState.doses[0].takenAt).getTime());
  assert.equal(new Date(state.doses[1].takenAt).getTime(), new Date(databaseState.doses[1].takenAt).getTime());
  assert.equal(trackerContentFingerprint(state), trackerContentFingerprint(databaseState));
  assert.equal(planGuestMigration(state, databaseState).action, "already_synced");
});

test("keeps genuine tracker differences classified as conflicts", () => {
  const changedTime = { ...state, doses: state.doses.map((dose, index) => index === 0 ? { ...dose, takenAt: "2026-08-02T01:00:01.000Z" } : dose) };
  const changedGrams = { ...state, doses: state.doses.map((dose, index) => index === 0 ? { ...dose, grams: 3.1 } : dose) };
  const missingDose = { ...state, doses: state.doses.slice(1) };

  assert.equal(planGuestMigration(state, changedTime).action, "conflict");
  assert.equal(planGuestMigration(state, changedGrams).action, "conflict");
  assert.equal(planGuestMigration(state, missingDose).action, "conflict");
});

test("does not create an adapter without a configured public client", () => {
  assert.equal(createCreatineCloudAdapter({ supabase: null }), null);
});

test("rejects an empty guest state before any network call", async () => {
  await assert.rejects(
    prepareGuestImport({ schemaVersion: 2, modelVersion: MODEL_VERSION, profile: null, doses: [] }, globalThis.crypto),
    (error) => error.code === "invalid_local_state",
  );
});

test("serializes complete cloud mutation transactions in the order the UI starts them", async () => {
  const queue = createSerializedMutationQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run(async () => {
    events.push("add:start");
    await firstGate;
    events.push("add:end");
  });
  const undo = queue.run(async () => { events.push("undo"); });

  await Promise.resolve();
  assert.deepEqual(events, ["add:start"]);
  releaseFirst();
  await Promise.all([first, undo]);
  assert.deepEqual(events, ["add:start", "add:end", "undo"]);
});

test("writes the current balance-model version while legacy backups remain importable", async () => {
  let writtenProfile;
  const supabase = {
    auth: {
      async getSession() {
        return { data: { session: { user: { id: "account-a" } } }, error: null };
      },
    },
    from(table) {
      assert.equal(table, "tracker_profiles");
      return {
        async upsert(row) { writtenProfile = row; return { error: null }; },
      };
    },
  };
  const adapter = createCreatineCloudAdapter({ supabase });
  await adapter.upsertProfile(state.profile, "account-a");
  assert.equal(writtenProfile.model_version, MODEL_VERSION);

  const legacyPrepared = await prepareGuestImport({ ...state, modelVersion: LEGACY_MODEL_VERSION }, globalThis.crypto);
  assert.equal(legacyPrepared.rpcArgs.p_source_model_version, LEGACY_MODEL_VERSION);
});

test("continues the mutation queue after a failed operation", async () => {
  const queue = createSerializedMutationQueue();
  const events = [];
  await assert.rejects(queue.run(async () => { throw new Error("offline"); }), /offline/);
  await queue.run(async () => { events.push("next"); });
  await queue.idle();
  assert.deepEqual(events, ["next"]);
});

test("sends a normalized passwordless email link to the clean tracker URL", async () => {
  let request;
  const supabase = {
    auth: {
      async signInWithOtp(candidate) { request = candidate; return { error: null }; },
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    redirectUrl: "https://doubledash.me/tools/creatine-loading/?code=temporary#fragment",
  });
  await adapter.signInWithEmail("  DASH@example.com ");
  assert.deepEqual(request, {
    email: "dash@example.com",
    options: { emailRedirectTo: "https://doubledash.me/tools/creatine-loading/" },
  });
  await assert.rejects(adapter.signInWithEmail("not-an-email"), /valid email/i);
});

test("identity-pinned account operations reject a changed session before data or API work", async () => {
  let fromCalls = 0;
  let rpcCalls = 0;
  let fetchCalls = 0;
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: "account-b-token", user: { id: "account-b" } } },
          error: null,
        };
      },
    },
    from() {
      fromCalls += 1;
      throw new Error("data access must not start after an identity mismatch");
    },
    rpc() {
      rpcCalls += 1;
      throw new Error("RPC must not start after an identity mismatch");
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("account API must not start after an identity mismatch");
    },
  });
  const expectedUserId = "account-a";
  const operations = [
    () => adapter.loadTracker(expectedUserId),
    () => adapter.upsertProfile(state.profile, expectedUserId),
    () => adapter.upsertDose(state.doses[0], expectedUserId),
    () => adapter.deleteDose(state.doses[0].id, expectedUserId),
    () => adapter.importGuestState(state, expectedUserId),
    () => adapter.deleteTrackerData(expectedUserId),
    () => adapter.deleteAccount(expectedUserId),
  ];

  for (const operation of operations) {
    await assert.rejects(
      operation(),
      (error) => error.code === "auth_required" && /account changed/i.test(error.message),
    );
  }
  assert.equal(fromCalls, 0);
  assert.equal(rpcCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("an HTTP 200 account deletion stays committed when local sign-out cleanup fails", async () => {
  let deleteRequest;
  const cleanupFailure = new Error("local storage unavailable");
  const authStorage = memoryAuthStorage("account-a");
  authStorage.removeItem = () => { throw cleanupFailure; };
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: "account-a-token", user: { id: "account-a" } } },
          error: null,
        };
      },
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    authStorage,
    fetch: async (url, options) => {
      deleteRequest = { url, options };
      return { ok: true, status: 200 };
    },
  });

  const result = await adapter.deleteAccount("account-a");

  assert.equal(deleteRequest.url, "/api/creatine-account");
  assert.equal(deleteRequest.options.method, "DELETE");
  assert.equal(deleteRequest.options.headers.authorization, "Bearer account-a-token");
  assert.equal(result.status, "deleted");
  assert.equal(result.localSignOutSkipped, false);
  assert.equal(result.localSignOutError.code, "request_failed");
  assert.match(result.localSignOutError.message, /browser session could not be cleared/i);
  assert.equal(result.localSignOutError.cause, cleanupFailure);
});

test("identity-pinned sign-out rejects a changed session without signing out the new account", async () => {
  let revokeCalls = 0;
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: "account-b-token", user: { id: "account-b" } } },
          error: null,
        };
      },
      admin: {
        async signOut() {
          revokeCalls += 1;
          return { error: null };
        },
      },
    },
  };
  const adapter = createCreatineCloudAdapter({ supabase });

  await assert.rejects(
    adapter.signOut("account-a"),
    (error) => error.code === "auth_required" && /account changed/i.test(error.message),
  );
  assert.equal(revokeCalls, 0);
});

test("guest import rechecks identity after hashing before calling the RPC", async () => {
  let activeUserId = "account-a";
  let rpcCalls = 0;
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: `${activeUserId}-token`, user: { id: activeUserId } } },
          error: null,
        };
      },
    },
    rpc() {
      rpcCalls += 1;
      throw new Error("guest import RPC must not run for the switched account");
    },
  };
  const crypto = {
    subtle: {
      async digest(algorithm, bytes) {
        const digest = await globalThis.crypto.subtle.digest(algorithm, bytes);
        activeUserId = "account-b";
        return digest;
      },
    },
  };
  const adapter = createCreatineCloudAdapter({ supabase, crypto });

  await assert.rejects(
    adapter.importGuestState(state, "account-a"),
    (error) => error.code === "auth_required" && /account changed/i.test(error.message),
  );
  assert.equal(rpcCalls, 0);
});

test("account deletion never signs out a different account that became active during the API call", async () => {
  let activeUserId = "account-a";
  const authStorage = memoryAuthStorage("account-a");
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: `${activeUserId}-token`, user: { id: activeUserId } } },
          error: null,
        };
      },
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    authStorage,
    fetch: async () => {
      activeUserId = "account-b";
      authStorage.setItem(authStorageKey, storedSession("account-b"));
      return { ok: true, status: 200 };
    },
  });

  const result = await adapter.deleteAccount("account-a");

  assert.equal(result.status, "deleted");
  assert.equal(result.localSignOutSkipped, true);
  assert.equal(result.localSignOutError, null);
  assert.equal(JSON.parse(authStorage.getItem(authStorageKey)).user.id, "account-b");
});

test("captured-session sign-out revokes A without clearing newly active B", async () => {
  const authStorage = memoryAuthStorage("account-a");
  let revokedToken = null;
  let lockName = null;
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: "account-a-token", user: { id: "account-a" } } },
          error: null,
        };
      },
      admin: {
        async signOut(token, scope) {
          revokedToken = { token, scope };
          authStorage.setItem(authStorageKey, storedSession("account-b"));
          return { error: null };
        },
      },
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    authStorage,
    authLock: async (name, timeout, action) => {
      lockName = { name, timeout };
      return action();
    },
  });

  const result = await adapter.signOut("account-a");

  assert.deepEqual(revokedToken, { token: "account-a-token", scope: "local" });
  assert.deepEqual(lockName, { name: `lock:${authStorageKey}`, timeout: 10000 });
  assert.equal(result.status, "signed_out");
  assert.equal(result.localSignOutSkipped, true);
  assert.equal(JSON.parse(authStorage.getItem(authStorageKey)).user.id, "account-b");
});

test("account deletion remains committed when post-200 auth-lock cleanup throws", async () => {
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: "account-a-token", user: { id: "account-a" } } },
          error: null,
        };
      },
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    authStorage: memoryAuthStorage("account-a"),
    authLock: async () => { throw new Error("lock unavailable after commit"); },
    fetch: async () => ({ ok: true, status: 200 }),
  });

  const result = await adapter.deleteAccount("account-a");

  assert.equal(result.status, "deleted");
  assert.equal(result.localSignOutSkipped, false);
  assert.equal(result.localSignOutError.code, "request_failed");
  assert.match(result.localSignOutError.message, /account was deleted/i);
});

test("sign-out uses the current same-user token captured inside the auth lock", async () => {
  const authStorage = memoryAuthStorage("account-a");
  let revokedToken = null;
  const refreshed = JSON.stringify({
    access_token: "account-a-refreshed-token",
    refresh_token: "account-a-refreshed-refresh",
    user: { id: "account-a" },
  });
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: "account-a-old-token", user: { id: "account-a" } } },
          error: null,
        };
      },
      admin: {
        async signOut(token) {
          revokedToken = token;
          return { error: null };
        },
      },
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    authStorage,
    authLock: async (_name, _timeout, action) => {
      authStorage.setItem(authStorageKey, refreshed);
      return action();
    },
  });

  const result = await adapter.signOut("account-a");

  assert.equal(revokedToken, "account-a-refreshed-token");
  assert.equal(result.status, "signed_out");
  assert.equal(result.localSignOutSkipped, false);
  assert.equal(authStorage.getItem(authStorageKey), null);
});

test("committed account deletion clears a refreshed session for the deleted user", async () => {
  const authStorage = memoryAuthStorage("account-a");
  const supabase = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: "account-a-old-token", user: { id: "account-a" } } },
          error: null,
        };
      },
    },
  };
  const adapter = createCreatineCloudAdapter({
    supabase,
    authStorage,
    authLock: async (_name, _timeout, action) => action(),
    fetch: async () => {
      authStorage.setItem(authStorageKey, JSON.stringify({
        access_token: "account-a-refreshed-token",
        refresh_token: "account-a-refreshed-refresh",
        user: { id: "account-a" },
      }));
      return { ok: true, status: 200 };
    },
  });

  const result = await adapter.deleteAccount("account-a");

  assert.equal(result.status, "deleted");
  assert.equal(result.localSignOutSkipped, false);
  assert.equal(authStorage.getItem(authStorageKey), null);
});
