const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 7000);

const API_HOST =
  process.env.PIKPAK_API_HOST || "api-drive.mypikpak.com";

const USER_HOST =
  process.env.PIKPAK_USER_HOST || "user.mypikpak.com";

const CLIENT_ID = "YUMx5nI8ZU8Ap8pm";
const CLIENT_VERSION = "2.0.0";
const PACKAGE_NAME = "mypikpak.com";

const ALGORITHMS = [
  "C9qPpZLN8ucRTaTiUMWYS9cQvWOE",
  "+r6CQVxjzJV6LCV",
  "F",
  "pFJRC",
  "9WXYIDGrwTCz2OiVlgZa90qpECPD6olt",
  "/750aCr4lm/Sly/c",
  "RB+DT/gZCrbV",
  "",
  "CyLsf7hdkIRxRm215hl",
  "7xHvLi2tOYP0Y92b",
  "ZGTXXxu8E/MIWaEDB+Sm/",
  "1UI3",
  "E7fP5Pfijd+7K+t6Tg/NhuLq0eEUVChpJSkrKxpO",
  "ihtqpG6FMt65+Xk+tWUH2",
  "NhXXU9rg4XXdzo7u5o"
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/117.0.0.0 Safari/537.36";

const cache = new Map();

function md5(value) {
  return crypto
    .createHash("md5")
    .update(value, "utf8")
    .digest("hex");
}

function captchaSign(deviceId, timestamp) {
  let value =
    CLIENT_ID +
    CLIENT_VERSION +
    PACKAGE_NAME +
    deviceId +
    timestamp;

  for (const algorithm of ALGORITHMS) {
    value = md5(value + algorithm);
  }

  return "1." + value;
}

function makeDeviceId() {
  return crypto.randomBytes(16).toString("hex");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}

  if (!response.ok) {
    throw new Error(
      `${response.status}: ${
        data?.error_description || text.slice(0, 300)
      }`
    );
  }

  return data;
}

class PikPakClient {
  constructor() {
    this.deviceId = makeDeviceId();
    this.captchaToken = "";
    this.passCodeToken = "";
  }

  headers() {
    return {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
      "X-Client-ID": CLIENT_ID,
      "X-Device-ID": this.deviceId,
      "X-Captcha-Token": this.captchaToken || ""
    };
  }

  async initCaptcha(action) {
    const timestamp = String(Date.now());

    const body = {
      action,
      captcha_token: this.captchaToken || "",
      client_id: CLIENT_ID,
      device_id: this.deviceId,
      meta: {
        captcha_sign: captchaSign(
          this.deviceId,
          timestamp
        ),
        client_version: CLIENT_VERSION,
        package_name: PACKAGE_NAME,
        timestamp,
        user_id: ""
      },
      redirect_uri: ""
    };

    const data = await fetchJson(
      `https://${USER_HOST}/v1/shield/captcha/init`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body)
      }
    );

    if (!data?.captcha_token) {
      throw new Error(
        "PikPak captcha/init did not return a token"
      );
    }

    this.captchaToken = data.captcha_token;
  }

  async request(path, query = {}) {
    const url = new URL(
      `https://${API_HOST}${path}`
    );

    for (const [key, value] of Object.entries(query)) {
      if (value !== "" && value !== null && value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const action = `GET:${path}`;

    if (!this.captchaToken) {
      await this.initCaptcha(action);
    }

    let data = await fetchJson(url, {
      headers: this.headers()
    });

    if (data?.error_code === 9) {
      await this.initCaptcha(action);

      data = await fetchJson(url, {
        headers: this.headers()
      });
    }

    if (data?.error_code) {
      throw new Error(
        `PikPak ${data.error_code}: ${
          data.error_description || data.error
        }`
      );
    }

    return data;
  }

  async getShareDetails(
    shareId,
    parentId = "",
    pageToken = ""
  ) {
    return this.request("/drive/v1/share/detail", {
      share_id: shareId,
      parent_id: parentId,
      pass_code_token: this.passCodeToken || "",
      thumbnail_size: "SIZE_LARGE",
      with_audit: "true",
      limit: "100",
      page_token: pageToken,
      filters: JSON.stringify({
        phase: {
          eq: "PHASE_TYPE_COMPLETE"
        },
        trashed: {
          eq: false
        }
      })
    });
  }

  async getFileInfo(shareId, fileId) {
    return this.request(
      "/drive/v1/share/file_info",
      {
        share_id: shareId,
        file_id: fileId,
        pass_code_token:
          this.passCodeToken || ""
      }
    );
  }
}

function parseShareUrl(rawUrl) {
  const url = new URL(rawUrl);

  if (
    !/^https?:$/i.test(url.protocol) ||
    !/^(www\.)?mypikpak\.(com|net)$/i.test(
      url.hostname
    ) ||
    !url.pathname.startsWith("/s/")
  ) {
    throw new Error("Not a valid PikPak share URL");
  }

  const parts = url.pathname
    .split("/")
    .filter(Boolean);

  return {
    shareId: parts[1],
    parentId: parts[2] || ""
  };
}

async function resolveShare(rawUrl) {
  const parsed = parseShareUrl(rawUrl);
  const shareId = parsed.shareId;

  if (cache.has(shareId)) {
    return cache.get(shareId);
  }

  const client = new PikPakClient();
  const files = [];

  async function walk(parentId = "", prefix = "") {
    let pageToken = "";

    do {
      const data = await client.getShareDetails(
        shareId,
        parentId,
        pageToken
      );

      if (
        data.share_status &&
        data.share_status !== "OK"
      ) {
        if (
          data.share_status ===
            "PASS_CODE_EMPTY" ||
          data.share_status ===
            "PASS_CODE_ERROR"
        ) {
          throw new Error(
            `Share ${shareId} requires a password`
          );
        }

        throw new Error(
          `Share ${shareId}: ${data.share_status}`
        );
      }

      for (const file of data.files || []) {
        if (file.kind === "drive#folder") {
          await walk(
            file.id,
            prefix
              ? `${prefix}/${file.name}`
              : file.name
          );
        } else {
          files.push({
            id: file.id,
            name: file.name,
            path: prefix,
            size: Number(file.size) || 0,
            shareId
          });
        }
      }

      pageToken = data.next_page_token || "";
    } while (pageToken);
  }

  await walk(parsed.parentId);

  for (const file of files) {
    try {
      const data = await client.getFileInfo(
        shareId,
        file.id
      );

      const info =
        data.file_info || data;

      file.url =
        info.web_content_link ||
        info.medias?.[0]?.link?.url ||
        "";

      file.thumbnail =
        info.thumbnail_link ||
        info.thumbnail ||
        "";
    } catch (error) {
      console.error(
        `Unable to resolve ${file.name}:`,
        error.message
      );
    }
  }

  const result = {
    shareId,
    files: files.filter(file => file.url)
  };

  cache.set(shareId, result);

  return result;
}

function cleanName(name) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(
      /\b(2160p|1440p|1080p|720p|480p|4k|x264|x265|hevc|h264|web-dl|bluray)\b/gi,
      ""
    )
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function episodeInfo(name) {
  let match = name.match(
    /S(\d{1,2})\s*E(\d{1,4})/i
  );

  if (match) {
    return {
      season: Number(match[1]),
      episode: Number(match[2])
    };
  }

  match = name.match(
    /(?:EP?|Episode)[ ._-]*(\d{1,4})/i
  );

  if (match) {
    return {
      season: 1,
      episode: Number(match[1])
    };
  }

  return null;
}

function groupFiles(files) {
  const groups = new Map();

  for (const file of files) {
    const episode = episodeInfo(file.name);

    let baseName = file.name;

    if (episode) {
      baseName = baseName
        .replace(
          /S\d{1,2}\s*E\d{1,4}/i,
          ""
        )
        .replace(
          /(?:EP?|Episode)[ ._-]*\d{1,4}/i,
          ""
        );
    }

    const title =
      cleanName(baseName)
        .replace(/\b\d{1,4}\b\s*$/, "")
        .trim() ||
      cleanName(file.name);

    const key = title.toLowerCase();

    if (!groups.has(key)) {
      groups.set(key, {
        title,
        episodes: []
      });
    }

    groups.get(key).episodes.push({
      ...file,
      ...episode
    });
  }

  return [...groups.values()];
}

function decodeConfig(encoded) {
  try {
    const json = Buffer
      .from(encoded, "base64url")
      .toString("utf8");

    const links = JSON.parse(json);

    if (!Array.isArray(links)) {
      return [];
    }

    return links.filter(Boolean);
  } catch (_) {
    return [];
  }
}

function createManifest() {
  return {
    id: "com.pikpak.nuvio",
    version: "0.1.0",
    name: "PikPak Library",
    description:
      "PikPak share links as a Stremio/Nuvio catalog",

    resources: [
      "catalog",
      "meta",
      "stream"
    ],

    types: [
      "series",
      "movie"
    ],

    catalogs: [
      {
        type: "series",
        id: "pikpak",
        name: "PikPak Library",
        extra: [
          {
            name: "search",
            isRequired: false
          }
        ]
      }
    ],

    behaviorHints: {
      configurable: true,
      configurationRequired: true
    }
  };
}

function makeGroupId(title) {
  return (
    "pp:g:" +
    Buffer
      .from(title)
      .toString("base64url")
  );
}

function makeFileId(file) {
  return (
    "pp:f:" +
    Buffer
      .from(
        JSON.stringify({
          shareId: file.shareId,
          id: file.id
        })
      )
      .toString("base64url")
  );
}

function createMeta(group) {
  return {
    id: makeGroupId(group.title),
    type: "series",
    name: group.title,

    poster:
      "https://placehold.co/342x513/png?text=PikPak",

    posterShape: "poster",

    videos: group.episodes
      .sort(
        (a, b) =>
          (a.season || 1) -
            (b.season || 1) ||
          (a.episode || 0) -
            (b.episode || 0)
      )
      .map(file => ({
        id: makeFileId(file),

        title: file.episode
          ? `Episode ${file.episode}`
          : file.name,

        season: file.season || 1,

        episode: file.episode || 1,

        thumbnail:
          file.thumbnail ||
          "https://placehold.co/640x360/png?text=PikPak"
      }))
  };
}

function configurationPage(baseUrl) {
  return `<!doctype html>
<html>
<head>
<meta name="viewport"
content="width=device-width">
<title>PikPak Library</title>

<style>
body {
  font-family: system-ui;
  max-width: 760px;
  margin: 40px auto;
  padding: 0 18px;
  background: #111;
  color: #eee;
}

textarea {
  width: 100%;
  height: 220px;
  box-sizing: border-box;
  background: #222;
  color: #eee;
  border: 1px solid #555;
  padding: 12px;
  border-radius: 8px;
}

button {
  padding: 12px 18px;
  margin-top: 12px;
  border-radius: 8px;
  border: 0;
}

pre {
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
</head>

<body>

<h1>PikPak Library</h1>

<p>
Paste one PikPak share URL per line.
</p>

<textarea id="shares"
placeholder="https://mypikpak.com/s/..."></textarea>

<br>

<button onclick="createAddon()">
Create addon URL
</button>

<pre id="output"></pre>

<script>
function createAddon() {

  const links =
    document
      .getElementById("shares")
      .value
      .split(/\\n+/)
      .map(x => x.trim())
      .filter(Boolean);

  const encoded =
    btoa(
      unescape(
        encodeURIComponent(
          JSON.stringify(links)
        )
      )
    )
    .replace(/\\+/g, "-")
    .replace(/\\//g, "_")
    .replace(/=+$/, "");

  const url =
    ${JSON.stringify(baseUrl)}
    + "/cfg/"
    + encoded
    + "/manifest.json";

  document
    .getElementById("output")
    .textContent = url;
}
</script>

</body>
</html>`;
}

async function handle(req, res) {

  const requestUrl =
    new URL(
      req.url,
      `https://${req.headers.host}`
    );

  const pathname =
    requestUrl.pathname;

  if (pathname === "/") {

    res.writeHead(200, {
      "Content-Type":
        "text/html; charset=utf-8"
    });

    return res.end(
      "<h1>PikPak Nuvio Addon</h1>" +
      "<p><a href='/configure'>" +
      "Configure addon</a></p>"
    );
  }

  if (pathname === "/configure") {

    res.writeHead(200, {
      "Content-Type":
        "text/html; charset=utf-8"
    });

    return res.end(
      configurationPage(
        `https://${req.headers.host}`
      )
    );
  }

  const manifestMatch =
    pathname.match(
      /^\/cfg\/([^/]+)\/manifest\.json$/
    );

  if (manifestMatch) {

    res.writeHead(200, {
      "Content-Type":
        "application/json; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*"
    });

    return res.end(
      JSON.stringify(
        createManifest()
      )
    );
  }

  const catalogMatch =
    pathname.match(
      /^\/cfg\/([^/]+)\/catalog\/series\/pikpak\.json$/
    );

  if (catalogMatch) {

    const links =
      decodeConfig(
        catalogMatch[1]
      );

    const allFiles = [];

    for (const link of links) {

      try {

        const result =
          await resolveShare(link);

        allFiles.push(
          ...result.files
        );

      } catch (error) {

        console.error(
          "Share error:",
          error.message
        );
      }
    }

    let groups =
      groupFiles(allFiles);

    const search =
      requestUrl.searchParams.get(
        "search"
      );

    if (search) {

      const q =
        search.toLowerCase();

      groups =
        groups.filter(group =>
          group.title
            .toLowerCase()
            .includes(q)
        );
    }

    const metas =
      groups
        .slice(0, 100)
        .map(createMeta);

    res.writeHead(200, {
      "Content-Type":
        "application/json",

      "Access-Control-Allow-Origin":
        "*"
    });

    return res.end(
      JSON.stringify({ metas })
    );
  }

  const metaMatch =
    pathname.match(
      /^\/cfg\/([^/]+)\/meta\/series\/(pp:g:.+)\.json$/
    );

  if (metaMatch) {

    const links =
      decodeConfig(
        metaMatch[1]
      );

    const allFiles = [];

    for (const link of links) {

      try {

        const result =
          await resolveShare(link);

        allFiles.push(
          ...result.files
        );

      } catch (_) {}
    }

    const groups =
      groupFiles(allFiles);

    const group =
      groups.find(
        item =>
          makeGroupId(item.title) ===
          metaMatch[2]
      );

    res.writeHead(200, {
      "Content-Type":
        "application/json",

      "Access-Control-Allow-Origin":
        "*"
    });

    return res.end(
      JSON.stringify({
        meta: group
          ? createMeta(group)
          : null
      })
    );
  }

  const streamMatch =
    pathname.match(
      /^\/cfg\/([^/]+)\/stream\/series\/(pp:f:.+)\.json$/
    );

  if (streamMatch) {

    const links =
      decodeConfig(
        streamMatch[1]
      );

    const encoded =
      streamMatch[2].slice(5);

    let fileInfo;

    try {

      fileInfo =
        JSON.parse(
          Buffer
            .from(
              encoded,
              "base64url"
            )
            .toString("utf8")
        );

    } catch (_) {

      fileInfo = null;
    }

    if (fileInfo) {

      for (const link of links) {

        try {

          const result =
            await resolveShare(link);

          const file =
            result.files.find(
              item =>
                item.shareId ===
                  fileInfo.shareId &&
                item.id ===
                  fileInfo.id
            );

          if (file) {

            res.writeHead(200, {
              "Content-Type":
                "application/json",

              "Access-Control-Allow-Origin":
                "*"
            });

            return res.end(
              JSON.stringify({
                streams: [
                  {
                    name: "PikPak",
                    title: file.name,
                    url: file.url
                  }
                ]
              })
            );
          }

        } catch (error) {

          console.error(
            error.message
          );
        }
      }
    }

    res.writeHead(200, {
      "Content-Type":
        "application/json"
    });

    return res.end(
      JSON.stringify({
        streams: []
      })
    );
  }

  res.writeHead(404, {
    "Content-Type":
      "text/plain"
  });

  res.end("Not found");
}

const server =
  http.createServer(
    (req, res) => {

      handle(req, res)
        .catch(error => {

          console.error(error);

          res.writeHead(500, {
            "Content-Type":
              "application/json"
          });

          res.end(
            JSON.stringify({
              error: error.message
            })
          );
        });
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `PikPak Nuvio addon running on port ${PORT}`
    );

  }
);
