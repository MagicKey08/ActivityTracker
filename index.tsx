/*
 * ActivityTracker — kombiniertes Vencord-Plugin
 * Vereint das Voice-/Heatmap-/Timeline-Dashboard (Basis: Elioflex) mit dem
 * Profil- und Typing-Tracking des Ondra-D-Trackers. Logs liegen lokal als
 * Dateien in Vencords Datenordner, nicht in der settings.json. Nichts wird
 * irgendwohin gesendet.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { showNotification } from "@api/Notifications";
import { definePluginSettings, Settings } from "@api/Settings";
import { fetchUserProfile } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { User } from "@vencord/discord-types";
import { Button, ChannelStore, FluxDispatcher, Forms, GuildStore, Menu, Modal, openModal, PresenceStore, React, TextInput, UserProfileStore, UserStore } from "@webpack/common";

const Native = IS_DISCORD_DESKTOP
    ? VencordNative.pluginHelpers.ActivityTracker as PluginNative<typeof import("./native")>
    : null;

const LOG_TYPE_CONFIG = {
    activity: { icon: "🎮", color: "#5865F2", bgColor: "rgba(88, 101, 242, 0.1)", label: "Activity" },
    voice: { icon: "🔊", color: "#57F287", bgColor: "rgba(87, 242, 135, 0.1)", label: "Voice" },
    message: { icon: "💬", color: "#FEE75C", bgColor: "rgba(254, 231, 92, 0.1)", label: "Message" },
    status: { icon: "🟢", color: "#EB459E", bgColor: "rgba(235, 69, 158, 0.1)", label: "Status" },
    profile: { icon: "🖊", color: "#00A8FC", bgColor: "rgba(0, 168, 252, 0.1)", label: "Profile" },
    typing: { icon: "⌨️", color: "#B983FF", bgColor: "rgba(185, 131, 255, 0.1)", label: "Typing" }
};

interface Activity {
    name: string;
    type: number;
    details?: string;
    state?: string;
    timestamps?: { start?: number; end?: number; };
    application_id?: string;
    assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string; };
}

interface ProfileSnapshot {
    username?: string;
    avatar?: string | null;
    discriminator?: string;
    global_name?: string | null;
    bio?: string | null;
    banner?: string | null;
    banner_color?: string | null;
    avatarDecoration?: string | null;
    pronouns?: string | null;
    customStatus?: string | null;
}

interface ActivityLog {
    userId: string;
    username: string;
    timestamp: number;
    type: "activity" | "voice" | "message" | "status" | "profile" | "typing";
    activities?: Activity[];
    voiceChannel?: {
        channelId: string;
        channelName: string;
        action: "join" | "leave" | "move";
        guildId: string;
        guildName: string;
    };
    message?: { content: string; channelId: string; channelName?: string; guildId?: string; guildName?: string; };
    status?: { status: string; clientStatus?: any; };
    profile?: { changedFields: string[]; before?: ProfileSnapshot; after?: ProfileSnapshot; };
    typing?: { channelId: string; channelName?: string; guildId?: string; guildName?: string; };
}

let activityLogs: ActivityLog[] = [];
const MAX_PER_USER = 5000;
const MAX_MESSAGE_CONTENT = 200;
const SAVE_DEBOUNCE_MS = 400;
let trackedUserIds = new Set<string>();

const AVATAR_COLORS = ["#5865F2", "#EB459E", "#FAA61A", "#57F287", "#F23F43", "#9B59B6", "#1ABC9C", "#E91E63"];

function avatarColor(userId: string): string {
    let h = 0;
    for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function shadeColor(hex: string, amt: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
    const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
    return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

function UserAvatar({ userId, name, size }: { userId: string; name?: string; size: number; }) {
    const user = UserStore.getUser(userId);
    if (user) {
        return <img src={user.getAvatarURL(void 0, size * 2, true)} style={{ width: `${size}px`, height: `${size}px`, borderRadius: "50%", display: "block" }} alt="" />;
    }
    const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
    const base = avatarColor(userId);
    return (
        <div style={{
            width: `${size}px`, height: `${size}px`, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0, position: "relative", overflow: "hidden",
            background: `radial-gradient(circle at 30% 25%, ${shadeColor(base, 48)} 0%, ${base} 48%, ${shadeColor(base, -52)} 100%)`,
            boxShadow: `inset 0 0 0 1.5px ${base}66, inset 0 0 0 2.5px rgba(255,255,255,0.14), inset 0 -6px 10px rgba(0,0,0,0.35), 0 2px 5px rgba(0,0,0,0.4)`,
            color: "#FFFFFF", userSelect: "none"
        }}>
            <span style={{ position: "relative", zIndex: 1, fontSize: `${Math.round(size * 0.46)}px`, fontWeight: "800", letterSpacing: "0.5px", textShadow: "0 1px 3px rgba(0,0,0,0.55)", lineHeight: 1 }}>{initial}</span>
            <div style={{ position: "absolute", top: 0, left: 0, width: `${size}px`, height: `${Math.round(size * 0.42)}px`, borderRadius: "50% 50% 0 0", background: "linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.05) 100%)", pointerEvents: "none" }} />
        </div>
    );
}

function ActivityLogo({ size = 28 }: { size?: number; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" style={{ display: "block", borderRadius: "22%" }}>
            <defs>
                <linearGradient id="at-logo-bg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#7983F5" /><stop offset="55%" stopColor="#5865F2" /><stop offset="100%" stopColor="#3B45C4" />
                </linearGradient>
            </defs>
            <rect x="4" y="4" width="120" height="120" rx="30" fill="url(#at-logo-bg)" />
            <g stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round">
                <line x1="64" y1="16" x2="64" y2="28" /><line x1="64" y1="100" x2="64" y2="112" /><line x1="16" y1="64" x2="28" y2="64" /><line x1="100" y1="64" x2="112" y2="64" />
            </g>
            <path d="M24 64 Q64 32 104 64 Q64 96 24 64 Z" fill="none" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="64" cy="64" r="16" fill="#FFFFFF" /><circle cx="64" cy="64" r="8.5" fill="#3B45C4" />
        </svg>
    );
}

const processedMessageIds = new Set<string>();
const lastKnownStatus = new Map<string, string>();
const lastKnownActivities = new Map<string, string>();
const lastKnownSnapshots = new Map<string, ProfileSnapshot>();
const typingCooldowns = new Map<string, number>();

function shouldBeNative() {
    if (typeof Notification === "undefined") return false;
    const { useNative } = Settings.notifications;
    if (useNative === "always") return true;
    if (useNative === "not-focused") return !document.hasFocus();
    return false;
}

const getRichBody = (user: User, text: string | React.ReactNode) => <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
    <div style={{ position: "relative" }}>
        <img src={user.getAvatarURL(void 0, 80, true)} style={{ width: "80px", height: "80px", borderRadius: "15%" }} alt="" />
    </div>
    <span>{text}</span>
</div>;

/* ---------------- Profil-Snapshots ---------------- */

function captureSnapshot(user: any): ProfileSnapshot {
    const profile = UserProfileStore?.getUserProfile?.(user.id);
    const activities = PresenceStore.getActivities(user.id) || [];
    const customStatusActivity = activities.find((a: any) => a?.type === 4);
    return {
        username: user.username,
        avatar: user.avatar ?? null,
        discriminator: user.discriminator,
        global_name: (user as any).globalName ?? (user as any).global_name ?? null,
        bio: profile ? (profile.bio ?? null) : undefined,
        banner: profile ? ((profile as any).banner ?? user.banner ?? null) : undefined,
        banner_color: profile ? ((profile as any).bannerColor ?? (user as any).banner_color ?? null) : undefined,
        avatarDecoration: (profile as any)?.avatarDecorationData?.asset ?? (user as any).avatarDecorationData?.asset ?? null,
        pronouns: profile ? ((profile as any).pronouns ?? null) : undefined,
        customStatus: customStatusActivity?.state ?? null
    };
}

function mergeSnapshots(prev: ProfileSnapshot | undefined, cur: ProfileSnapshot): ProfileSnapshot {
    if (!prev) return cur;
    const merged: ProfileSnapshot = { ...prev };
    for (const k of Object.keys(cur) as (keyof ProfileSnapshot)[]) {
        if (cur[k] !== undefined) merged[k] = cur[k] as any;
    }
    return merged;
}

function detectChanges(prev: ProfileSnapshot, cur: ProfileSnapshot): string[] {
    const changes: string[] = [];
    const keys: (keyof ProfileSnapshot)[] = ["username", "avatar", "discriminator", "global_name", "avatarDecoration", "bio", "banner", "banner_color", "pronouns", "customStatus"];
    for (const key of keys) {
        if (prev[key] !== undefined && cur[key] !== undefined && prev[key] !== cur[key]) {
            changes.push(key === "global_name" ? "display_name" : key);
        }
    }
    return changes;
}

function profileChangeLabel(field: string): string {
    const labels: Record<string, string> = {
        username: "Username", avatar: "Avatar", discriminator: "Discriminator", display_name: "Display Name",
        global_name: "Display Name", bio: "Bio", banner: "Banner", banner_color: "Banner Color",
        avatarDecoration: "Avatar Decoration", pronouns: "Pronouns", customStatus: "Custom Status"
    };
    return labels[field] ?? field;
}

/* ---------------- Speicherung (Dateien statt settings.json) ---------------- */

const logsKey = (id: string) => `at-logs-${id}`;

async function readUserFile(userId: string): Promise<ActivityLog[]> {
    try {
        if (Native) {
            const raw = await Native.readUserLogs(userId);
            return raw ? JSON.parse(raw) : [];
        }
        return (await DataStore.get(logsKey(userId))) as ActivityLog[] ?? [];
    } catch (e) {
        console.error("[ActivityTracker] read failed for", userId, e);
        return [];
    }
}

function retentionCutoff(): number {
    const days = settings.store.retentionDays;
    if (!days || days <= 0) return 0;
    return Date.now() - days * 86400000;
}

async function writeUserFile(userId: string) {
    const cutoff = retentionCutoff();
    let logs = activityLogs.filter(l => l.userId === userId);
    if (cutoff) logs = logs.filter(l => l.timestamp >= cutoff);
    if (logs.length > MAX_PER_USER) logs = logs.slice(-MAX_PER_USER);
    try {
        const json = JSON.stringify(logs);
        if (Native) await Native.writeUserLogs(userId, json);
        else await DataStore.set(logsKey(userId), logs);
    } catch (e) {
        console.error("[ActivityTracker] write failed for", userId, e);
    }
}

function saveMeta() {
    try {
        settings.store.trackedUsers = JSON.stringify(Array.from(trackedUserIds));
        settings.store.lastStatuses = JSON.stringify(Object.fromEntries(lastKnownStatus));
        settings.store.profileSnapshots = JSON.stringify(Object.fromEntries(lastKnownSnapshots));
    } catch (e) {
        console.error("[ActivityTracker] saveMeta failed:", e);
    }
}

const dirtyUsers = new Set<string>();
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function scheduleSave() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

function flushSave() {
    if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
    saveMeta();
    const users = Array.from(dirtyUsers);
    dirtyUsers.clear();
    for (const id of users) void writeUserFile(id);
}

function addLog(log: ActivityLog) {
    activityLogs.push(log);
    // In-Memory-Deckel pro Benutzer, damit die Sitzung nicht unbegrenzt wächst
    const forUser = activityLogs.filter(l => l.userId === log.userId);
    if (forUser.length > MAX_PER_USER) {
        const drop = forUser[0];
        const i = activityLogs.indexOf(drop);
        if (i !== -1) activityLogs.splice(i, 1);
    }
    dirtyUsers.add(log.userId);
    scheduleSave();
}

async function loadAll() {
    try {
        if (settings.store.trackedUsers) trackedUserIds = new Set(JSON.parse(settings.store.trackedUsers));
        if (settings.store.lastStatuses) {
            lastKnownStatus.clear();
            for (const [id, s] of Object.entries(JSON.parse(settings.store.lastStatuses))) lastKnownStatus.set(id, s as string);
        }
        if (settings.store.profileSnapshots) {
            lastKnownSnapshots.clear();
            for (const [id, s] of Object.entries(JSON.parse(settings.store.profileSnapshots))) lastKnownSnapshots.set(id, s as ProfileSnapshot);
        }
    } catch (e) {
        console.error("[ActivityTracker] loadAll meta failed:", e);
    }

    const cutoff = retentionCutoff();
    const all: ActivityLog[] = [];
    for (const id of trackedUserIds) {
        const logs = await readUserFile(id);
        for (const l of logs) if (!cutoff || l.timestamp >= cutoff) all.push(l);
    }
    all.sort((a, b) => a.timestamp - b.timestamp);
    activityLogs = all;
    console.log("[ActivityTracker] loaded", activityLogs.length, "logs for", trackedUserIds.size, "users");
}

async function clearAllData() {
    activityLogs.length = 0;
    lastKnownStatus.clear();
    lastKnownActivities.clear();
    lastKnownSnapshots.clear();
    dirtyUsers.clear();
    try {
        if (Native) await Native.deleteAllLogs();
        else for (const id of trackedUserIds) await DataStore.del(logsKey(id));
    } catch { }
    trackedUserIds.clear();
    saveMeta();
}

async function startTracking(userId: string) {
    trackedUserIds.add(userId);
    // bereits gespeicherte Historie dieses Users in den Speicher holen
    const existing = await readUserFile(userId);
    if (existing.length) {
        const have = new Set(activityLogs.filter(l => l.userId === userId).map(l => l.timestamp + ":" + l.type));
        for (const l of existing) if (!have.has(l.timestamp + ":" + l.type)) activityLogs.push(l);
        activityLogs.sort((a, b) => a.timestamp - b.timestamp);
    }
    // Baseline-Snapshot fürs Profil-Tracking anlegen
    try {
        if (!lastKnownSnapshots.has(userId)) {
            await fetchUserProfile(userId);
            await new Promise(r => setTimeout(r, 600));
            const u = UserStore.getUser(userId);
            if (u) lastKnownSnapshots.set(userId, captureSnapshot(u));
        }
    } catch { }
    saveMeta();
}

function stopTracking(userId: string) {
    trackedUserIds.delete(userId);
    saveMeta();
}

window.addEventListener("beforeunload", flushSave);

const settings = definePluginSettings({
    logMessages: { type: OptionType.BOOLEAN, description: "Nachrichten der getrackten Leute mitschreiben", default: true },
    logProfile: { type: OptionType.BOOLEAN, description: "Profiländerungen mitschreiben (Avatar, Banner, Name, Bio, Pronomen, Custom Status)", default: true },
    logTyping: { type: OptionType.BOOLEAN, description: "Tippen mitschreiben", default: false },
    notifyStatus: { type: OptionType.BOOLEAN, description: "Benachrichtigung bei Statuswechsel", default: false },
    notifyVoice: { type: OptionType.BOOLEAN, description: "Benachrichtigung bei Voice-Channel-Wechsel", default: false },
    notifyProfile: { type: OptionType.BOOLEAN, description: "Benachrichtigung bei Profiländerungen", default: false },
    notifyTyping: { type: OptionType.BOOLEAN, description: "Benachrichtigung beim Tippen", default: false },
    persistNotifications: { type: OptionType.BOOLEAN, description: "Benachrichtigungen im Verlauf behalten", default: false },
    retentionDays: { type: OptionType.NUMBER, description: "Verlauf wie viele Tage aufbewahren (0 = alles behalten)", default: 30 },
    trackedUsers: { type: OptionType.STRING, description: "intern", default: "", hidden: true },
    lastStatuses: { type: OptionType.STRING, description: "intern", default: "{}", hidden: true },
    profileSnapshots: { type: OptionType.STRING, description: "intern", default: "{}", hidden: true }
});

const TYPE_FILTERS: Array<{ id: "all" | ActivityLog["type"]; label: string; icon: string; }> = [
    { id: "all", label: "All", icon: "📋" },
    { id: "activity", label: "Activity", icon: "🎮" },
    { id: "voice", label: "Voice", icon: "🔊" },
    { id: "message", label: "Message", icon: "💬" },
    { id: "status", label: "Status", icon: "🟢" },
    { id: "profile", label: "Profile", icon: "🖊" },
    { id: "typing", label: "Typing", icon: "⌨️" }
];

function formatRelativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
}

function downloadText(filename: string, text: string, mime = "text/plain") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
}

function exportJSON(logs: ActivityLog[]) {
    downloadText(`activity-logs-${Date.now()}.json`, JSON.stringify(logs, null, 2), "application/json");
}

interface Stats {
    totalLogs: number;
    messageCount: number;
    activityCount: number;
    voiceCount: number;
    statusCount: number;
    profileCount: number;
    typingCount: number;
    totalVoiceMinutes: number;
    heatmapData: Record<string, number>;
}

function calculateStats(logs: ActivityLog[]): Stats {
    let messageCount = 0, activityCount = 0, voiceCount = 0, statusCount = 0, profileCount = 0, typingCount = 0;
    const heatmapData: Record<string, number> = {};
    let totalVoiceMinutes = 0;
    let lastJoinTime: number | null = null;

    for (const log of logs) {
        if (log.type === "message") messageCount++;
        else if (log.type === "activity") activityCount++;
        else if (log.type === "voice") voiceCount++;
        else if (log.type === "status") statusCount++;
        else if (log.type === "profile") profileCount++;
        else if (log.type === "typing") typingCount++;

        const date = new Date(log.timestamp);
        const hour = date.getHours();
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${hour}`;
        heatmapData[key] = (heatmapData[key] ?? 0) + 1;

        if (log.type === "voice" && log.voiceChannel) {
            if (log.voiceChannel.action === "join") lastJoinTime = log.timestamp;
            else if (log.voiceChannel.action === "leave" && lastJoinTime !== null) {
                totalVoiceMinutes += (log.timestamp - lastJoinTime) / 60000;
                lastJoinTime = null;
            }
        }
    }

    return { totalLogs: logs.length, messageCount, activityCount, voiceCount, statusCount, profileCount, typingCount, totalVoiceMinutes: Math.round(totalVoiceMinutes), heatmapData };
}

function StatTile({ label, value, color, icon }: { label: string; value: number | string; color: string; icon?: string; }) {
    return (
        <div style={{ flex: 1, minWidth: "72px", background: `linear-gradient(135deg, ${color}12 0%, ${color}04 100%)`, border: `1px solid ${color}28`, padding: "12px 8px", borderRadius: "12px", textAlign: "center" }}>
            <div style={{ fontSize: "20px", lineHeight: 1, marginBottom: "4px" }}>{icon}</div>
            <div style={{ fontSize: "22px", fontWeight: "800", color, lineHeight: 1.2 }}>{value}</div>
            <div style={{ fontSize: "9px", color: "var(--text-muted)", marginTop: "5px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>{label}</div>
        </div>
    );
}

interface VoiceSession {
    userId: string;
    username: string;
    startedAt: number;
    endedAt: number | null;
    durationMs: number;
    channelName: string;
    guildName?: string;
    channelId: string;
}

type TimelineEntry = { kind: "log"; log: ActivityLog; } | { kind: "session"; session: VoiceSession; };

function pairVoiceSessions(userLogs: ActivityLog[]): TimelineEntry[] {
    const sorted = [...userLogs].sort((a, b) => a.timestamp - b.timestamp);
    const openSessions = new Map<string, { startedAt: number; username: string; channelName: string; guildName?: string; channelId: string; }>();
    const entries: TimelineEntry[] = [];

    const closeSession = (userId: string, endedAt: number) => {
        const open = openSessions.get(userId);
        if (!open) return;
        openSessions.delete(userId);
        entries.push({ kind: "session", session: { userId, username: open.username, startedAt: open.startedAt, endedAt, durationMs: endedAt - open.startedAt, channelName: open.channelName, guildName: open.guildName, channelId: open.channelId } });
    };

    for (const log of sorted) {
        if (log.type !== "voice" || !log.voiceChannel) { entries.push({ kind: "log", log }); continue; }
        const vc = log.voiceChannel;
        if (vc.action === "join" || vc.action === "move") {
            closeSession(log.userId, log.timestamp);
            openSessions.set(log.userId, { startedAt: log.timestamp, username: log.username, channelName: vc.channelName, guildName: vc.guildName, channelId: vc.channelId });
        } else if (vc.action === "leave") closeSession(log.userId, log.timestamp);
    }

    for (const [userId, open] of openSessions) {
        entries.push({ kind: "session", session: { userId, username: open.username, startedAt: open.startedAt, endedAt: null, durationMs: Date.now() - open.startedAt, channelName: open.channelName, guildName: open.guildName, channelId: open.channelId } });
    }
    openSessions.clear();

    return entries.sort((a, b) => {
        const ta = a.kind === "log" ? a.log.timestamp : a.session.startedAt;
        const tb = b.kind === "log" ? b.log.timestamp : b.session.startedAt;
        return ta - tb;
    });
}

function formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return `${Math.max(1, Math.floor(ms / 1000))}s`;
}

function channelColor(name: string): string {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 65% 60%)`;
}

function formatClock(ts: number): string {
    const d = new Date(ts);
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m} ${ampm}`;
}

function VoiceSessionEntry({ session }: { session: VoiceSession; }) {
    const ongoing = session.endedAt === null;
    return (
        <div style={{ background: "var(--background-secondary)", border: "1px solid var(--background-modifier-accent)", borderLeft: `3px solid ${LOG_TYPE_CONFIG.voice.color}`, padding: "10px 12px", borderRadius: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                <span style={{ fontSize: "15px" }}>🎙</span>
                <strong style={{ color: "var(--header-primary)", fontSize: "13px" }}>{session.username}</strong>
                <span style={{ color: LOG_TYPE_CONFIG.voice.color, fontSize: "10px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>{ongoing ? "Live" : "Voice Session"}</span>
                <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--text-muted)" }}>{formatRelativeTime(session.startedAt)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", marginTop: "8px", background: LOG_TYPE_CONFIG.voice.bgColor, padding: "10px 12px", borderRadius: "8px" }}>
                {ongoing
                    ? <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", color: "#23A55A", fontWeight: "700", fontSize: "12px" }}><span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#23A55A", animation: "at-pulse 1.2s infinite" }} />LIVE</span>
                    : <span style={{ fontWeight: "800", color: "var(--header-primary)" }}>{formatDuration(session.durationMs)}</span>}
                <span style={{ color: "var(--text-normal)" }}>in “{session.channelName}”</span>
                {session.guildName && session.guildName !== "unknown" && <span style={{ color: "var(--text-muted)" }}>• {session.guildName}</span>}
            </div>
            <style>{"@keyframes at-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }"}</style>
        </div>
    );
}

function LogEntry({ log }: { log: ActivityLog; }) {
    const config = LOG_TYPE_CONFIG[log.type];
    const user = UserStore.getUser(log.userId);

    return (
        <div style={{ background: "var(--background-secondary)", border: "1px solid var(--background-modifier-accent)", borderLeft: `3px solid ${config.color}`, padding: "10px 12px", borderRadius: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
                {user && <img src={user.getAvatarURL(void 0, 32, true)} style={{ width: "24px", height: "24px", borderRadius: "50%" }} alt="" />}
                <span style={{ fontSize: "15px" }}>{config.icon}</span>
                <strong style={{ color: "var(--header-primary)", fontSize: "13px" }}>{log.username}</strong>
                <span style={{ color: config.color, fontSize: "10px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>{config.label}</span>
                <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--text-muted)" }}>{formatRelativeTime(log.timestamp)}</span>
            </div>
            {log.type === "activity" && log.activities && (
                <div style={{ fontSize: "13px", marginTop: "8px", background: config.bgColor, padding: "10px 12px", borderRadius: "8px" }}>
                    {log.activities.map((a, i) => (
                        <div key={i} style={{ marginBottom: i < log.activities!.length - 1 ? "6px" : 0 }}>
                            <span style={{ fontSize: "15px" }}>{a.type === 2 ? "🎧" : a.type === 1 ? "🎮" : a.type === 3 ? "📺" : "✨"}</span>{" "}
                            <strong style={{ color: "var(--header-primary)" }}>{a.name}</strong>
                            {a.details && <span style={{ color: "var(--text-muted)" }}> — {a.details}</span>}
                            {a.state && <div style={{ color: "var(--text-muted)", marginTop: "2px" }}>{a.state}</div>}
                        </div>
                    ))}
                </div>
            )}
            {log.type === "voice" && log.voiceChannel && (
                <div style={{ fontSize: "13px", marginTop: "8px", background: config.bgColor, padding: "10px 12px", borderRadius: "8px" }}>
                    <span style={{ fontSize: "15px" }}>{log.voiceChannel.action === "join" ? "🔊" : log.voiceChannel.action === "leave" ? "🔇" : "🔄"}</span>{" "}
                    <strong style={{ color: config.color }}>{log.voiceChannel.action.toUpperCase()}</strong>{" "}
                    <span style={{ color: "var(--text-normal)" }}>{log.voiceChannel.channelName}</span>
                    {log.voiceChannel.guildName && <span style={{ color: "var(--text-muted)" }}> • {log.voiceChannel.guildName}</span>}
                </div>
            )}
            {log.type === "message" && log.message && (
                <div style={{ fontSize: "13px", marginTop: "8px", background: config.bgColor, padding: "10px 12px", borderRadius: "8px" }}>
                    <div style={{ color: "var(--text-muted)", marginBottom: "2px" }}>{log.message.channelName || "Unknown channel"}{log.message.guildName ? ` • ${log.message.guildName}` : ""}</div>
                    <div style={{ color: "var(--text-normal)" }}>“{log.message.content}”</div>
                </div>
            )}
            {log.type === "status" && log.status && (
                <div style={{ fontSize: "13px", marginTop: "8px", background: config.bgColor, padding: "10px 12px", borderRadius: "8px" }}>
                    <span style={{ fontSize: "15px" }}>{log.status.status === "online" ? "🟢" : log.status.status === "idle" ? "🌙" : log.status.status === "dnd" ? "🔴" : "⚪"}</span>{" "}
                    Status changed to <strong style={{ color: config.color }}>{log.status.status.toUpperCase()}</strong>
                </div>
            )}
            {log.type === "profile" && log.profile && (
                <div style={{ fontSize: "13px", marginTop: "8px", background: config.bgColor, padding: "10px 12px", borderRadius: "8px" }}>
                    <div style={{ marginBottom: "4px", color: "var(--text-normal)" }}>
                        Updated {log.profile.changedFields.map(f => profileChangeLabel(f)).join(", ")}
                    </div>
                    {log.profile.changedFields.filter(f => ["username", "display_name", "bio", "pronouns", "customStatus"].includes(f)).map(f => {
                        const key = (f === "display_name" ? "global_name" : f) as keyof ProfileSnapshot;
                        const before = log.profile!.before?.[key];
                        const after = log.profile!.after?.[key];
                        return (
                            <div key={f} style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
                                <strong style={{ color: "var(--header-primary)" }}>{profileChangeLabel(f)}:</strong>{" "}
                                <span style={{ textDecoration: "line-through", opacity: 0.7 }}>{String(before ?? "—")}</span>{" → "}
                                <span style={{ color: "var(--text-normal)" }}>{String(after ?? "—")}</span>
                            </div>
                        );
                    })}
                </div>
            )}
            {log.type === "typing" && log.typing && (
                <div style={{ fontSize: "13px", marginTop: "8px", background: config.bgColor, padding: "10px 12px", borderRadius: "8px" }}>
                    <span style={{ fontSize: "15px" }}>⌨️</span>{" "}
                    started typing <span style={{ color: "var(--text-normal)" }}>{log.typing.channelName ? `in ${log.typing.channelName}` : ""}</span>
                    {log.typing.guildName && <span style={{ color: "var(--text-muted)" }}> • {log.typing.guildName}</span>}
                </div>
            )}
        </div>
    );
}

function VoiceTimeByServer({ sessions }: { sessions: VoiceSession[]; }) {
    const byServer = React.useMemo(() => {
        const servers = new Map<string, Map<string, number>>();
        for (const s of sessions) {
            const server = s.guildName && s.guildName !== "unknown" ? s.guildName : "Unknown Server";
            if (!servers.has(server)) servers.set(server, new Map());
            const channels = servers.get(server)!;
            channels.set(s.channelName, (channels.get(s.channelName) || 0) + s.durationMs);
        }
        return [...servers.entries()].map(([server, chans]) => ({
            server,
            totalMs: [...chans.values()].reduce((a, b) => a + b, 0),
            channels: [...chans.entries()].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms)
        })).sort((a, b) => b.totalMs - a.totalMs);
    }, [sessions]);

    if (byServer.length === 0) return null;
    const max = byServer[0].totalMs;

    return (
        <div style={{ background: "var(--background-secondary)", border: "1px solid var(--background-modifier-accent)", padding: "14px", borderRadius: "12px" }}>
            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "10px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>🎙 Voice Time by Server</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {byServer.map(s => (
                    <div key={s.server}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <div style={{ width: "130px", fontSize: "12px", color: "var(--text-normal)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: "700" }}>{s.server}</div>
                            <div style={{ flex: 1, background: "var(--background-tertiary)", borderRadius: "4px", height: "16px", overflow: "hidden" }}>
                                <div style={{ width: `${max > 0 ? (s.totalMs / max) * 100 : 0}%`, height: "100%", background: "linear-gradient(90deg, #5865F2, #7983F5)", borderRadius: "4px", minWidth: s.totalMs > 0 ? "6px" : 0 }} />
                            </div>
                            <div style={{ width: "62px", fontSize: "12px", color: "var(--header-primary)", fontWeight: "700", textAlign: "right" }}>{formatDuration(s.totalMs)}</div>
                        </div>
                        {s.channels.length > 0 && (
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", margin: "5px 0 0 138px" }}>
                                {s.channels.slice(0, 6).map(ch => (
                                    <span key={ch.name} title={`${ch.name} — ${formatDuration(ch.ms)}`} style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "10px", color: "var(--text-muted)", background: "var(--background-tertiary)", padding: "2px 8px", borderRadius: "999px", border: `1px solid ${channelColor(ch.name)}40` }}>
                                        <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: channelColor(ch.name) }} />
                                        {ch.name} · {formatDuration(ch.ms)}
                                    </span>
                                ))}
                                {s.channels.length > 6 && <span style={{ fontSize: "10px", color: "var(--text-muted)", padding: "2px 4px" }}>+{s.channels.length - 6} more</span>}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function WeekHeatmap({ heatmapData, sessions }: { heatmapData: Record<string, number>; sessions: VoiceSession[]; }) {
    const [weekOffset, setWeekOffset] = React.useState(0);
    const [hoverTip, setHoverTip] = React.useState<{ text: string; x: number; y: number; } | null>(null);
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const anchor = new Date(today);
    anchor.setDate(anchor.getDate() - weekOffset * 7);
    const sunday = new Date(anchor);
    sunday.setDate(anchor.getDate() - anchor.getDay());

    const days: Date[] = [...Array(7)].map((_, i) => { const d = new Date(sunday); d.setDate(sunday.getDate() + i); return d; });
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const max = Math.max(...Object.values(heatmapData), 0);
    const isCurrentWeek = weekOffset === 0;
    const weekLabel = `week of ${MONTHS[days[0].getMonth()]} ${days[0].getDate()}`;
    const channels = React.useMemo(() => [...new Set(sessions.map(s => s.channelName))], [sessions]);

    const sessionsInHour = (day: Date, hour: number): VoiceSession[] => {
        const start = day.getTime() + hour * 3600e3;
        const end = start + 3600e3;
        return sessions.filter(s => { const sEnd = s.endedAt ?? Date.now(); return s.startedAt < end && sEnd > start; });
    };

    const hourTooltip = (d: Date, hour: number, count: number): string => {
        const hourStart = d.getTime() + hour * 3600e3;
        const hourEnd = hourStart + 3600e3;
        const lines = [`${DAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()} ${String(hour).padStart(2, "0")}:00`];
        if (count > 0) lines.push(`${count} event${count !== 1 ? "s" : ""}`);
        for (const s of sessionsInHour(d, hour)) {
            const sEnd = s.endedAt ?? Date.now();
            const winStart = Math.max(s.startedAt, hourStart);
            const winEnd = Math.min(sEnd, hourEnd);
            const server = s.guildName && s.guildName !== "unknown" ? s.guildName : "Unknown Server";
            lines.push(`🎙 ${s.channelName} (${server}) — ${formatClock(winStart)} – ${formatClock(winEnd)} (${formatDuration(Math.max(0, winEnd - winStart))})${s.endedAt === null ? " • LIVE" : ""}`);
        }
        return lines.join("\n");
    };

    return (
        <div style={{ background: "var(--background-secondary)", border: "1px solid var(--background-modifier-accent)", padding: "14px", borderRadius: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px", flexWrap: "wrap", gap: "6px" }}>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>🌡 Activity Heatmap</div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    {!isCurrentWeek && <Button size={Button.Sizes.MIN} color={Button.Colors.PRIMARY} onClick={() => setWeekOffset(0)}>Today</Button>}
                    <Button size={Button.Sizes.MIN} color={Button.Colors.PRIMARY} onClick={() => setWeekOffset(o => o + 1)}>◀</Button>
                    <span style={{ fontSize: "12px", color: "var(--header-primary)", fontWeight: "700", minWidth: "104px", textAlign: "center" }}>{weekLabel}</span>
                    <Button size={Button.Sizes.MIN} color={Button.Colors.PRIMARY} disabled={isCurrentWeek} onClick={() => setWeekOffset(o => Math.max(0, o - 1))}>▶</Button>
                </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "46px repeat(24, 1fr)", gap: "2px" }}>
                <div />
                {[...Array(24)].map((_, h) => <div key={h} style={{ textAlign: "center", fontSize: "8px", color: "var(--text-muted)", fontWeight: "600" }}>{h % 6 === 0 ? h : ""}</div>)}
            </div>
            {days.map((d, i) => {
                const prev = days[i - 1];
                const isNewMonth = !prev || prev.getMonth() !== d.getMonth();
                const isToday = d.getTime() === today.getTime();
                return (
                    <div key={i} style={{ display: "grid", gridTemplateColumns: "46px repeat(24, 1fr)", gap: "2px", marginTop: "2px" }}>
                        <div style={{ fontSize: "9px", color: "var(--text-muted)", display: "flex", alignItems: "center", fontWeight: "600", gap: "3px", whiteSpace: "nowrap", overflow: "hidden" }}>
                            {isNewMonth && <span style={{ color: "var(--header-primary)", fontWeight: "800" }}>{MONTHS[d.getMonth()]}</span>}
                            <span>{DAYS[d.getDay()]}</span>
                            <span style={{ opacity: 0.8 }}>{d.getMonth() + 1}/{d.getDate()}</span>
                        </div>
                        {[...Array(24)].map((_, hour) => {
                            const count = heatmapData[`${dayKey(d)}-${hour}`] || 0;
                            const intensity = max > 0 ? count / max : 0;
                            const inChannels = sessionsInHour(d, hour).slice(0, 5);
                            return (
                                <div key={hour}
                                    style={{ position: "relative", background: count > 0 ? `rgba(88, 101, 242, ${0.15 + intensity * 0.85})` : "var(--background-tertiary)", aspectRatio: "1", borderRadius: "3px", cursor: "default", outline: isToday ? "1px solid var(--text-normal)" : "none", transition: "transform 0.1s ease" }}
                                    onMouseEnter={e => {
                                        e.currentTarget.style.transform = "scale(1.2)";
                                        const r = e.currentTarget.getBoundingClientRect();
                                        const clampX = Math.max(190, Math.min(r.left + r.width / 2, window.innerWidth - 190));
                                        setHoverTip({ text: hourTooltip(d, hour, count), x: clampX, y: r.top - 8 });
                                    }}
                                    onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; setHoverTip(null); }}
                                >
                                    {inChannels.length > 0 && (() => {
                                        const hourStart = d.getTime() + hour * 3600e3;
                                        const hourEnd = hourStart + 3600e3;
                                        return (
                                            <div style={{ position: "absolute", left: 1, right: 1, bottom: 1, display: "flex", flexDirection: "column", gap: "1px" }}>
                                                {inChannels.map((s, li) => {
                                                    const sEnd = s.endedAt ?? Date.now();
                                                    const frac = Math.min(1, Math.max(0, (Math.min(sEnd, hourEnd) - Math.max(s.startedAt, hourStart)) / 3600e3));
                                                    return <div key={li} style={{ height: Math.max(1, 1 + frac * 4) + "px", background: channelColor(s.channelName), borderRadius: "1px", opacity: s.endedAt === null ? 1 : (0.4 + frac * 0.6) }} />;
                                                })}
                                            </div>
                                        );
                                    })()}
                                </div>
                            );
                        })}
                    </div>
                );
            })}
            {channels.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "9px", color: "var(--text-muted)", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>▬ voice</span>
                    {channels.slice(0, 6).map(ch => (
                        <span key={ch} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "10px", color: "var(--text-muted)" }}>
                            <span style={{ width: "9px", height: "4px", borderRadius: "1px", background: channelColor(ch) }} />{ch}
                        </span>
                    ))}
                    {channels.length > 6 && <span style={{ fontSize: "10px", color: "var(--text-muted)" }}>+{channels.length - 6}</span>}
                </div>
            )}
            {hoverTip && (
                <div style={{ position: "fixed", left: hoverTip.x, top: hoverTip.y, transform: "translate(-50%, -100%)", background: "var(--background-floating)", border: "1px solid var(--background-modifier-accent)", borderRadius: "8px", padding: "8px 10px", fontSize: "11px", color: "var(--header-primary)", whiteSpace: "pre-line", boxShadow: "0 4px 16px rgba(0,0,0,0.4)", zIndex: 9999, pointerEvents: "none", maxWidth: "340px", width: "max-content" }}>{hoverTip.text}</div>
            )}
        </div>
    );
}

function UserProfile({ userId, logs }: { userId: string; logs: ActivityLog[]; }) {
    const userLogs = React.useMemo(() => logs.filter(l => l.userId === userId), [logs, userId]);
    const user = UserStore.getUser(userId);
    const isTracked = trackedUserIds.has(userId);
    const [, force] = React.useReducer(x => x + 1, 0);

    const [presence, setPresence] = React.useState<{ status: string; activities: any[]; }>({ status: "offline", activities: [] });
    React.useEffect(() => {
        const update = () => setPresence({ status: PresenceStore.getStatus(userId) || "offline", activities: (PresenceStore.getActivities(userId) || []) as any[] });
        update();
        FluxDispatcher.subscribe("PRESENCE_UPDATES", update);
        return () => FluxDispatcher.unsubscribe("PRESENCE_UPDATES", update);
    }, [userId]);

    const [typeFilter, setTypeFilter] = React.useState<"all" | ActivityLog["type"]>("all");
    const stats = React.useMemo(() => calculateStats(userLogs), [userLogs]);
    const voiceSessions = React.useMemo(() => pairVoiceSessions(userLogs).filter(e => e.kind === "session").map(e => (e as any).session as VoiceSession), [userLogs]);

    const visibleLogs = React.useMemo(() => {
        const paired = pairVoiceSessions(userLogs);
        const filtered = typeFilter === "all" ? paired : paired.filter(e => {
            if (typeFilter === "voice") return e.kind === "session";
            return e.kind === "log" && e.log.type === typeFilter;
        });
        return filtered.slice(-80).reverse();
    }, [userLogs, typeFilter]);

    const statusColor = presence.status === "online" ? "#23A55A" : presence.status === "idle" ? "#F0B232" : presence.status === "dnd" ? "#F23F43" : "#80848E";
    const statusIcon = presence.status === "online" ? "🟢" : presence.status === "idle" ? "🌙" : presence.status === "dnd" ? "🔴" : "⚪";
    const mainActivity = presence.activities.find(a => a.type !== 4) || presence.activities[0];

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", background: "linear-gradient(135deg, #5865F212 0%, #5865F204 100%)", border: "1px solid #5865F228", borderRadius: "14px", padding: "14px 16px" }}>
                <div style={{ position: "relative" }}>
                    <UserAvatar userId={userId} name={userLogs[0]?.username} size={60} />
                    <div style={{ position: "absolute", bottom: 2, right: 2, width: "17px", height: "17px", borderRadius: "50%", background: statusColor, border: "3px solid var(--background-secondary)" }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                        <span style={{ fontSize: "17px", fontWeight: "800", color: "var(--header-primary)" }}>{user?.globalName || user?.username || userLogs[0]?.username || "Unknown user"}</span>
                        {isTracked && <span style={{ fontSize: "10px", fontWeight: "700", padding: "2px 8px", borderRadius: "999px", background: "#23A55A20", color: "#23A55A", border: "1px solid #23A55A40" }}>TRACKING</span>}
                    </div>
                    <div style={{ fontSize: "13px", color: "var(--text-muted)" }}>{user?.username ? `@${user.username}` : userLogs[0]?.username ? `@${userLogs[0].username}` : ""} <span style={{ fontFamily: "monospace", fontSize: "11px" }}>• {userId}</span></div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "5px" }}>
                        <span style={{ fontSize: "13px" }}>{statusIcon}</span>
                        <span style={{ fontSize: "13px", fontWeight: "600", color: statusColor, textTransform: "capitalize" }}>{presence.status === "dnd" ? "Do Not Disturb" : presence.status}</span>
                        {mainActivity && <span style={{ fontSize: "12px", color: "var(--text-normal)", marginLeft: "2px" }}>— {mainActivity.name}{mainActivity.details ? `: ${mainActivity.details}` : ""}</span>}
                    </div>
                </div>
                <Button size={Button.Sizes.SMALL} color={isTracked ? Button.Colors.RED : Button.Colors.GREEN}
                    onClick={() => { if (isTracked) stopTracking(userId); else void startTracking(userId).then(force); force(); }}>
                    {isTracked ? "⏹ Stop" : "▶ Track"}
                </Button>
            </div>

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <StatTile label="Messages" value={stats.messageCount} color="#FEE75C" icon="💬" />
                <StatTile label="Activities" value={stats.activityCount} color="#5865F2" icon="🎮" />
                <StatTile label="Voice" value={stats.voiceCount} color="#57F287" icon="🔊" />
                <StatTile label="Status" value={stats.statusCount} color="#EB459E" icon="🟢" />
                <StatTile label="Profile" value={stats.profileCount} color="#00A8FC" icon="🖊" />
                <StatTile label="Voice Time" value={`${Math.floor(stats.totalVoiceMinutes / 60)}h ${stats.totalVoiceMinutes % 60}m`} color="#F0B232" icon="🎙" />
            </div>

            {voiceSessions.length > 0 && <VoiceTimeByServer sessions={voiceSessions} />}
            <WeekHeatmap heatmapData={stats.heatmapData} sessions={voiceSessions} />

            <div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px" }}>📜 Timeline ({visibleLogs.length})</span>
                    <div style={{ display: "flex", gap: "4px", marginLeft: "auto", flexWrap: "wrap" }}>
                        {TYPE_FILTERS.map(f => <Button key={f.id} size={Button.Sizes.MIN} color={typeFilter === f.id ? Button.Colors.BRAND : Button.Colors.PRIMARY} onClick={() => setTypeFilter(f.id)}>{f.icon} {f.label}</Button>)}
                    </div>
                </div>
                {visibleLogs.length === 0 ? (
                    <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>No activity recorded for this user yet</div>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {visibleLogs.map((entry, idx) => entry.kind === "session" ? <VoiceSessionEntry key={idx} session={entry.session} /> : <LogEntry key={idx} log={entry.log} />)}
                    </div>
                )}
            </div>
        </div>
    );
}

function ActivityDashboard({ modalProps }: { modalProps: any; }) {
    const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
    const [search, setSearch] = React.useState("");
    const [tick, setTick] = React.useState(0);
    React.useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 2000); return () => clearInterval(id); }, []);
    const liveLogs = React.useMemo(() => activityLogs.slice(), [tick]);

    const uniqueUsers = React.useMemo(() => {
        const map = new Map<string, string>();
        for (const log of liveLogs) if (!map.has(log.userId)) map.set(log.userId, log.username);
        for (const id of trackedUserIds) if (!map.has(id)) { const u = UserStore.getUser(id); map.set(id, u?.username || id); }
        return Array.from(map, ([id, username]) => ({ id, username }));
    }, [liveLogs]);

    const trackedUsers = uniqueUsers.filter(u => trackedUserIds.has(u.id));
    const recentUsers = uniqueUsers.filter(u => !trackedUserIds.has(u.id));
    const q = search.trim().toLowerCase();
    const filteredTracked = trackedUsers.filter(u => !q || u.username.toLowerCase().includes(q) || u.id === q);
    const filteredRecent = recentUsers.filter(u => !q || u.username.toLowerCase().includes(q) || u.id === q);
    const selectedUser = selectedUserId ? uniqueUsers.find(u => u.id === selectedUserId) : null;

    const header = (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", paddingRight: "40px", paddingBottom: "12px", borderBottom: "1px solid var(--background-modifier-accent)" }}>
            <div>
                <Forms.FormTitle tag="h2" style={{ margin: 0, display: "flex", alignItems: "center", gap: "8px" }}><ActivityLogo size={26} /> Activity Tracker</Forms.FormTitle>
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "4px", fontWeight: "500" }}>{activityLogs.length} total logs • {trackedUserIds.size} tracked users</div>
            </div>
            <div style={{ display: "flex", gap: "6px" }}>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => exportJSON(activityLogs)}>⬇ Export</Button>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => { void clearAllData(); setSelectedUserId(null); }}>🗑 Clear all</Button>
            </div>
        </div>
    );

    const SidebarRow = ({ userId, username, tracked }: { userId: string; username: string; tracked: boolean; }) => {
        const [presence, setPresence] = React.useState("offline");
        React.useEffect(() => {
            const update = () => setPresence(PresenceStore.getStatus(userId) || "offline");
            update();
            FluxDispatcher.subscribe("PRESENCE_UPDATES", update);
            return () => FluxDispatcher.unsubscribe("PRESENCE_UPDATES", update);
        }, [userId]);
        const dotIcon = presence === "online" ? "🟢" : presence === "idle" ? "🌙" : presence === "dnd" ? "🔴" : "⚪";
        const isSelected = selectedUserId === userId;
        return (
            <div onClick={() => setSelectedUserId(userId)} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 10px", borderRadius: "8px", background: isSelected ? "var(--brand-experiment-500)22" : tracked ? "#23A55A10" : "transparent", border: `1px solid ${isSelected ? "var(--brand-experiment-500)55" : "transparent"}`, cursor: "pointer" }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "var(--background-modifier-hover)"; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = tracked ? "#23A55A10" : "transparent"; }}>
                <div style={{ position: "relative" }}>
                    <UserAvatar userId={userId} name={username} size={28} />
                    <span style={{ position: "absolute", bottom: -1, right: -1, fontSize: "11px", lineHeight: 1 }}>{dotIcon}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", fontWeight: isSelected ? "700" : "600", color: "var(--header-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{username}</div>
                </div>
                {tracked && <span style={{ fontSize: "10px", color: "#23A55A" }}>✓</span>}
            </div>
        );
    };

    return (
        <Modal {...modalProps} size="dynamic" title={header} footer={<Button color={Button.Colors.BRAND} onClick={modalProps.onClose}>Close</Button>}>
            <div style={{ display: "flex", height: "600px", background: "var(--background-primary)" }}>
                <div style={{ width: "220px", minWidth: "220px", borderRight: "1px solid var(--background-modifier-accent)", display: "flex", flexDirection: "column" }}>
                    <div style={{ padding: "12px", borderBottom: "1px solid var(--background-modifier-accent)" }}>
                        <TextInput placeholder="🔍 Search users..." value={search} onChange={setSearch} />
                    </div>
                    <div style={{ flex: 1, overflowY: "auto", padding: "10px" }}>
                        {trackedUsers.length > 0 && (
                            <>
                                <div style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", margin: "4px 4px 8px" }}>Tracked ({trackedUsers.length})</div>
                                <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "12px" }}>
                                    {filteredTracked.map(u => <SidebarRow key={u.id} userId={u.id} username={u.username} tracked />)}
                                    {q && filteredTracked.length === 0 && <div style={{ fontSize: "12px", color: "var(--text-muted)", padding: "8px 4px" }}>No tracked users match</div>}
                                </div>
                            </>
                        )}
                        {recentUsers.length > 0 && (
                            <>
                                <div style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.5px", margin: "4px 4px 8px" }}>Recent ({recentUsers.length})</div>
                                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                                    {filteredRecent.map(u => <SidebarRow key={u.id} userId={u.id} username={u.username} tracked={false} />)}
                                    {q && filteredRecent.length === 0 && <div style={{ fontSize: "12px", color: "var(--text-muted)", padding: "8px 4px" }}>No recent users match</div>}
                                </div>
                            </>
                        )}
                        {uniqueUsers.length === 0 && <div style={{ padding: "32px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: "12px" }}>No users yet.<br />Right-click someone to start tracking.</div>}
                    </div>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "16px" }}>
                    {selectedUser ? <UserProfile userId={selectedUser.id} logs={liveLogs} /> : (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", textAlign: "center" }}>
                            <div style={{ fontSize: "56px", marginBottom: "14px" }}>👤</div>
                            <div style={{ fontSize: "18px", fontWeight: "700", marginBottom: "6px", color: "var(--header-primary)" }}>Select a user</div>
                            <div style={{ fontSize: "13px" }}>Pick someone from the list to see their full activity profile</div>
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}

const UserContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!props?.user) return;
    const userId = props.user.id;
    const isTracked = trackedUserIds.has(userId);
    children.push(
        <Menu.MenuItem id="activity-tracker-dashboard" label="Activity Tracker" action={() => openModal(modalProps => <ActivityDashboard modalProps={modalProps} />)} />,
        <Menu.MenuItem id="activity-tracker-toggle" label={isTracked ? "Stop Tracking User" : "Start Tracking User"}
            action={() => { if (isTracked) stopTracking(userId); else void startTracking(userId); }} />
    );
};

export default definePlugin({
    name: "ActivityTracker",
    description: "Trackt Voice-Zeit, Aktivitäten, Nachrichten, Status, Profiländerungen und Tippen der ausgewählten Nutzer. Dashboard mit Heatmap, Voice-nach-Server und Timeline. Alles lokal.",
    authors: [{ name: "Kjell", id: 0n }, { name: "Elioflex", id: 0n }, { name: "Ondra_D", id: 534759293065625620n }],
    settings,

    start() {
        void loadAll();
        FluxDispatcher.subscribe("PRESENCE_UPDATES", this.handlePresenceUpdates);
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", this.handleVoiceStateUpdate);
        FluxDispatcher.subscribe("MESSAGE_CREATE", this.handleMessageCreate);
        FluxDispatcher.subscribe("USER_UPDATE", this.handleUserUpdate);
        FluxDispatcher.subscribe("USER_PROFILE_FETCH_SUCCESS", this.handleProfileFetch);
        FluxDispatcher.subscribe("TYPING_START", this.handleTyping);
        addContextMenuPatch("user-context", UserContextMenuPatch);
    },

    stop() {
        flushSave();
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", this.handlePresenceUpdates);
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", this.handleVoiceStateUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", this.handleMessageCreate);
        FluxDispatcher.unsubscribe("USER_UPDATE", this.handleUserUpdate);
        FluxDispatcher.unsubscribe("USER_PROFILE_FETCH_SUCCESS", this.handleProfileFetch);
        FluxDispatcher.unsubscribe("TYPING_START", this.handleTyping);
        removeContextMenuPatch("user-context", UserContextMenuPatch);
    },

    handlePresenceUpdates(data: { updates: any[]; }) {
        if (!data?.updates) return;
        for (const update of data.updates) {
            if (!update?.user?.id || !trackedUserIds.has(update.user.id)) continue;
            const user = UserStore.getUser(update.user.id);
            if (!user) continue;

            const currentStatus = update.status;
            const previousStatus = lastKnownStatus.get(user.id);
            if (currentStatus && currentStatus !== previousStatus && update.clientStatus) {
                lastKnownStatus.set(user.id, currentStatus);
                addLog({ userId: user.id, username: user.username, timestamp: Date.now(), type: "status", status: { status: currentStatus, clientStatus: update.clientStatus } });
                if (settings.store.notifyStatus && previousStatus) {
                    const name = user.globalName || user.username;
                    showNotification({ title: shouldBeNative() ? `${name} changed status` : "User status change", body: `${name} is now ${currentStatus}`, noPersist: !settings.store.persistNotifications, richBody: getRichBody(user, <div><div style={{ fontWeight: "bold" }}>{name}'s status is now {currentStatus}</div></div>) });
                }
            }

            const activities = update.activities || [];
            const sig = activities.map((a: any) => `${a.type}:${a.name ?? ""}:${a.state ?? ""}:${a.details ?? ""}:${a.timestamps?.start ?? ""}:${a.timestamps?.end ?? ""}`).join("|");
            if (sig && sig !== lastKnownActivities.get(user.id)) {
                lastKnownActivities.set(user.id, sig);
                addLog({ userId: user.id, username: user.username, timestamp: Date.now(), type: "activity", activities });
            }
        }
    },

    handleVoiceStateUpdate(data: any) {
        const { voiceStates } = data;
        if (!voiceStates) return;
        voiceStates.forEach((state: any) => {
            if (!trackedUserIds.has(state.userId)) return;
            const user = UserStore.getUser(state.userId);
            if (!user) return;
            const prevChannelId = state.oldChannelId || null;
            const currentChannelId = state.channelId || null;
            if (prevChannelId === currentChannelId) return;
            const channel = ChannelStore.getChannel(currentChannelId || prevChannelId);
            const guild = GuildStore.getGuild(state.guildId);
            const action = !prevChannelId && currentChannelId ? "join" : prevChannelId && !currentChannelId ? "leave" : "move";

            addLog({
                userId: user.id, username: user.username, timestamp: Date.now(), type: "voice",
                voiceChannel: { channelId: currentChannelId || prevChannelId || "unknown", channelName: channel?.name || `Channel ${currentChannelId || prevChannelId}`, action, guildId: state.guildId || "unknown", guildName: guild?.name || "Unknown Server" }
            });

            if (settings.store.notifyVoice) {
                const name = user.username;
                const channelName = channel?.name || "Unknown Channel";
                const guildName = guild?.name || "Unknown Server";
                showNotification({ title: shouldBeNative() ? `${name} changed voice` : "User voice status change", body: currentChannelId ? `${name} joined "${channelName}" in ${guildName}` : `${name} left "${channelName}"`, noPersist: !settings.store.persistNotifications, richBody: getRichBody(user, <div><div style={{ fontWeight: "bold" }}>{name} {currentChannelId ? "joined" : "left"} voice</div><div>📢 {channelName}</div></div>) });
            }
        });
    },

    handleMessageCreate(data: any) {
        if (!settings.store.logMessages) return;
        const { message } = data;
        if (!message?.author?.id || !trackedUserIds.has(message.author.id)) return;
        if (message.id && processedMessageIds.has(message.id)) return;
        if (message.id) processedMessageIds.add(message.id);
        const channel = ChannelStore.getChannel(message.channel_id);
        const guild = message.guild_id ? GuildStore.getGuild(message.guild_id) : null;
        addLog({
            userId: message.author.id, username: message.author.username, timestamp: Date.now(), type: "message",
            message: { content: (message.content || "").length > MAX_MESSAGE_CONTENT ? message.content.slice(0, MAX_MESSAGE_CONTENT) + "…" : (message.content || ""), channelId: message.channel_id, channelName: channel?.name || `Channel ${message.channel_id}`, guildId: message.guild_id, guildName: guild?.name || (message.guild_id ? "Unknown Server" : "DM") }
        });
        if (processedMessageIds.size > 1000) {
            const arr = Array.from(processedMessageIds);
            processedMessageIds.clear();
            arr.slice(-500).forEach(id => processedMessageIds.add(id));
        }
    },

    processProfile(id: string) {
        try {
            if (!trackedUserIds.has(id)) return;
            const cur = UserStore.getUser(id);
            if (!cur) return;
            const prev = lastKnownSnapshots.get(id);
            const snapshot = mergeSnapshots(prev, captureSnapshot(cur));
            if (!prev) { lastKnownSnapshots.set(id, snapshot); scheduleSave(); return; }
            const changes = detectChanges(prev, snapshot);
            lastKnownSnapshots.set(id, snapshot);
            if (changes.length === 0) { scheduleSave(); return; }
            if (settings.store.logProfile) {
                addLog({ userId: id, username: cur.username, timestamp: Date.now(), type: "profile", profile: { changedFields: changes, before: prev, after: snapshot } });
            }
            if (settings.store.notifyProfile) {
                showNotification({ title: `${cur.username} updated profile`, body: changes.map(c => profileChangeLabel(c)).join(", "), noPersist: !settings.store.persistNotifications, icon: cur.avatar ? `https://cdn.discordapp.com/avatars/${id}/${cur.avatar}.png?size=64` : undefined });
            }
        } catch (e) {
            console.error("[ActivityTracker] processProfile failed", e);
        }
    },

    handleUserUpdate(payload: any) {
        const id = payload?.user?.id;
        if (id) (this as any).processProfile(id);
    },

    handleProfileFetch(payload: any) {
        const id = payload?.userProfile?.user?.id;
        if (id) (this as any).processProfile(id);
    },

    handleTyping(evt: any) {
        if (!settings.store.logTyping && !settings.store.notifyTyping) return;
        const userId = evt?.userId ?? evt?.user?.id;
        if (!userId || !trackedUserIds.has(userId)) return;
        const channelId = evt?.channelId ?? evt?.channel?.id ?? null;
        const now = Date.now();
        const key = `${userId}:${channelId}`;
        const cd = typingCooldowns.get(key);
        if (cd && now < cd) return;
        typingCooldowns.set(key, now + 60000);

        const user = UserStore.getUser(userId);
        if (!user) return;
        const channel = channelId ? ChannelStore.getChannel(channelId) : null;
        const guild = channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
        const channelName = guild ? `#${channel?.name}` : channel?.type === 3 ? (channel?.name || "Group DM") : "DMs";

        if (settings.store.logTyping) {
            addLog({ userId, username: user.username, timestamp: now, type: "typing", typing: { channelId: channelId || "unknown", channelName, guildId: channel?.guild_id, guildName: guild?.name } });
        }
        if (settings.store.notifyTyping) {
            showNotification({ title: `${user.username} is typing`, body: guild ? `in ${guild.name}` : channelName, noPersist: !settings.store.persistNotifications, icon: user.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png?size=64` : undefined });
        }
    },

    openDashboard() { openModal(modalProps => <ActivityDashboard modalProps={modalProps} />); },
    trackUser(userId: string) { void startTracking(userId); },
    untrackUser(userId: string) { stopTracking(userId); },
    getTrackedUsers() { return Array.from(trackedUserIds); },
    getActivityLogs(userId?: string) { return userId ? activityLogs.filter(l => l.userId === userId) : activityLogs; }
});
