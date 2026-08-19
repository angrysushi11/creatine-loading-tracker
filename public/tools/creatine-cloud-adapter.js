import { MODEL_VERSION } from "./creatine-model.js";

export const CLOUD_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: "auth_required",
  CONFLICT: "cloud_conflict",
  INVALID_LOCAL_STATE: "invalid_local_state",
  REQUEST_FAILED: "request_failed",
});

export class CreatineCloudError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "CreatineCloudError";
    this.code = code;
  }
}

export function createSerializedMutationQueue() {
  let tail = Promise.resolve();

  return {
    run(action) {
      const operation = tail.then(action, action);
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async idle() {
      await tail;
    },
  };
}

function cloudError(error, fallbackMessage = "Cloud saving failed.") {
  const message = String(error?.message || "");
  if (message.includes("CREATINE_CLOUD_NOT_EMPTY") || message.includes("CREATINE_IMPORT_ID_CONFLICT")) {
    return new CreatineCloudError(CLOUD_ERROR_CODES.CONFLICT, "This account already contains different tracker data.", error);
  }
  if (message.includes("AUTH") || error?.status === 401 || error?.status === 403) {
    return new CreatineCloudError(CLOUD_ERROR_CODES.AUTH_REQUIRED, "Sign in again to use cloud saving.", error);
  }
  return new CreatineCloudError(CLOUD_ERROR_CODES.REQUEST_FAILED, fallbackMessage, error);
}

function normalizeRedirectUrl(value) {
  const url = new URL(value || globalThis.location?.href || "https://doubledash.me/tools/creatine-loading/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function profileFromRow(row) {
  if (!row) return null;
  return {
    weightKg: Number(row.weight_kg),
    trackingStartDate: row.tracking_start_date,
    trackerTimezone: row.tracker_timezone,
    defaultDoseGrams: Number(row.default_dose_grams),
  };
}

function profileToRow(profile, userId) {
  return {
    user_id: userId,
    schema_version: 2,
    model_version: MODEL_VERSION,
    weight_kg: profile.weightKg,
    tracking_start_date: profile.trackingStartDate,
    tracker_timezone: profile.trackerTimezone,
    default_dose_grams: profile.defaultDoseGrams,
  };
}

function doseFromRow(row) {
  return {
    id: row.id,
    takenAt: row.taken_at,
    timezone: row.timezone,
    grams: Number(row.grams),
    createdAt: row.client_created_at || row.created_at,
    entryMethod: row.entry_method,
  };
}

function doseToRow(dose, userId) {
  return {
    user_id: userId,
    id: dose.id,
    taken_at: dose.takenAt,
    timezone: dose.timezone,
    grams: dose.grams,
    entry_method: dose.entryMethod || "unknown",
    client_created_at: dose.createdAt || null,
  };
}

function normalizedTrackerPayload(state) {
  return {
    schemaVersion: Number(state?.schemaVersion),
    modelVersion: state?.modelVersion,
    profile: state?.profile ? {
      weightKg: Number(state.profile.weightKg),
      trackingStartDate: state.profile.trackingStartDate,
      trackerTimezone: state.profile.trackerTimezone,
      defaultDoseGrams: Number(state.profile.defaultDoseGrams),
    } : null,
    doses: [...(state?.doses || [])]
      .map((dose) => ({
        id: dose.id,
        takenAt: dose.takenAt,
        timezone: dose.timezone,
        grams: Number(dose.grams),
        createdAt: dose.createdAt || null,
        entryMethod: dose.entryMethod || "unknown",
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function canonicalInstant(value) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? String(value || "") : timestamp.toISOString();
}

export function trackerContentFingerprint(state) {
  const normalized = normalizedTrackerPayload(state);
  return JSON.stringify({
    schemaVersion: normalized.schemaVersion,
    modelVersion: normalized.modelVersion,
    profile: normalized.profile,
    doses: normalized.doses.map((dose) => ({
      id: dose.id,
      takenAt: canonicalInstant(dose.takenAt),
      timezone: dose.timezone,
      grams: dose.grams,
    })),
  });
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function uuidFromDigest(bytes) {
  const value = new Uint8Array(bytes.slice(0, 16));
  value[6] = (value[6] & 0x0f) | 0x50;
  value[8] = (value[8] & 0x3f) | 0x80;
  const hex = bytesToHex(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function prepareGuestImport(state, cryptoImpl = globalThis.crypto) {
  const payload = normalizedTrackerPayload(state);
  if (!payload.profile || ![1, 2].includes(payload.schemaVersion) || !payload.modelVersion || !Array.isArray(payload.doses) || !cryptoImpl?.subtle) {
    throw new CreatineCloudError(CLOUD_ERROR_CODES.INVALID_LOCAL_STATE, "The browser tracker is not valid for cloud import.");
  }
  const serialized = JSON.stringify(payload);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(serialized)));
  return {
    importId: uuidFromDigest(digest),
    payloadSha256: bytesToHex(digest),
    payload,
    rpcArgs: {
      p_import_id: uuidFromDigest(digest),
      p_payload_sha256: bytesToHex(digest),
      p_source_schema_version: payload.schemaVersion,
      p_source_model_version: payload.modelVersion,
      p_profile: payload.profile,
      p_doses: payload.doses,
    },
  };
}

export function planGuestMigration(localState, cloudTracker) {
  const local = normalizedTrackerPayload(localState);
  const remote = normalizedTrackerPayload({
    schemaVersion: cloudTracker?.schemaVersion ?? 2,
    modelVersion: cloudTracker?.modelVersion ?? MODEL_VERSION,
    profile: cloudTracker?.profile || null,
    doses: cloudTracker?.doses || [],
  });
  const localHasData = Boolean(local.profile) || local.doses.length > 0;
  const cloudHasData = Boolean(remote.profile) || remote.doses.length > 0;
  if (!localHasData && !cloudHasData) return { action: "empty" };
  if (localHasData && !cloudHasData) return { action: "import_local" };
  if (!localHasData && cloudHasData) return { action: "use_cloud" };
  if (trackerContentFingerprint(local) === trackerContentFingerprint(remote)) return { action: "already_synced" };
  return { action: "conflict" };
}

export function createCreatineCloudAdapter({
  supabase = globalThis.window?.__CREATINE_SUPABASE_CLIENT__,
  redirectUrl = globalThis.location?.href,
  crypto: cryptoImpl = globalThis.crypto,
  fetch: fetchImpl = globalThis.fetch?.bind(globalThis),
  authStorage,
  authStorageKey = "doubledash.creatine-auth.v1",
  authLock = globalThis.__CREATINE_AUTH_LOCK__,
  BroadcastChannel: BroadcastChannelImpl = globalThis.BroadcastChannel,
} = {}) {
  if (!supabase) return null;

  let resolvedAuthStorage = authStorage;
  if (resolvedAuthStorage === undefined) {
    try { resolvedAuthStorage = globalThis.localStorage; } catch { resolvedAuthStorage = null; }
  }

  function notifyStoredSessionRemoved() {
    if (!BroadcastChannelImpl) return;
    try {
      const channel = new BroadcastChannelImpl(authStorageKey);
      channel.postMessage({ event: "SIGNED_OUT", session: null });
      channel.close();
    } catch {
      // The initiating UI also clears its in-memory session. This notification
      // only keeps other open tabs in step when BroadcastChannel is available.
    }
  }

  async function withAuthStorageLock(action) {
    if (!authLock) return action();
    return authLock(`lock:${authStorageKey}`, 10000, action);
  }

  function storedSessionForUser(expectedUserId) {
    if (!resolvedAuthStorage) return null;
    try {
      const raw = resolvedAuthStorage.getItem(authStorageKey);
      if (!raw) return null;
      const stored = JSON.parse(raw);
      if (stored?.user?.id !== expectedUserId || !stored?.access_token) return null;
      return stored;
    } catch {
      return null;
    }
  }

  function clearStoredSessionForUser(expectedUserId, expectedAccessToken) {
    if (!resolvedAuthStorage) return { cleared: false, skipped: true, error: null };
    try {
      const raw = resolvedAuthStorage.getItem(authStorageKey);
      if (!raw) return { cleared: true, skipped: false, error: null };
      const stored = JSON.parse(raw);
      if (stored?.user?.id !== expectedUserId || (expectedAccessToken && stored?.access_token !== expectedAccessToken)) {
        return { cleared: false, skipped: true, error: null };
      }
      resolvedAuthStorage.removeItem(authStorageKey);
      resolvedAuthStorage.removeItem(`${authStorageKey}-user`);
      notifyStoredSessionRemoved();
      return { cleared: true, skipped: false, error: null };
    } catch (error) {
      return {
        cleared: false,
        skipped: false,
        error: new CreatineCloudError(
          CLOUD_ERROR_CODES.REQUEST_FAILED,
          "The account session changed on the server, but this browser session could not be cleared automatically.",
          error,
        ),
      };
    }
  }

  async function getSession() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw cloudError(error, "The saved account session could not be read.");
    return data.session || null;
  }

  async function authenticatedSession(expectedUserId) {
    const session = await getSession();
    if (!session?.user?.id) throw new CreatineCloudError(CLOUD_ERROR_CODES.AUTH_REQUIRED, "Sign in to use cloud saving.");
    if (expectedUserId !== undefined && session.user.id !== expectedUserId) {
      throw new CreatineCloudError(CLOUD_ERROR_CODES.AUTH_REQUIRED, "The signed-in account changed. Sign in again before using cloud saving.");
    }
    return session;
  }

  async function userId(expectedUserId) {
    return (await authenticatedSession(expectedUserId)).user.id;
  }

  return {
    async signInWithEmail(email) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      if (!normalizedEmail || !normalizedEmail.includes("@")) {
        throw new CreatineCloudError(CLOUD_ERROR_CODES.REQUEST_FAILED, "Enter a valid email address.");
      }
      const { error } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: { emailRedirectTo: normalizeRedirectUrl(redirectUrl) },
      });
      if (error) throw cloudError(error, "The secure sign-in link could not be sent.");
    },

    async completeAuthCallback() {
      return getSession();
    },

    getSession,

    subscribeToSession(handler) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => handler(session || null));
      return () => data.subscription.unsubscribe();
    },

    async loadTracker(expectedUserId) {
      const id = await userId(expectedUserId);
      const [profileResult, dosesResult] = await Promise.all([
        supabase.from("tracker_profiles").select("schema_version,model_version,weight_kg,tracking_start_date,tracker_timezone,default_dose_grams").eq("user_id", id).maybeSingle(),
        supabase.from("dose_events").select("id,taken_at,timezone,grams,entry_method,client_created_at,created_at").eq("user_id", id).order("taken_at", { ascending: true }),
      ]);
      if (profileResult.error) throw cloudError(profileResult.error, "Cloud tracker settings could not be loaded.");
      if (dosesResult.error) throw cloudError(dosesResult.error, "Cloud dose history could not be loaded.");
      return {
        schemaVersion: profileResult.data?.schema_version ?? 2,
        modelVersion: profileResult.data?.model_version ?? MODEL_VERSION,
        profile: profileFromRow(profileResult.data),
        doses: (dosesResult.data || []).map(doseFromRow),
      };
    },

    async upsertProfile(profile, expectedUserId) {
      const id = await userId(expectedUserId);
      const { error } = await supabase.from("tracker_profiles").upsert(profileToRow(profile, id), { onConflict: "user_id" });
      if (error) throw cloudError(error, "Tracker settings were saved in this browser but not in the cloud.");
    },

    async upsertDose(dose, expectedUserId) {
      const id = await userId(expectedUserId);
      const { error } = await supabase.from("dose_events").upsert(doseToRow(dose, id), { onConflict: "user_id,id" });
      if (error) throw cloudError(error, "The dose was saved in this browser but not in the cloud.");
    },

    async deleteDose(doseId, expectedUserId) {
      const id = await userId(expectedUserId);
      const { error } = await supabase.from("dose_events").delete().eq("user_id", id).eq("id", doseId);
      if (error) throw cloudError(error, "The dose was removed in this browser but not from the cloud.");
    },

    async importGuestState(state, expectedUserId) {
      const id = await userId(expectedUserId);
      const prepared = await prepareGuestImport(state, cryptoImpl);
      await userId(id);
      const { data, error } = await supabase.rpc("import_creatine_guest_state_bound", {
        p_expected_user_id: id,
        ...prepared.rpcArgs,
      });
      if (error) throw cloudError(error, "The browser tracker could not be copied to this account.");
      return data;
    },

    async deleteTrackerData(expectedUserId) {
      const id = await userId(expectedUserId);
      const { data, error } = await supabase.rpc("delete_current_creatine_tracker_data_bound", {
        p_expected_user_id: id,
      });
      if (error) throw cloudError(error, "Cloud tracker data could not be deleted.");
      return data;
    },

    async deleteAccount(expectedUserId) {
      const session = await authenticatedSession(expectedUserId);
      if (!session.access_token || !fetchImpl) throw new CreatineCloudError(CLOUD_ERROR_CODES.AUTH_REQUIRED, "Sign in again before deleting this account.");
      const response = await fetchImpl("/api/creatine-account", {
        method: "DELETE",
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) throw new CreatineCloudError(CLOUD_ERROR_CODES.REQUEST_FAILED, "The account could not be deleted. Your data was not changed.");

      // HTTP 200 is the irreversible commit point. Cleanup is synchronous and
      // compare-and-clear so a newly active account can never be signed out.
      let cleanup;
      try {
        cleanup = await withAuthStorageLock(() => clearStoredSessionForUser(session.user.id));
      } catch (error) {
        cleanup = {
          skipped: false,
          error: new CreatineCloudError(
            CLOUD_ERROR_CODES.REQUEST_FAILED,
            "The account was deleted, but this browser session could not be cleared automatically.",
            error,
          ),
        };
      }
      return {
        status: "deleted",
        localSignOutError: cleanup.error,
        localSignOutSkipped: cleanup.skipped,
      };
    },

    async signOut(expectedUserId) {
      await authenticatedSession(expectedUserId);
      if (!supabase.auth.admin?.signOut) {
        throw new CreatineCloudError(CLOUD_ERROR_CODES.AUTH_REQUIRED, "Sign-out is temporarily unavailable. Reload this page and try again.");
      }
      const cleanup = await withAuthStorageLock(async () => {
        const lockedSession = storedSessionForUser(expectedUserId);
        if (!lockedSession) {
          throw new CreatineCloudError(CLOUD_ERROR_CODES.AUTH_REQUIRED, "The signed-in session changed before sign-out could finish.");
        }
        const { error } = await supabase.auth.admin.signOut(lockedSession.access_token, "local");
        if (error && ![401, 403, 404].includes(error.status)) throw cloudError(error, "Sign-out failed.");
        return clearStoredSessionForUser(expectedUserId, lockedSession.access_token);
      });
      return {
        status: "signed_out",
        localSignOutError: cleanup.error,
        localSignOutSkipped: cleanup.skipped,
      };
    },
  };
}
