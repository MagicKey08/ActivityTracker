/*
 * ActivityTracker — native file storage
 * Speichert die Logs pro Benutzer als JSON-Datei in Vencords Datenordner,
 * statt sie in die settings.json zu quetschen. Nichts verlässt den PC.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DATA_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent } from "electron";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import path from "path";

let logsDir: string;

async function getLogsDir() {
    if (!logsDir) {
        logsDir = path.join(DATA_DIR, "ActivityTrackerData");
        await mkdir(logsDir, { recursive: true });
    }
    return logsDir;
}

function fileFor(dir: string, userId: string) {
    // Nur Ziffern als Dateiname zulassen, damit niemand aus der ID herausnavigieren kann
    const safe = String(userId).replace(/[^0-9]/g, "");
    return path.join(dir, `${safe}.json`);
}

export async function writeUserLogs(_: IpcMainInvokeEvent, userId: string, json: string) {
    const dir = await getLogsDir();
    await writeFile(fileFor(dir, userId), json, "utf-8");
}

export async function readUserLogs(_: IpcMainInvokeEvent, userId: string): Promise<string> {
    const dir = await getLogsDir();
    try {
        return await readFile(fileFor(dir, userId), "utf-8");
    } catch {
        return "";
    }
}

export async function deleteUserLogs(_: IpcMainInvokeEvent, userId: string) {
    const dir = await getLogsDir();
    try {
        await unlink(fileFor(dir, userId));
    } catch { }
}

export async function deleteAllLogs(_: IpcMainInvokeEvent) {
    const dir = await getLogsDir();
    try {
        const files = await readdir(dir);
        await Promise.all(files.filter(f => f.endsWith(".json")).map(f => unlink(path.join(dir, f)).catch(() => { })));
    } catch { }
}

export async function getLogsPath(_: IpcMainInvokeEvent): Promise<string> {
    return getLogsDir();
}
