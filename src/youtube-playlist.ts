// Reads the tracks of a YouTube (or YouTube Music) playlist without an API key, from the same
// data YouTube's own web page loads: the playlist page, then its "load more" continuations.
// Mixes (list=RD…) have no playlist page; their tracks come from the watch page's side panel.

export interface PlaylistTrack { videoId: string; title: string }
export interface Playlist { tracks: PlaylistTrack[]; /** How many videos the playlist has, as far as YouTube says (at least tracks.length). */ total: number }

const YOUTUBE = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const LIST_ID = /^[\w-]{2,64}$/;
const VIDEO_ID = /^[\w-]{11}$/;
const ORIGIN = "https://www.youtube.com";
const HEADERS = {
  "accept-language": "en-US,en;q=0.8",
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
/** The whole read stays well inside the client's 20 s write timeout. */
const BUDGET_MS = 12_000;
const MAX_PAGES = 10;

/** The playlist a YouTube link points at (its list= parameter), or null. */
export function playlistIdOf(url: URL): string | null {
  if (!YOUTUBE.test(url.hostname)) return null;
  const list = url.searchParams.get("list");
  return list && LIST_ID.test(list) ? list : null;
}

/** The video a YouTube link points at, if any. */
export function videoIdOf(url: URL): string | null {
  if (!YOUTUBE.test(url.hostname)) return null;
  const id = url.hostname.endsWith("youtu.be") ? url.pathname.split("/")[1] : url.searchParams.get("v");
  return id && VIDEO_ID.test(id) ? id : null;
}

export const watchUrl = (videoId: string) => `${ORIGIN}/watch?v=${videoId}`;

type Json = Record<string, unknown>;
const text = (value: unknown): string => {
  if (!value || typeof value !== "object") return typeof value === "string" ? value : "";
  const v = value as { simpleText?: unknown; content?: unknown; runs?: { text?: unknown }[] };
  if (typeof v.simpleText === "string") return v.simpleText;
  if (typeof v.content === "string") return v.content;
  return Array.isArray(v.runs) ? v.runs.map((r) => (typeof r.text === "string" ? r.text : "")).join("") : "";
};

/** Every video in a page of YouTube data, in order, and the token for the next page. */
function collect(data: unknown, panel: boolean): { tracks: PlaylistTrack[]; next: string | null } {
  const tracks: PlaylistTrack[] = [];
  let next: string | null = null;
  const add = (videoId: unknown, title: string) => {
    if (typeof videoId === "string" && VIDEO_ID.test(videoId)) tracks.push({ videoId, title: title.trim().slice(0, 200) });
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const o = node as Json;
    if (!panel && o.lockupViewModel) {
      const l = o.lockupViewModel as { contentId?: unknown; contentType?: unknown; metadata?: { lockupMetadataViewModel?: { title?: unknown } } };
      if (l.contentType === undefined || l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") add(l.contentId, text(l.metadata?.lockupMetadataViewModel?.title));
      return;
    }
    if (!panel && o.playlistVideoRenderer) {
      const r = o.playlistVideoRenderer as { videoId?: unknown; title?: unknown; isPlayable?: unknown };
      if (r.isPlayable !== false) add(r.videoId, text(r.title));
      return;
    }
    if (panel && o.playlistPanelVideoRenderer) {
      const r = o.playlistPanelVideoRenderer as { videoId?: unknown; title?: unknown };
      add(r.videoId, text(r.title));
      return;
    }
    // "Load more" at the end of the list (older pages call it a renderer, newer ones a view model).
    // The first one belongs to the videos; later ones to other sections of the page.
    const more = o.continuationItemViewModel ?? o.continuationItemRenderer;
    if (more) {
      const token = JSON.stringify(more).match(/"token":"([^"]+)"/)?.[1];
      if (token && !next) next = token;
      return;
    }
    for (const value of Object.values(o)) walk(value);
  };
  walk(data);
  return { tracks, next };
}

function initialData(html: string): unknown {
  const start = html.search(/(?:var |window\[["'])ytInitialData["']?\]? ?= ?\{/);
  if (start < 0) return null;
  const from = html.indexOf("{", start);
  const end = html.indexOf(";</script>", from);
  try {
    return JSON.parse(html.slice(from, end));
  } catch {
    return null;
  }
}

/** "182 videos" (or "1,234 videos") in the playlist header; the page is asked for in English. */
function headerTotal(data: unknown): number {
  const header = JSON.stringify((data as Json | null)?.header ?? {});
  const match = header.match(/"(?:content|simpleText|text)":"([\d,.]+) videos?"/);
  return match ? Number(match[1]!.replace(/[,.]/g, "")) : 0;
}

/**
 * The playlist's tracks, at most `limit` of them (the queue's free places), in playlist order.
 * null when YouTube doesn't give the list (private, deleted, a typo, or offline).
 */
export async function readPlaylist(listId: string, videoId: string | null, limit: number): Promise<Playlist | null> {
  const deadline = Date.now() + BUDGET_MS;
  const signal = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  const page = async (path: string) => {
    const res = await fetch(`${ORIGIN}${path}`, { headers: HEADERS, signal: signal() });
    return res.ok ? res.text() : null;
  };
  try {
    if (!listId.startsWith("RD")) {
      const html = await page(`/playlist?list=${encodeURIComponent(listId)}&hl=en`);
      const data = html ? initialData(html) : null;
      if (data) {
        let { tracks, next } = collect(data, false);
        const version = html!.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] ?? "2.20261116.00.00";
        // More pages only while the queue still has room: the header says how many are left.
        for (let n = 1; next && tracks.length < limit && n < MAX_PAGES && Date.now() < deadline; n++) {
          const res = await fetch(`${ORIGIN}/youtubei/v1/browse?prettyPrint=false`, {
            method: "POST",
            headers: { ...HEADERS, "content-type": "application/json" },
            body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: version, hl: "en" } }, continuation: next }),
            signal: signal(),
          });
          if (!res.ok) break;
          const more = collect(await res.json(), false);
          tracks = tracks.concat(more.tracks);
          next = more.next;
        }
        if (tracks.length) {
          const counted = next ? Math.max(headerTotal(data), tracks.length) : tracks.length;
          return { tracks: tracks.slice(0, limit), total: counted };
        }
      }
    }
    // A mix, or a list the playlist page doesn't show: the watch page lists it beside the video.
    if (videoId) {
      const html = await page(`/watch?v=${videoId}&list=${encodeURIComponent(listId)}&hl=en`);
      const data = html ? initialData(html) : null;
      const panel = data ? (data as { contents?: { twoColumnWatchNextResults?: { playlist?: unknown } } }).contents?.twoColumnWatchNextResults?.playlist : null;
      const { tracks } = collect(panel, true);
      const unique = tracks.filter((t, i) => tracks.findIndex((o) => o.videoId === t.videoId) === i);
      if (unique.length) return { tracks: unique.slice(0, limit), total: unique.length };
    }
  } catch {
    // Offline, blocked or too slow: no list.
  }
  return null;
}
