// pages/api/reorder-logs.js

import { Octokit } from "@octokit/rest";

export const config = {
  api: { bodyParser: true },
  runtime: "nodejs",
};

export default async function handler(req, res) {
  const TEMPLATE_ORIGIN = process.env.TEMPLATE_ORIGIN || "https://oki2810.github.io";
  const origin = req.headers.origin;

  console.log(`[${new Date().toISOString()}] ${req.method} request from origin: ${origin}`);
  console.log(`TEMPLATE_ORIGIN: ${TEMPLATE_ORIGIN}`);

  // --- 共通の認証処理関数 ---
  const getAuthenticatedUser = async () => {
    console.log("Raw cookie header:", req.headers.cookie);
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split("; ").map(c => c.split("="))
    );
    console.log("Parsed cookies:", Object.keys(cookies));
    const token = cookies.access_token;
    console.log(`Token exists: ${!!token}`);
    if (!token) {
      console.log("No access token found");
      return null;
    }
    try {
      const octokit = new Octokit({ auth: token });
      const { data: me } = await octokit.request("GET /user");
      const userOrigin = `https://${me.login}.github.io`;
      console.log(`Authenticated user: ${me.login}, userOrigin: ${userOrigin}`);
      return { octokit, userOrigin, username: me.login };
    } catch (error) {
      console.log("Authentication failed:", error.message);
      return null;
    }
  };

  // --- Origin許可チェック関数 ---
  const isOriginAllowed = (origin, userOrigin) => {
    console.log(`Checking origin: ${origin}`);
    console.log(`Against TEMPLATE_ORIGIN: ${TEMPLATE_ORIGIN}`);
    console.log(`Against userOrigin: ${userOrigin}`);
    if (!origin || !origin.endsWith(".github.io")) {
      console.log("Origin rejected: not a github.io domain");
      return false;
    }
    const allowed = origin === TEMPLATE_ORIGIN || origin === userOrigin;
    console.log(`Origin allowed: ${allowed}`);
    return allowed;
  };

  // --- CORS ヘッダー設定 ---
  const setCorsHeaders = (res, origin) => {
    console.log(`Setting CORS headers for origin: ${origin}`);
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  // --- OPTIONS (プリフライト) リクエスト処理 ---
  if (req.method === "OPTIONS") {
    console.log("Processing OPTIONS request");
    if (origin && origin.endsWith(".github.io")) {
      console.log("OPTIONS request approved - github.io domain detected");
      setCorsHeaders(res, origin);
      return res.status(200).end();
    }
    console.log("OPTIONS request rejected - not a github.io domain");
    return res.status(403).end();
  }

  // --- POST リクエスト処理 ---
  if (req.method !== "POST") {
    console.log(`Method not allowed: ${req.method}`);
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  console.log("Processing POST request");

  // 認証チェック
  const authResult = await getAuthenticatedUser();
  if (!authResult) {
    console.log("POST request unauthorized");
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const { octokit, userOrigin } = authResult;

  // Origin許可チェック
  if (!isOriginAllowed(origin, userOrigin)) {
    console.log("POST request origin not allowed");
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }

  // CORSヘッダーを設定
  setCorsHeaders(res, origin);

  // --- 並び替えロジック本体 ---
  try {
    const { owner, repo, order } = req.body;
    console.log(`Request body: owner=${owner}, repo=${repo}, order length=${order?.length}`);
    if (!owner || !repo || !Array.isArray(order)) {
      console.log("Missing or invalid parameters");
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }

    // リポジトリ存在確認
    try {
      const { data: repoInfo } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
      console.log(`Repository found: ${repoInfo.full_name}`);
    } catch (repoErr) {
      console.log("Repository not found or not accessible:", repoErr.message);
      return res.status(404).json({ ok: false, error: "Repository not found or not accessible" });
    }

    // 1) index.html を取得。404 ならクライアントエラー返却
    let idxData, sha, html;
    try {
      const resp = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{+path}",
        { owner, repo, path: "index.html" }
      );
      idxData = resp.data;
      sha = idxData.sha;
      html = Buffer.from(idxData.content, "base64").toString("utf8");
      console.log("Fetched index.html length:", html.length);
    } catch (err) {
      if (err.status === 404) {
        console.log("index.html not found");
        return res
          .status(400)
          .json({ ok: false, error: "index.html が存在しません。まず初期設定を行ってください。" });
      }
      throw err;
    }

    // 2) <li> をマップ化
    const liMatches = Array.from(html.matchAll(/<li[\s\S]*?<\/li>/g));
    console.log(`Found ${liMatches.length} <li> elements`);
    const liMap = {};
    liMatches.forEach((m, i) => {
      const block = m[0];
      const dm = block.match(/data-path="([^"]+)"/);
      if (dm) {
        liMap[dm[1]] = block;
      } else {
        console.log(`Li ${i} missing data-path: preview ${block.slice(0, 50)}...`);
      }
    });

    // 3) 新 innerHTML 組み立て
    const newInner = order.map(path => liMap[path] || "").join("\n");

    // 4) <ul id="log-list"> を置き換え
    html = html.replace(
      /(<div[^>]+class=["']container[^>]*>[\s\S]*?<h2[^>]*>ログ一覧<\/h2>\s*<ul[^>]+id=["']log-list["'][^>]*>)([\s\S]*?)(<\/ul>)/i,
      (_, openTag, _oldInner, closeTag) => {
        // newInner は事前に組み立て済みのソート後 <li> 群
        return `${openTag}\n${newInner}\n${closeTag}`;
      }
    );

    // 5) 更新をコミット
    await octokit.request(
      "PUT /repos/{owner}/{repo}/contents/{+path}",
      {
        owner,
        repo,
        path: "index.html",
        message: "Reorder logs via drag-and-drop",
        content: Buffer.from(html, "utf8").toString("base64"),
        sha,
      }
    );

    console.log("Reorder completed successfully");
    return res.json({ ok: true });
  } catch (err) {
    console.error("Reorder API error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
