import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  const TEMPLATE_ORIGIN = process.env.TEMPLATE_ORIGIN || "https://oki2810.github.io";
  const origin = req.headers.origin;

  // --- 共通の認証処理関数 ---
  const getAuthenticatedUser = async () => {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split("; ").map(c => c.split("="))
    );
    const token = cookies.access_token;
    
    if (!token) return null;
    
    try {
      const octokit = new Octokit({ auth: token });
      const { data: me } = await octokit.request("GET /user");
      return { octokit, userOrigin: `https://${me.login}.github.io` };
    } catch {
      return null;
    }
  };

  // --- Origin許可チェック関数 ---
  const isOriginAllowed = (origin, userOrigin) => {
    if (!origin || !origin.endsWith('.github.io')) return false;
    return origin === TEMPLATE_ORIGIN || origin === userOrigin;
  };

  // --- CORS ヘッダー設定 ---
  const setCorsHeaders = (res, origin) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  // --- OPTIONS (プリフライト) リクエスト処理 ---
  if (req.method === "OPTIONS") {
    // 認証情報を取得
    const authResult = await getAuthenticatedUser();
    const userOrigin = authResult?.userOrigin;
    
    // Origin許可チェック
    if (isOriginAllowed(origin, userOrigin)) {
      setCorsHeaders(res, origin);
      return res.status(200).end();
    }
    
    return res.status(403).end();
  }

  // --- POST リクエスト処理 ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 認証チェック
  const authResult = await getAuthenticatedUser();
  if (!authResult) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { octokit, userOrigin } = authResult;

  // Origin許可チェック
  if (!isOriginAllowed(origin, userOrigin)) {
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }

  // CORSヘッダーを設定
  setCorsHeaders(res, origin);

  // --- 並び替えロジック本体 ---
  try {
    const { owner, repo, order } = req.body;
    if (!owner || !repo || !Array.isArray(order)) {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }

    // ファイル取得
    const { data: idx } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{+path}",
      { owner, repo, path: "public/index.html" }
    );
    const sha = idx.sha;
    let html = Buffer.from(idx.content, "base64").toString("utf8");

    // <li> をマップ化
    const liMatches = Array.from(html.matchAll(/<li[\s\S]*?<\/li>/g));
    const liMap = {};
    liMatches.forEach((m) => {
      const block = m[0];
      const dm = block.match(/data-path="([^"]+)"/);
      if (dm) liMap[dm[1]] = block;
    });

    // 新 innerHTML 組み立て
    const newInner = order.map((p) => liMap[p] || "").join("\n");

    // <ul id="log-list"> を差し替え
    html = html.replace(
      /<ul[^>]*id=["']log-list["'][^>]*>[\s\S]*?<\/ul>/,
      (m) => m.replace(/>[\s\S]*?(?=<\/ul>)/, `>\n${newInner}\n`)
    );

    // 再コミット
    await octokit.request(
      "PUT /repos/{owner}/{repo}/contents/{+path}",
      {
        owner,
        repo,
        path: "public/index.html",
        message: "Reorder logs via drag-and-drop",
        content: Buffer.from(html, "utf8").toString("base64"),
        sha,
      }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reorder API error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
