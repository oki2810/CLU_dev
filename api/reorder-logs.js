import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  const TEMPLATE_ORIGIN = process.env.TEMPLATE_ORIGIN || "https://oki2810.github.io";
  const origin = req.headers.origin;

  // --- 1) トークン取得（OPTIONS でも認証付きプリフライトを通すため） ---
  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split("; ").map(c => c.split("="))
  );
  const token = cookies.access_token;
  let userOrigin;
  let octokit;
  if (token) {
    try {
      octokit = new Octokit({ auth: token });
      const { data: me } = await octokit.request("GET /user");
      userOrigin = `https://${me.login}.github.io`;
    } catch {
      // token 無効なら userOrigin は undefined のまま
    }
  }

  // --- 2) プリフライトをユーザー OR テンプレどちらでも通す ---
  if (req.method === "OPTIONS") {
    if (origin === TEMPLATE_ORIGIN || origin === userOrigin) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods",     "POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers",     "Content-Type");
      return res.status(200).end();
    }
    return res.status(403).end();
  }

  // --- 3) POST 以外拒否 ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 4) 改めて認証＆ Origin チェック（POST 本体） ---
  if (!token) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  if (origin !== TEMPLATE_ORIGIN && origin !== userOrigin) {
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }

  // --- 5) CORS ヘッダセット ＋ 並び替えロジック ---
  res.setHeader("Access-Control-Allow-Origin",      origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods",     "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",     "Content-Type");

  // --- 並び替えロジック本体 -------------------
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
