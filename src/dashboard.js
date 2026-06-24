#!/usr/bin/env node
import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import {
  closeDb,
  getDashboardExportRows,
  getDashboardRows,
  getDistinctTopics,
  getStatusCounts,
  getTopLikedPosts,
  getTotalCount,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const dashboardHtmlPath = path.join(publicDir, "dashboard.html");
const port = Number.parseInt(process.env.DASHBOARD_PORT || "4789", 10);
const downloadsDir = path.resolve(config.downloads.dir);

function normalizeLimit(raw, fallback = 20, max = 200) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function normalizePage(raw) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

function parseSinceIso(searchParams) {
  const sinceRaw = (searchParams.get("since") || "").trim();
  if (sinceRaw) {
    const parsed = Date.parse(sinceRaw);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }

  const daysRaw = (searchParams.get("days") || "").trim();
  if (daysRaw) {
    const days = Number.parseInt(daysRaw, 10);
    if (Number.isFinite(days) && days > 0) {
      return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  return "";
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function isPathInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sendAudioStream(req, res, audioPathRaw) {
  const decoded = decodeURIComponent(audioPathRaw || "").trim();
  if (!decoded) {
    return json(res, 400, { error: "Missing audio path" });
  }

  const requestedPath = path.resolve(decoded);
  if (!isPathInside(downloadsDir, requestedPath)) {
    return json(res, 403, {
      error: "Audio path is outside downloads directory",
    });
  }

  if (!fs.existsSync(requestedPath)) {
    return json(res, 404, { error: "Audio file not found" });
  }

  const stat = fs.statSync(requestedPath);
  const total = stat.size;
  const range = req.headers.range;
  const ext = path.extname(requestedPath).toLowerCase();
  const contentType =
    ext === ".mp3"
      ? "audio/mpeg"
      : ext === ".m4a"
        ? "audio/mp4"
        : ext === ".aac"
          ? "audio/aac"
          : "application/octet-stream";

  if (!range) {
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": total,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${path.basename(requestedPath)}"`,
    });
    fs.createReadStream(requestedPath).pipe(res);
    return;
  }

  const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!parts) {
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    res.end();
    return;
  }

  let start = parts[1] ? Number.parseInt(parts[1], 10) : 0;
  let end = parts[2] ? Number.parseInt(parts[2], 10) : total - 1;

  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= total) end = total - 1;
  if (start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${total}` });
    res.end();
    return;
  }

  res.writeHead(206, {
    "Content-Type": contentType,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename="${path.basename(requestedPath)}"`,
  });
  fs.createReadStream(requestedPath, { start, end }).pipe(res);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseFilters(searchParams) {
  return {
    topic: (searchParams.get("topic") || "").trim(),
    status: (searchParams.get("status") || "").trim().toLowerCase(),
    sinceIso: parseSinceIso(searchParams),
    searchText: (searchParams.get("q") || "").trim(),
    minLikes: (searchParams.get("minLikes") || "").trim(),
  };
}

function buildExportCsv(searchParams) {
  const filters = parseFilters(searchParams);
  const rows = getDashboardExportRows(filters, 25000);
  const headers = [
    "post_url",
    "topic",
    "status",
    "is_video",
    "view_count",
    "like_count",
    "comment_count",
    "uploader",
    "caption",
    "attempts",
    "audio_path",
    "last_error",
    "discovered_at",
    "downloaded_at",
    "updated_at",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => csvEscape(row[key])).join(","));
  }

  return lines.join("\n");
}

function getDashboardPayload(searchParams) {
  const limit = normalizeLimit(searchParams.get("limit"), 25, 200);
  const page = normalizePage(searchParams.get("page"));
  const offset = (page - 1) * limit;

  const filters = parseFilters(searchParams);

  const statusCounts = getStatusCounts(filters);
  const countMap = Object.fromEntries(
    statusCounts.map((item) => [item.status, item.count]),
  );
  const totalFiltered = getTotalCount(filters);
  const downloaded = countMap.downloaded || 0;

  return {
    meta: {
      page,
      limit,
      totalFiltered,
      totalPages: Math.max(1, Math.ceil(totalFiltered / limit)),
      filters,
    },
    summary: {
      total: totalFiltered,
      downloaded,
      notDownloaded: totalFiltered - downloaded,
    },
    topLikedPosts: getTopLikedPosts(Math.min(limit, 25), filters),
    rows: getDashboardRows({ filters, limit, offset }),
    topics: getDistinctTopics(300),
    statuses: ["discovered", "processing", "downloaded", "failed"],
  };
}

const server = http.createServer((req, res) => {
  const origin = `http://${req.headers.host || `localhost:${port}`}`;
  const url = new URL(req.url || "/", origin);

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    try {
      return json(res, 200, getDashboardPayload(url.searchParams));
    } catch (err) {
      return json(res, 500, {
        error: err.message || "Failed to load dashboard data",
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard/export.csv") {
    try {
      const csv = buildExportCsv(url.searchParams);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=dashboard-export-${stamp}.csv`,
        "Cache-Control": "no-store",
      });
      res.end(csv);
      return;
    } catch (err) {
      return json(res, 500, { error: err.message || "Failed to export CSV" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/audio") {
    try {
      return sendAudioStream(req, res, url.searchParams.get("path") || "");
    } catch (err) {
      return json(res, 500, { error: err.message || "Failed to stream audio" });
    }
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/dashboard")
  ) {
    try {
      const html = fs.readFileSync(dashboardHtmlPath, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Failed to load dashboard.html: ${err.message}`);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Dashboard running at http://localhost:${port}`);
});

function shutdown() {
  server.close(() => {
    closeDb();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
