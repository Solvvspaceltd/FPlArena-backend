import axios from "axios";
import { prisma } from "../utils/prisma";

/**
 * Push notifications through Expo's push service.
 *
 * Every send goes through sendOnce(), which records a (user, key) row first.
 * The unique constraint on that row is what stops a restart, an overlapping
 * cron run or a second server from sending the same alert twice.
 */

export const DEFAULT_PREFS = { deadline: true, captain: true, results: true };
export type PushKind = keyof typeof DEFAULT_PREFS;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

function mergePrefs(p: any) {
  const out: Record<string, boolean> = { ...DEFAULT_PREFS };
  if (p && typeof p === "object") {
    for (const k of Object.keys(DEFAULT_PREFS)) {
      if (typeof p[k] === "boolean") out[k] = p[k];
    }
  }
  return out as typeof DEFAULT_PREFS;
}

export async function registerDevice(userId: string, token: string, platform: string) {
  if (typeof token !== "string" || !/^Expo(nent)?PushToken\[.+\]$/.test(token)) {
    throw new Error("Not a valid push token");
  }
  // A phone can change hands between accounts; the token follows the latest.
  const existing = await prisma.pushDevice.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  const prefs = existing ? mergePrefs(existing.prefs) : DEFAULT_PREFS;
  await prisma.pushDevice.upsert({
    where: { token },
    create: { userId, token, platform: platform || "unknown", prefs: prefs as any },
    update: { userId, platform: platform || "unknown" },
  });
}

export async function removeDevice(token: string) {
  await prisma.pushDevice.deleteMany({ where: { token } });
}

export async function getPrefs(userId: string) {
  const d = await prisma.pushDevice.findFirst({ where: { userId }, orderBy: { updatedAt: "desc" } });
  return { registered: !!d, prefs: mergePrefs(d?.prefs) };
}

export async function setPrefs(userId: string, input: any) {
  const current = await getPrefs(userId);
  const next = mergePrefs({ ...current.prefs, ...(input || {}) });
  await prisma.pushDevice.updateMany({ where: { userId }, data: { prefs: next as any } });
  return next;
}

async function sendExpo(messages: any[]) {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;

  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const { data } = await axios.post(EXPO_PUSH_URL, chunk, { headers, timeout: 15000 });
      const tickets: any[] = data?.data || [];
      for (let j = 0; j < tickets.length; j++) {
        const t = tickets[j];
        if (t?.status === "error") {
          // The app was deleted or notifications revoked: stop sending there.
          if (t.details?.error === "DeviceNotRegistered") {
            await removeDevice(chunk[j].to).catch(() => null);
          } else {
            console.error("[push] ticket error", t.message || t.details?.error);
          }
        }
      }
    } catch (e: any) {
      console.error("[push] send failed", e?.message || e);
    }
  }
}

/**
 * Send a notification once per (user, key). Also writes it to the in-app
 * notifications list, so it is there even for someone with pushes turned off.
 * Returns true when this call was the one that sent it.
 */
export async function sendOnce(
  userId: string, key: string, kind: PushKind | "test",
  title: string, body: string, data: Record<string, any> = {},
) {
  try {
    await prisma.pushLog.create({ data: { userId, key } });
  } catch (e) {
    return false; // already sent
  }
  await prisma.notification.create({
    data: { userId, title, body, type: "push_" + kind, metadata: data as any },
  }).catch(() => null);

  const devices = await prisma.pushDevice.findMany({ where: { userId } });
  const targets = devices.filter((d: any) => kind === "test" || mergePrefs(d.prefs)[kind as PushKind] !== false);
  if (!targets.length) return true;
  await sendExpo(targets.map((d: any) => ({
    to: d.token, title, body, data, sound: "default", priority: "high",
  })));
  return true;
}

/** Everyone with at least one registered device. */
export async function usersWithDevices(): Promise<string[]> {
  const rows = await prisma.pushDevice.findMany({ select: { userId: true } });
  return Array.from(new Set(rows.map((r: any) => r.userId as string)));
}
