#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
  CodeActionKind,
  type InitializeResult,
  type CodeAction,
  type CodeActionParams,
  type ExecuteCommandParams,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";

const execFileAsync = promisify(execFile);

const connection = createConnection(process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);

type BlameInfo = {
  commit: string; // 40-hex
  author?: string;
  authorTime?: number; // unix seconds
  summary?: string;
};

class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private max: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: K, value: V) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldestKey = this.map.keys().next().value as K;
      this.map.delete(oldestKey);
    }
  }
  clear() {
    this.map.clear();
  }
}

// cache per (file,line,key) -> BlameInfo|null
const lineCache = new LruCache<string, BlameInfo | null>(800);

const CMD_OPEN = "blame-lsp.openRemoteForLine";

function uriToFsPath(uri: string): string | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== "file:") return null;
    return fileURLToPath(u);
  } catch {
    return null;
  }
}

async function gitRootForFile(filePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", path.dirname(filePath), "rev-parse", "--show-toplevel"],
      { windowsHide: true },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "rev-parse", "HEAD"],
      {
        windowsHide: true,
      },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function computeKey(
  filePath: string,
): Promise<{ root: string; rel: string; key: string } | null> {
  const root = await gitRootForFile(filePath);
  if (!root) return null;

  const [head, st] = await Promise.all([
    gitHead(root),
    fs.stat(filePath).catch(() => null),
  ]);
  const rel = path.relative(root, filePath);

  const key = JSON.stringify({
    head,
    mtimeMs: st?.mtimeMs ?? null,
    size: st?.size ?? null,
  });

  return { root, rel, key };
}

function shortHash(full: string): string {
  return full.slice(0, 7);
}

function ymdFromUnixSeconds(sec: number): string {
  const d = new Date(sec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function relativeFromUnixSeconds(sec: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - sec * 1000) / 1000));
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec} sec${diffSec > 1 ? "s" : ""} ago`;

  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} min${mins > 1 ? "s" : ""} ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days > 1 ? "s" : ""} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months > 1 ? "s" : ""} ago`;

  const years = Math.floor(days / 365);
  return `${years} year${years > 1 ? "s" : ""} ago`;
}

function parseBlamePorcelain(porcelain: string): BlameInfo | null {
  const lines = porcelain.split("\n");
  const first = lines[0]?.trim();
  if (!first) return null;

  const [commit] = first.split(" ");
  if (!commit) return null;

  const info: BlameInfo = { commit };

  for (const line of lines) {
    if (line.startsWith("author "))
      info.author = line.slice("author ".length).trim();
    else if (line.startsWith("author-time ")) {
      const n = Number(line.slice("author-time ".length).trim());
      if (!Number.isNaN(n)) info.authorTime = n;
    } else if (line.startsWith("summary "))
      info.summary = line.slice("summary ".length).trim();
  }

  return info;
}

async function blameSingleLineUncached(
  root: string,
  rel: string,
  oneBasedLine: number,
): Promise<BlameInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        root,
        "blame",
        "--porcelain",
        "-L",
        `${oneBasedLine},${oneBasedLine}`,
        "--",
        rel,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024 * 5 },
    );
    return parseBlamePorcelain(stdout);
  } catch {
    return null;
  }
}

async function blameSingleLineCached(
  filePath: string,
  oneBasedLine: number,
): Promise<BlameInfo | null> {
  const ck = await computeKey(filePath);
  if (!ck) return null;

  const cacheKey = `${filePath}::${oneBasedLine}::${ck.key}`;
  const cached = lineCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const info = await blameSingleLineUncached(ck.root, ck.rel, oneBasedLine);
  lineCache.set(cacheKey, info);
  return info;
}

function formatBlameLabel({
  author = "Unknown author",
  authorTime,
  summary = "",
}: BlameInfo): string {
  // const hash = shortHash(commit);
  const maxLen = 60;
  const message =
    summary.length > maxLen ? `${summary?.substring(0, 80)}…` : summary;

  const when =
    typeof authorTime === "number"
      ? `${relativeFromUnixSeconds(authorTime)}` // (${ymdFromUnixSeconds(info.authorTime)})`
      : "unknown date";

  return `⎇ ${author}, ${when} · ${message} ↗`;
}

function normaliseRemoteToHttps(remote: string): string | null {
  const r = remote.trim().replace(/\.git$/, "");

  // https://host/org/repo
  if (r.startsWith("http://") || r.startsWith("https://")) return r;

  // git@host:org/repo or ssh://git@host/org/repo
  const scpLike = r.match(/^git@([^:]+):(.+)$/);
  if (scpLike) return `https://${scpLike[1]}/${scpLike[2]}`;

  const sshLike = r.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshLike) return `https://${sshLike[1]}/${sshLike[2]}`;

  return null;
}

async function getOriginRemote(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "remote", "get-url", "origin"],
      {
        windowsHide: true,
      },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function buildFileUrl(
  remoteHttps: string,
  relPath: string,
  commit: string,
  oneBasedLine: number,
): string {
  const base = remoteHttps.replace(/\/$/, "");
  const p = relPath.split(path.sep).join("/"); // windows-safe
  const encPath = p.split("/").map(encodeURIComponent).join("/");

  // GitHub / GitLab / Bitbucket all accept /blob/<ref>/<path>#L<n>
  return `${base}/blob/${encodeURIComponent(commit)}/${encPath}#L${oneBasedLine}`;
}

async function openUrlOrShow(url: string) {
  try {
    // Prefer showDocument if the client supports it
    // (Helix may or may not; if it errors we fall back)
    await connection.sendRequest("window/showDocument", {
      uri: url,
      external: true,
      takeFocus: true,
    });
  } catch {
    connection.window.showInformationMessage(`Open: ${url}`);
  }
}

connection.onInitialize(
  (): InitializeResult => ({
    capabilities: {
      codeActionProvider: true,
      executeCommandProvider: { commands: [CMD_OPEN] },
      textDocumentSync: TextDocumentSyncKind.Incremental,
    },
  }),
);

documents.onDidSave(() => {
  lineCache.clear();
});

connection.onCodeAction(
  async (params: CodeActionParams): Promise<CodeAction[]> => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    const filePath = uriToFsPath(doc.uri);
    if (!filePath) return [];

    const oneBasedLine = params.range.start.line + 1;

    const info = await blameSingleLineCached(filePath, oneBasedLine);
    if (!info) return [];

    const title = `${formatBlameLabel(info)}`;

    return [
      {
        title,
        kind: CodeActionKind.QuickFix,
        command: {
          title,
          command: CMD_OPEN,
          arguments: [params.textDocument.uri, oneBasedLine],
        },
      },
    ];
  },
);

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command !== CMD_OPEN) return;

  const [uri, oneBasedLine] = (params.arguments ?? []) as [string, number];
  if (!uri || !oneBasedLine) return;

  const filePath = uriToFsPath(uri);
  if (!filePath) return;

  const ck = await computeKey(filePath);
  if (!ck) {
    connection.window.showWarningMessage(
      "Not in a git repo (or git not available).",
    );
    return;
  }

  const [remote, info] = await Promise.all([
    getOriginRemote(ck.root),
    blameSingleLineCached(filePath, oneBasedLine),
  ]);

  if (!remote) {
    connection.window.showWarningMessage("No 'origin' remote found.");
    return;
  }
  if (!info) {
    connection.window.showWarningMessage("No blame info for that line.");
    return;
  }

  const remoteHttps = normaliseRemoteToHttps(remote);
  if (!remoteHttps) {
    connection.window.showWarningMessage(`Unsupported remote URL: ${remote}`);
    return;
  }

  const url = buildFileUrl(remoteHttps, ck.rel, info.commit, oneBasedLine);
  await openUrlOrShow(url);
});

documents.listen(connection);
connection.listen();
