import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { createCreatineCloudAdapter } from "../public/tools/creatine-cloud-adapter.js";
import { MODEL_VERSION } from "../public/tools/creatine-model.js";

class SafeVerificationError extends Error {}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  loadEnvFile(path.join(repoRoot, ".env.local"));
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw new Error("Could not load the local environment file.");
  }
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.PUBLIC_SUPABASE_URL;
const publicKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !publicKey || !serviceRoleKey) {
  throw new Error(
    "Missing Supabase environment variables. Provide SUPABASE_URL (or PUBLIC_SUPABASE_URL), a publishable/anon key, and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY).",
  );
}

if (publicKey === serviceRoleKey) {
  throw new Error("The public test client and administrative client must use different keys.");
}

const clientOptions = {
  auth: {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false,
  },
};

const admin = createClient(supabaseUrl, serviceRoleKey, clientOptions);
const createdUserIds = [];
const signedInClients = [];

function pass(label) {
  console.log(`[pass] ${label}`);
}

function safeErrorCode(error) {
  const code = error?.code || error?.status;
  return typeof code === "string" || typeof code === "number" ? String(code) : null;
}

function requireSuccess(result, label) {
  if (result.error) {
    const code = safeErrorCode(result.error);
    throw new SafeVerificationError(`${label} failed${code ? ` (${code})` : ""}.`);
  }
  return result.data;
}

function requireDenied(result, label) {
  if (!result.error) {
    throw new SafeVerificationError(`${label} unexpectedly succeeded.`);
  }
}

function requireEmpty(result, label) {
  const rows = requireSuccess(result, label);
  assert.ok(Array.isArray(rows), `${label} did not return a row collection.`);
  assert.equal(rows.length, 0, `${label} exposed or modified another user's row.`);
}

function makeCredentials() {
  const nonce = randomUUID().replaceAll("-", "");
  return {
    email: `creatine-rls-${nonce}@example.com`,
    password: `${randomBytes(24).toString("base64url")}Aa1!`,
  };
}

async function createConfirmedUser() {
  const credentials = makeCredentials();
  const result = await admin.auth.admin.createUser({
    email: credentials.email,
    password: credentials.password,
    email_confirm: true,
    user_metadata: { purpose: "creatine-rls-verifier" },
  });
  const user = requireSuccess(result, "Temporary user creation")?.user;
  assert.ok(user?.id, "Temporary user creation returned no user.");
  createdUserIds.push(user.id);
  return { ...credentials, id: user.id };
}

async function signInUser(user) {
  const client = createClient(supabaseUrl, publicKey, clientOptions);
  const result = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  const session = requireSuccess(result, "Temporary user sign-in")?.session;
  assert.equal(session?.user?.id, user.id, "Temporary user signed in to an unexpected account.");
  signedInClients.push(client);
  return client;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function recentIso(offsetSeconds = 60) {
  return new Date(Date.now() - offsetSeconds * 1_000).toISOString();
}

function profileFor(userId, weightKg) {
  return {
    user_id: userId,
    schema_version: 2,
    model_version: "protocol-progress-v1",
    weight_kg: weightKg,
    tracking_start_date: todayUtc(),
    tracker_timezone: "UTC",
    default_dose_grams: 5,
  };
}

function doseFor(userId, id, grams) {
  const takenAt = recentIso();
  return {
    user_id: userId,
    id,
    taken_at: takenAt,
    timezone: "UTC",
    grams,
    entry_method: "rls_verify",
    client_created_at: takenAt,
  };
}

async function createOwnRows(client, user, suffix, weightKg, grams) {
  const profile = requireSuccess(
    await client.from("tracker_profiles").insert(profileFor(user.id, weightKg)).select("user_id, weight_kg, revision").single(),
    `${suffix} profile insert`,
  );
  assert.equal(profile.user_id, user.id);
  assert.equal(Number(profile.weight_kg), weightKg);

  const doseId = `rls-${randomUUID()}`;
  const dose = requireSuccess(
    await client.from("dose_events").insert(doseFor(user.id, doseId, grams)).select("user_id, id, grams, revision").single(),
    `${suffix} dose insert`,
  );
  assert.equal(dose.user_id, user.id);
  assert.equal(dose.id, doseId);
  assert.equal(Number(dose.grams), grams);
  return { doseId };
}

async function verifyOwnReadAndUpdate(client, user, doseId, suffix, nextWeight, nextGrams) {
  const profiles = requireSuccess(
    await client.from("tracker_profiles").select("user_id, weight_kg, revision"),
    `${suffix} profile read`,
  );
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].user_id, user.id);

  const doses = requireSuccess(
    await client.from("dose_events").select("user_id, id, grams, revision"),
    `${suffix} dose read`,
  );
  assert.equal(doses.length, 1);
  assert.equal(doses[0].user_id, user.id);
  assert.equal(doses[0].id, doseId);

  const updatedProfiles = requireSuccess(
    await client
      .from("tracker_profiles")
      .update({ weight_kg: nextWeight })
      .eq("user_id", user.id)
      .select("user_id, weight_kg, revision"),
    `${suffix} profile update`,
  );
  assert.equal(updatedProfiles.length, 1);
  assert.equal(Number(updatedProfiles[0].weight_kg), nextWeight);
  assert.equal(Number(updatedProfiles[0].revision), 2);

  const updatedDoses = requireSuccess(
    await client
      .from("dose_events")
      .update({ grams: nextGrams })
      .eq("user_id", user.id)
      .eq("id", doseId)
      .select("user_id, id, grams, revision"),
    `${suffix} dose update`,
  );
  assert.equal(updatedDoses.length, 1);
  assert.equal(Number(updatedDoses[0].grams), nextGrams);
  assert.equal(Number(updatedDoses[0].revision), 2);
}

async function verifyCannotAccessOther(client, otherUser, suffix) {
  await requireEmpty(
    await client.from("tracker_profiles").select("user_id").eq("user_id", otherUser.id),
    `${suffix} cross-user profile read`,
  );
  await requireEmpty(
    await client.from("dose_events").select("user_id, id").eq("user_id", otherUser.id),
    `${suffix} cross-user dose read`,
  );
  await requireEmpty(
    await client
      .from("tracker_profiles")
      .update({ weight_kg: 99 })
      .eq("user_id", otherUser.id)
      .select("user_id"),
    `${suffix} cross-user profile update`,
  );
  await requireEmpty(
    await client
      .from("dose_events")
      .update({ grams: 9 })
      .eq("user_id", otherUser.id)
      .select("user_id, id"),
    `${suffix} cross-user dose update`,
  );
  await requireEmpty(
    await client.from("tracker_profiles").delete().eq("user_id", otherUser.id).select("user_id"),
    `${suffix} cross-user profile delete`,
  );
  await requireEmpty(
    await client.from("dose_events").delete().eq("user_id", otherUser.id).select("user_id, id"),
    `${suffix} cross-user dose delete`,
  );

  requireDenied(
    await client.from("tracker_profiles").insert(profileFor(otherUser.id, 80)),
    `${suffix} cross-user profile insert`,
  );
  requireDenied(
    await client.from("dose_events").insert(doseFor(otherUser.id, `rls-${randomUUID()}`, 5)),
    `${suffix} cross-user dose insert`,
  );
}

async function deleteOwnRows(client, user, doseId, suffix) {
  const doses = requireSuccess(
    await client
      .from("dose_events")
      .delete()
      .eq("user_id", user.id)
      .eq("id", doseId)
      .select("user_id, id"),
    `${suffix} own dose delete`,
  );
  assert.equal(doses.length, 1);

  const profiles = requireSuccess(
    await client.from("tracker_profiles").delete().eq("user_id", user.id).select("user_id"),
    `${suffix} own profile delete`,
  );
  assert.equal(profiles.length, 1);

  await requireEmpty(
    await client.from("tracker_profiles").select("user_id"),
    `${suffix} profile delete readback`,
  );
  await requireEmpty(
    await client.from("dose_events").select("user_id, id"),
    `${suffix} dose delete readback`,
  );
}

function importArguments(importId) {
  const doseId = `import-${randomUUID()}`;
  const profile = {
    weightKg: 70,
    trackingStartDate: todayUtc(),
    trackerTimezone: "UTC",
    defaultDoseGrams: 5,
  };
  const doses = [
    {
      id: doseId,
      takenAt: recentIso(120),
      timezone: "UTC",
      grams: 5,
      entryMethod: "import",
      createdAt: recentIso(90),
    },
  ];
  const hash = createHash("sha256").update(JSON.stringify({ profile, doses })).digest("hex");
  return {
    p_import_id: importId,
    p_payload_sha256: hash,
    p_source_schema_version: 2,
    p_source_model_version: MODEL_VERSION,
    p_profile: profile,
    p_doses: doses,
  };
}

async function verifyImportRpc(clientA, clientB, userA, userB) {
  const importId = randomUUID();
  const args = importArguments(importId);
  const argsA = { p_expected_user_id: userA.id, ...args };
  const argsB = { p_expected_user_id: userB.id, ...args };

  requireDenied(
    await clientA.rpc("import_creatine_guest_state_bound", argsB),
    "User A identity-mismatched import RPC",
  );
  requireDenied(
    await clientA.rpc("import_creatine_guest_state", args),
    "User A unbound import RPC",
  );

  const firstA = requireSuccess(await clientA.rpc("import_creatine_guest_state_bound", argsA), "User A import RPC");
  assert.equal(firstA?.status, "applied");
  assert.equal(Number(firstA?.doseCount), 1);

  const replayA = requireSuccess(await clientA.rpc("import_creatine_guest_state_bound", argsA), "User A import RPC replay");
  assert.equal(replayA?.status, "already_applied");
  assert.equal(Number(replayA?.doseCount), 1);

  await requireEmpty(
    await clientB.from("tracker_import_receipts").select("user_id, import_id").eq("user_id", userA.id),
    "User B import receipt isolation",
  );
  await requireEmpty(
    await clientB.from("tracker_profiles").select("user_id").eq("user_id", userA.id),
    "User B imported profile isolation",
  );
  await requireEmpty(
    await clientB.from("dose_events").select("user_id, id").eq("user_id", userA.id),
    "User B imported dose isolation",
  );

  const firstB = requireSuccess(await clientB.rpc("import_creatine_guest_state_bound", argsB), "User B isolated import RPC");
  assert.equal(firstB?.status, "applied");
  assert.equal(Number(firstB?.doseCount), 1);

  const replayB = requireSuccess(await clientB.rpc("import_creatine_guest_state_bound", argsB), "User B import RPC replay");
  assert.equal(replayB?.status, "already_applied");
  assert.equal(Number(replayB?.doseCount), 1);

  const rowsA = requireSuccess(
    await clientA.from("tracker_profiles").select("user_id"),
    "User A imported profile readback",
  );
  const rowsB = requireSuccess(
    await clientB.from("tracker_profiles").select("user_id"),
    "User B imported profile readback",
  );
  assert.deepEqual(rowsA.map((row) => row.user_id), [userA.id]);
  assert.deepEqual(rowsB.map((row) => row.user_id), [userB.id]);

  requireDenied(
    await clientA.rpc("delete_current_creatine_tracker_data_bound", { p_expected_user_id: userB.id }),
    "User A identity-mismatched tracker deletion RPC",
  );
  requireDenied(
    await clientA.rpc("delete_current_creatine_tracker_data"),
    "User A unbound tracker deletion RPC",
  );

  for (const [client, user, label] of [[clientA, userA, "User A"], [clientB, userB, "User B"]]) {
    const deleted = requireSuccess(
      await client.rpc("delete_current_creatine_tracker_data_bound", { p_expected_user_id: user.id }),
      `${label} tracker deletion RPC`,
    );
    assert.equal(deleted?.status, "deleted");
    await requireEmpty(await client.from("tracker_profiles").select("user_id"), `${label} deleted profile readback`);
    await requireEmpty(await client.from("dose_events").select("user_id, id"), `${label} deleted dose readback`);
    await requireEmpty(await client.from("tracker_import_receipts").select("user_id, import_id"), `${label} deleted receipt readback`);
  }
}

async function verifyProductionAdapter(client) {
  const adapter = createCreatineCloudAdapter({
    supabase: client,
    redirectUrl: "https://doubledash.me/tools/creatine-loading/",
    crypto: globalThis.crypto,
  });
  const profile = {
    weightKg: 68,
    trackingStartDate: todayUtc(),
    trackerTimezone: "UTC",
    defaultDoseGrams: 3,
  };
  const dose = {
    id: `adapter-${randomUUID()}`,
    takenAt: recentIso(30),
    timezone: "UTC",
    grams: 3.5,
    createdAt: recentIso(20),
    entryMethod: "rls_verify",
  };
  await adapter.upsertProfile(profile);
  await adapter.upsertDose(dose);
  const loaded = await adapter.loadTracker();
  assert.deepEqual(loaded.profile, profile);
  assert.equal(loaded.doses.length, 1);
  assert.equal(loaded.doses[0].id, dose.id);
  assert.equal(loaded.doses[0].grams, 3.5);
  await adapter.deleteDose(dose.id);
  const afterDoseDelete = await adapter.loadTracker();
  assert.equal(afterDoseDelete.doses.length, 0);
  await adapter.deleteTrackerData();
  const afterTrackerDelete = await adapter.loadTracker();
  assert.equal(afterTrackerDelete.profile, null);
  assert.equal(afterTrackerDelete.doses.length, 0);
}

async function run() {
  let primaryFailure = null;
  let cleanupFailed = false;

  try {
    const userA = await createConfirmedUser();
    const userB = await createConfirmedUser();
    pass("created two isolated confirmed test users");

    const clientA = await signInUser(userA);
    const clientB = await signInUser(userB);
    pass("signed in with separate non-persistent clients");

    const rowsA = await createOwnRows(clientA, userA, "User A", 70, 3);
    const rowsB = await createOwnRows(clientB, userB, "User B", 75, 5);
    await verifyOwnReadAndUpdate(clientA, userA, rowsA.doseId, "User A", 71, 4);
    await verifyOwnReadAndUpdate(clientB, userB, rowsB.doseId, "User B", 76, 6);
    pass("each user can create, read, and update only their own profile and dose");

    await verifyCannotAccessOther(clientB, userA, "User B");
    await verifyCannotAccessOther(clientA, userB, "User A");
    pass("cross-user reads, updates, deletes, and owner-forged inserts are blocked");

    await deleteOwnRows(clientA, userA, rowsA.doseId, "User A");
    requireDenied(
      await clientB.from("tracker_profiles").insert(profileFor(userA.id, 80)),
      "User B owner-forged profile insert after owner deletion",
    );
    await deleteOwnRows(clientB, userB, rowsB.doseId, "User B");
    pass("each user can delete their own profile and dose; owner-forged profile inserts remain blocked");

    await verifyImportRpc(clientA, clientB, userA, userB);
    pass("guest import is isolated/idempotent, and tracker deletion removes each user's profile, doses, and import receipt");

    await verifyProductionAdapter(clientA);
    pass("production cloud adapter maps, saves, loads, and deletes variable-dose tracker data");
  } catch (error) {
    primaryFailure = error;
  } finally {
    for (const client of signedInClients) {
      try {
        await client.auth.signOut({ scope: "local" });
      } catch {
        // Administrative hard deletion below invalidates any remaining session.
      }
    }

    for (const userId of createdUserIds) {
      try {
        const result = await admin.auth.admin.deleteUser(userId, false);
        if (result.error) cleanupFailed = true;
      } catch {
        cleanupFailed = true;
      }
    }
  }

  if (cleanupFailed) {
    throw new Error("Temporary-user cleanup failed; inspect the Supabase Auth dashboard.");
  }
  pass("hard-deleted all temporary users and cascade-owned test data");

  if (primaryFailure) {
    throw primaryFailure;
  }
}

try {
  await run();
  console.log("Creatine RLS verification passed.");
} catch (error) {
  const code = safeErrorCode(error);
  const safeDetail = error instanceof SafeVerificationError ? ` ${error.message}` : "";
  console.error(`Creatine RLS verification failed${code ? ` (${code})` : ""}.${safeDetail}`);
  process.exitCode = 1;
}
