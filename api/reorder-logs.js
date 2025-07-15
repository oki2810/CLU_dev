import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  console.log(
    "🌟 TEMPLATE_ORIGIN:",
    process.env.TEMPLATE_ORIGIN,
    "– incoming Origin:",
    req.headers.origin
  );
  const TEMPLATE_ORIGIN = process.env.TEMPLATE_ORIGIN || "https://oki2810.github.io";
  const origin = req.headers.origin;

  // プリフライト（認証不要）-------------------
  if (req.method === "OPTIONS") {
    if (origin === TEMPLATE_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      return res.status(200).end();
    } else {
      return res.status(403).end();
    }
  }

  // POST 以外 NG ------------------------------
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // 1) 認証トークン取得
  const cookies = Object.fromEntries(
    (req.headers.cookie || "")
      .split("; ")
      .map((c) => c.split("="))
  );
  const token = cookies.access_token;
  if (!token) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // 2) GitHub API でログインユーザー名を取得
  const octokit = new Octokit({ auth: token });
  let me;
  try {
    ({ data: me } = await octokit.request("GET /user"));
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
  const userOrigin = `https://${me.login}.github.io`;

  // 3) オリジンチェック
  if (origin !== userOrigin && origin !== TEMPLATE_ORIGIN) {
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }

  // 4) CORS ヘッダセット
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
