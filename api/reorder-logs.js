import { Octokit } from "@octokit/rest";

export default async function handler(req, res) {
  // Vercel の環境変数から取得
  const TEMPLATE_ORIGIN = process.env.TEMPLATE_ORIGIN;

  async function setDynamicCors() {
    const origin = req.headers.origin;
    // 認証トークン取得
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split("; ")
        .map((c) => c.split("="))
    );
    const token = cookies.access_token;
    if (!token) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return false;
    }
    // GitHub API でログインユーザー名を取得
    const octokit = new Octokit({ auth: token });
    const { data: me } = await octokit.request("GET /user");
    const userOrigin = `https://${me.login}.github.io`;

    // テンプレート or ユーザーページどちらかを許可
    if (origin !== userOrigin && origin !== TEMPLATE_ORIGIN) {
      res.status(403).json({ ok: false, error: "Origin not allowed" });
      return false;
    }

    // CORS ヘッダをセット
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return true;
  }

  // --- OPTIONS (プリフライト) ---
  if (req.method === "OPTIONS") {
    const ok = await setDynamicCors();
    if (ok) return res.status(200).end();
    return; // setDynamicCors 内でレスポンス済み
  }

  // --- POST 以外拒否 ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- CORS チェック & ヘッダセット ---
  if (!(await setDynamicCors())) return;

  // --- 実際の並び替えロジック ---
  try {
    const { owner, repo, order } = req.body;
    if (!owner || !repo || !Array.isArray(order)) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing parameters" });
    }

    const octokit2 = new Octokit({ auth: cookies.access_token });

    // 1) public/index.html を取得
    const { data: idx } = await octokit2.request(
      "GET /repos/{owner}/{repo}/contents/{+path}",
      {
        owner,
        repo,
        path: "public/index.html",
      }
    );
    const sha = idx.sha;
    let html = Buffer.from(idx.content, "base64").toString("utf8");

    // 2) <li> ブロックを抽出してマップ化
    const liMatches = Array.from(html.matchAll(/<li[\s\S]*?<\/li>/g));
    const liMap = {};
    liMatches.forEach((m) => {
      const block = m[0];
      const dm = block.match(/data-path="([^"]+)"/);
      if (dm) liMap[dm[1]] = block;
    });

    // 3) 新しい順序で innerHTML を組み立て
    const newInner = order.map((p) => liMap[p] || "").join("\n");

    // 4) <ul id="log-list"> 部分を差し替え
    html = html.replace(
      /<ul[^>]*id=["']log-list["'][^>]*>[\s\S]*?<\/ul>/,
      (m) => m.replace(/>[\s\S]*?(?=<\/ul>)/, `>\n${newInner}\n`)
    );

    // 5) 再コミット
    await octokit2.request(
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
    return res
      .status(500)
      .json({ ok: false, error: err.message || "Unknown error" });
  }
}
