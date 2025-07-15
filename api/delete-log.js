// pages/api/delete-log.js

import { Octokit } from "@octokit/rest";

export const config = {
  api: { bodyParser: true },
  runtime: "nodejs",
};

export default async function handler(req, res) {
  const TEMPLATE_ORIGIN = process.env.TEMPLATE_ORIGIN || "https://oki2810.github.io";
  const origin = req.headers.origin;

  // --- 共通認証処理 ---
  const getAuthenticatedUser = async () => {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split("; ").map(c => c.split("="))
    );
    const token = cookies.access_token;
    if (!token) return null;
    try {
      const octokit = new Octokit({ auth: token });
      const { data: me } = await octokit.request("GET /user");
      const userOrigin = `https://${me.login}.github.io`;
      return { octokit, userOrigin };
    } catch {
      return null;
    }
  };

  // --- Origin 許可チェック ---
  const isOriginAllowed = (origin, userOrigin) => {
    if (!origin || !origin.endsWith(".github.io")) return false;
    return origin === TEMPLATE_ORIGIN || origin === userOrigin;
  };

  // --- CORS ヘッダー設定 ---
  const setCorsHeaders = (res, origin) => {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  // --- OPTIONS プレフライト ---
  if (req.method === "OPTIONS") {
    if (origin && origin.endsWith(".github.io")) {
      setCorsHeaders(res, origin);
      return res.status(200).end();
    }
    return res.status(403).end();
  }

  // --- POST 以外は拒否 ---
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  // --- 認証 & Origin チェック ---
  const authResult = await getAuthenticatedUser();
  if (!authResult) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const { octokit, userOrigin } = authResult;
  if (!isOriginAllowed(origin, userOrigin)) {
    return res.status(403).json({ ok: false, error: "Origin not allowed" });
  }
  setCorsHeaders(res, origin);

  try {
    const { owner, repo, path: targetPath } = req.body;
    if (!owner || !repo || !targetPath) {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }

    // 1) ログファイル削除
    let fileSha;
    try {
      const fileResp = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{+path}",
        { owner, repo, path: targetPath }
      );
      fileSha = fileResp.data.sha;
    } catch (err) {
      if (err.status === 404) {
        return res.status(404).json({ ok: false, error: "Log file not found" });
      }
      throw err;
    }
    await octokit.request(
      "DELETE /repos/{owner}/{repo}/contents/{+path}",
      {
        owner,
        repo,
        path: targetPath,
        sha: fileSha,
        message: `Delete ${targetPath}`,
      }
    );

    // 2) index.html 取得・エラー返却
    let idxData, indexSha, html;
    try {
      const resp = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{+path}",
        { owner, repo, path: "index.html" }
      );
      idxData = resp.data;
      indexSha = idxData.sha;
      html = Buffer.from(idxData.content, "base64").toString("utf8");
    } catch (err) {
      if (err.status === 404) {
        return res
          .status(400)
          .json({ ok: false, error: "index.html が存在しません。まず初期設定を行ってください。" });
      }
      throw err;
    }

    // 3) <li data-path="..."> ブロック削除
    html = html.replace(
      new RegExp(
        `(<h2[^>]*>ログ一覧</h2>[\\s\\S]*?<ul[^>]*id=["']log-list["'][^>]*>)[\\s\\S]*?` +
        `<li[\\s\\S]*?data-path="${targetPath}"[\\s\\S]*?<\\/li>[\\s\\S]*?` +
        `(</ul>)`,
        "i"
      ),
      (_, openTag, closeTag) => {
        // 中身を一度キャプチャして、対象 <li> を除去した残りだけを戻す
        const inner = html
          .match(
            /<h2[^>]*>ログ一覧<\/h2>[\s\S]*?<ul[^>]*id=["']log-list["'][^>]*>([\s\S]*?)<\/ul>/i
          )?.[1] || "";
        const filtered = inner
          .split(/(?=<li)/)
          .filter(block => !block.includes(`data-path="${targetPath}"`))
          .join("");
        return `${openTag}\n${filtered}\n${closeTag}`;
      }
    );

    // 4) 更新をコミット
    await octokit.request(
      "PUT /repos/{owner}/{repo}/contents/{+path}",
      {
        owner,
        repo,
        path: "index.html",
        message: `Remove ${targetPath} from index`,
        content: Buffer.from(html, "utf8").toString("base64"),
        sha: indexSha,
      }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("delete-log API error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
