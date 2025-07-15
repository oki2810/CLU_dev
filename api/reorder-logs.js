import { Octokit } from "@octokit/rest";
import Cors from 'micro-cors';
const cors = Cors({
  origin: 'https://yoshikawa04.github.io',
  allowCredentials: true,
  allowMethods: ['POST','OPTIONS'],
  allowHeaders: ['Content-Type'],
});

export default cors(async (req, res) => {
  // プリフライト
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    // --- 認証トークン取得 ---
    const cookies = Object.fromEntries(
      (req.headers.cookie || "")
        .split("; ")
        .map((c) => c.split("="))
    );
    const token = cookies.access_token;
    if (!token) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { owner, repo, order } = req.body;
    if (
      !owner ||
      !repo ||
      !Array.isArray(order)
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing parameters" });
    }

    const octokit = new Octokit({ auth: token });

    console.log("→ fetch target:", { owner, repo, path: "public/index.html" });
    const { data: root } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents",
      { owner, repo }
    );
    console.log(
      "→ root contents:",
      Array.isArray(root) ? root.map((f) => f.path) : root
    );

    // --- 1) public/index.html を取得 ---
    console.log("→ fetching content:", { owner, repo, path: "public/index.html" });
    const { data: idx } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{+path}",
      {
        owner,
        repo,
        path: "public/index.html"
      }
    );
    const sha  = idx.sha;
    let   html = Buffer.from(idx.content, "base64").toString("utf8");

    // --- 2) <li> ブロックを抽出してマップ化 ---
    const liMatches = Array.from(html.matchAll(/<li[\s\S]*?<\/li>/g));
    const liMap = {};
    liMatches.forEach((m) => {
      const block = m[0];
      const dm = block.match(/data-path="([^"]+)"/);
      if (dm) liMap[dm[1]] = block;
    });

    // --- 3) 新順序で innerHTML を組み立て ---
    const newInner = order.map((p) => liMap[p] || "").join("\n");

    // --- 4) <ul id="log-list"> の中身を差し替え ---
    html = html.replace(
      /<ul[^>]*id=["']log-list["'][^>]*>[\s\S]*?<\/ul>/,
      (match) => match.replace(
        />[\s\S]*?(?=<\/ul>)/,
        `>\n${newInner}\n`
      )
    );

    // --- 5) GitHub に再コミット ---
    const payload = {
      owner,
      repo,
      path: "public/index.html",
      message: "Reorder logs via drag-and-drop",
      content: Buffer.from(html, "utf8").toString("base64"),
      sha,
      branch,            // 念のためデフォルトブランチ名を渡しておく
    };
    console.log("→ PUT payload:", payload);
    
    await octokit.request(
      "PUT /repos/{owner}/{repo}/contents/{+path}",
      {
        owner,
        repo,
        path: "public/index.html",
        message: "Reorder logs via drag-and-drop",
        content: Buffer.from(html, "utf8").toString("base64"),
        sha
      }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("Reorder API error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err.message ?? "Unknown error" });
  }
});
