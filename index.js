require("dotenv").config();
const Octokit = require("@octokit/rest");
const fetch = require("node-fetch");
const eaw = require("eastasianwidth");

const {
  GIST_ID: gistId,
  GH_TOKEN: githubToken,
  LASTFM_KEY: lfmAPI,
  LFMUSERNAME: user,
  BACKFILL_START: backfillStart,
  BACKFILL_END: backfillEnd,
  BACKFILL_LIMIT: backfillLimitRaw, // backward-compat (weekly limit)
  BACKFILL_DELAY_MS: backfillDelayMsRaw,
  BACKFILL_MODE: backfillModeRaw, // weekly | daily | both
  BACKFILL_WEEKLY_LIMIT: backfillWeeklyLimitRaw,
  BACKFILL_DAILY_LIMIT: backfillDailyLimitRaw,
} = process.env;

const octokit = new Octokit({
  auth: `token ${githubToken}`,
});

const API_BASE = "https://ws.audioscrobbler.com/2.0/?format=json&";

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function parseISODate(iso) {
  // Treat YYYY-MM-DD as UTC midnight for determinism across runners
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  const [_, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 0, 0, 0));
}

function formatISODateUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatMDYForFilenameUTC(date) {
  // Avoid "/" in filenames (often treated as path separators)
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const y = String(date.getUTCFullYear());
  return `${m}-${d}-${y}`;
}

function addDaysUTC(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function weekRangesUTC(startDateUTC, endDateUTCExclusive) {
  const ranges = [];
  let cur = new Date(startDateUTC.getTime());
  while (cur < endDateUTCExclusive) {
    const next = addDaysUTC(cur, 7);
    ranges.push({ from: cur, toExclusive: next });
    cur = next;
  }
  return ranges;
}

function normalizeWeeklyArtists(json) {
  // Supports both:
  // - user.gettopartists => json.topartists.artist[]
  // - user.getweeklyartistchart => json.weeklyartistchart.artist[]
  if (json?.topartists?.artist) return json.topartists.artist;
  if (json?.weeklyartistchart?.artist) return json.weeklyartistchart.artist;
  return [];
}

function getArtistName(a) {
  return a?.name ?? "";
}

function getArtistPlays(a) {
  // weeklyartistchart uses "playcount" too, but keep it defensive
  return parseInt(a?.playcount ?? "0", 10) || 0;
}

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkEntries(obj, chunkSize) {
  const entries = Object.entries(obj);
  const chunks = [];
  for (let i = 0; i < entries.length; i += chunkSize) {
    chunks.push(entries.slice(i, i + chunkSize));
  }
  return chunks;
}

async function updateGistFilesInBatches({ gistID, files, batchSize = 10 }) {
  const keys = Object.keys(files || {});
  if (keys.length === 0) return;

  // GitHub can reject very large PATCH payloads; keep updates small and repeatable.
  for (const chunk of chunkEntries(files, batchSize)) {
    const chunkFiles = Object.fromEntries(chunk);
    await octokit.gists.update({
      gist_id: gistID,
      files: chunkFiles,
    });
  }
}

function normalizeBackfillMode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "daily" || v === "weekly" || v === "both") return v;
  return "weekly";
}

function coerceToArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function asArtistNameFromRecentTrack(track) {
  // recenttracks: artist is usually { "#text": "name", mbid: "" }
  const artistObj = track?.artist;
  if (typeof artistObj === "string") return artistObj;
  if (artistObj && typeof artistObj["#text"] === "string") return artistObj["#text"];
  return "";
}

async function fetchLastfmJson(url) {
  const res = await fetch(url);
  const json = await res.json();
  // Last.fm errors are usually { error: <code>, message: "...", links: [] }
  if (json?.error) {
    const msg = `Last.fm error ${json.error}: ${json.message || "Unknown error"}`;
    const err = new Error(msg);
    err.lastfm = json;
    throw err;
  }
  return json;
}

async function getDailyTopArtists({ username, apiKey, fromUnix, toUnix, delayMs }) {
  const perPage = 200;
  const counts = new Map();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${API_BASE}method=user.getrecenttracks&user=${encodeURIComponent(
      username
    )}&api_key=${encodeURIComponent(apiKey)}&from=${fromUnix}&to=${toUnix}&limit=${perPage}&page=${page}`;

    let json;
    try {
      json = await fetchLastfmJson(url);
    } catch (e) {
      // If rate limited, back off a bit then retry once
      if (e?.lastfm?.error === 29) {
        await sleep(Math.max(delayMs, 1000));
        json = await fetchLastfmJson(url);
      } else {
        throw e;
      }
    }

    const recent = json?.recenttracks;
    const tracks = coerceToArray(recent?.track);
    const attr = recent?.["@attr"] || recent?.attr || {};
    const tp = parsePositiveInt(attr.totalPages) || 1;
    totalPages = tp;

    for (const t of tracks) {
      // Skip "now playing" pseudo-track (no date)
      if (t?.["@attr"]?.nowplaying === "true") continue;
      const name = asArtistNameFromRecentTrack(t);
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }

    page += 1;
    if (delayMs > 0) await sleep(delayMs);
  }

  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, playcount]) => ({ name, playcount: String(playcount) }));

  return sorted;
}

async function main() {
  const username = user;
  const gistID = gistId;
  const lfm = lfmAPI;

  if (!lfm || !username || !gistID || !githubToken)
    throw new Error(
      "Please check your environment variables, as you are missing one."
    );

  let gist;
  try {
    gist = await octokit.gists.get({ gist_id: gistID });
  } catch (error) {
    console.error(`music-box ran into an issue getting your Gist:\n${error}`);
    throw error;
  }

  const start = parseISODate(backfillStart);
  if (start) {
    const delayMs = parsePositiveInt(backfillDelayMsRaw) ?? 300;
    const mode = normalizeBackfillMode(backfillModeRaw);
    const weeklyLimit =
      parsePositiveInt(backfillWeeklyLimitRaw) ??
      parsePositiveInt(backfillLimitRaw) ??
      20;
    const dailyLimit = parsePositiveInt(backfillDailyLimitRaw) ?? 20;
    const endInclusive = parseISODate(backfillEnd) || new Date();
    const endExclusiveUTC = addDaysUTC(
      new Date(Date.UTC(endInclusive.getUTCFullYear(), endInclusive.getUTCMonth(), endInclusive.getUTCDate(), 0, 0, 0)),
      1
    );

    const existingFiles = new Set(Object.keys(gist.data.files || {}));
    const files = {};

    if (mode === "weekly" || mode === "both") {
      const weeklyRanges = weekRangesUTC(start, endExclusiveUTC)
        .map((r) => {
          const weekLabel = formatMDYForFilenameUTC(r.from);
          const filename = `🎵 My week in music ${weekLabel}.txt`;
          return { ...r, filename };
        })
        .filter((r) => !existingFiles.has(r.filename))
        .slice(0, weeklyLimit);

      for (const r of weeklyRanges) {
        const fromUnix = toUnixSeconds(r.from);
        const toUnix = toUnixSeconds(r.toExclusive);
        const api = `${API_BASE}method=user.getweeklyartistchart&user=${encodeURIComponent(
          username
        )}&api_key=${encodeURIComponent(lfm)}&from=${fromUnix}&to=${toUnix}`;

        const json = await fetchLastfmJson(api);
        const artists = normalizeWeeklyArtists(json);

        const content = buildReportContent(artists);
        files[r.filename] = {
          filename: r.filename,
          content,
        };

        if (delayMs > 0) await sleep(delayMs);
      }
    }

    if (mode === "daily" || mode === "both") {
      const dayRanges = [];
      let cur = new Date(start.getTime());
      while (cur < endExclusiveUTC) {
        const next = addDaysUTC(cur, 1);
        const dayLabel = formatMDYForFilenameUTC(cur);
        const filename = `🎵 My day in music ${dayLabel}.txt`;
        if (!existingFiles.has(filename)) {
          dayRanges.push({ from: cur, toExclusive: next, filename });
        }
        cur = next;
      }

      for (const r of dayRanges.slice(0, dailyLimit)) {
        const fromUnix = toUnixSeconds(r.from);
        const toUnix = toUnixSeconds(r.toExclusive);
        const artists = await getDailyTopArtists({
          username,
          apiKey: lfm,
          fromUnix,
          toUnix,
          delayMs,
        });

        const content = buildReportContent(artists);
        files[r.filename] = {
          filename: r.filename,
          content,
        };
      }
    }

    if (Object.keys(files).length > 0) {
      await updateGistFilesInBatches({ gistID, files, batchSize: 10 });
    }
    return;
  }

  // Default mode: last 7 days (keeps existing behavior)
  const api = `${API_BASE}method=user.gettopartists&user=${encodeURIComponent(
    username
  )}&api_key=${encodeURIComponent(lfm)}&period=7day`;
  const data = await fetch(api);
  const json = await data.json();
  const artists = normalizeWeeklyArtists(json);
  const content = buildReportContent(artists);

  try {
    // Get original filename to update that same file
    const filename = Object.keys(gist.data.files)[0];
    await octokit.gists.update({
      gist_id: gistID,
      files: {
        [filename]: {
          filename: `🎵 My last week in music`,
          content,
        },
      },
    });
  } catch (error) {
    console.error(`Unable to update gist\n${error}`);
  }
}

function buildReportContent(artistsRaw) {
  const artists = Array.isArray(artistsRaw) ? artistsRaw : [];
  const numArtitst = Math.min(10, artists.length);
  if (numArtitst === 0) return "No plays.";
  let playsTotal = 0;
  for (let i = 0; i < numArtitst; i++) {
    playsTotal += getArtistPlays(artists[i]);
  }

  const denom = playsTotal > 0 ? playsTotal : 1;
  const lines = [];
  for (let i = 0; i < numArtitst; i++) {
    const playsInt = getArtistPlays(artists[i]);
    const playsStr = String(playsInt);
    let name = getArtistName(artists[i]).substring(0, 25);
    // trim off long widechars
    for (let j = 24; j >= 0; j--) {
      if (eaw.length(name) <= 26) break;
      name = name.substring(0, j);
    }
    // pad short strings
    name = name.padEnd(26 + name.length - eaw.length(name));

    lines.push(
      [
        name,
        generateBarChart((playsInt * 100) / denom, 17),
        playsStr.padStart(5),
        "plays",
      ].join(" ")
    );
  }

  return lines.join("\n");
}

function generateBarChart(percent, size) {
  const syms = "░▏▎▍▌▋▊▉█";

  const frac = Math.floor((size * 8 * percent) / 100);
  const barsFull = Math.floor(frac / 8);
  if (barsFull >= size) {
    return syms.substring(8, 9).repeat(size);
  }
  const semi = frac % 8;

  return [syms.substring(8, 9).repeat(barsFull), syms.substring(semi, semi + 1)]
    .join("")
    .padEnd(size, syms.substring(0, 1));
}

async function updateGist() {
  let gist;
  try {
    gist = await octokit.gists.get({
      gist_id: gistID,
    });
  } catch (error) {
    console.error(`music-box ran into an issue:\n${error}`);
  }
}

(async () => {
  await main();
})();

