// pages/api/upload.js

import fs from "fs";
import path from "path";
// IncomingForm を直接インポート
import { IncomingForm } from "formidable";
import { Octokit } from "@octokit/rest";
export const config = {
  api: { bodyParser: false },
  runtime: "nodejs",
};

const DEFAULT_INDEX = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>アップロード済みログ</title>
  <link
    href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
    rel="stylesheet"
  />
</head>
<body>
  <div class="container py-5">
    <h1 class="mb-4">アップロード済みログ</h1>
    <ul id="log-list" class="list-group"></ul>
  </div>
  <script src="norobot.js"></script>
</body>
</html>`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  }

  try {
    // --- 認証トークン取得 ---
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split("; ").map((c) => c.split("="))
    );
    const token = cookies.access_token;
    if (!token) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // --- multipart/form-data を formidable でパース ---
    const form = new IncomingForm({
      multiples: false,
      maxFileSize: 2 * 1024 * 1024,
    });
    const { fields, files } = await new Promise((ful, rej) => {
      form.parse(req, (err, fields, files) => {
        if (err) return rej(err);
        ful({ fields, files });
      });
    });

    console.log("fields:", fields);
    console.log("files:", files);

    // 必須フィールドチェック
    const owner = Array.isArray(fields.owner) ? fields.owner[0] : fields.owner;
    const repo = Array.isArray(fields.repo) ? fields.repo[0] : fields.repo;
    const filePath = Array.isArray(fields.path) ? fields.path[0] : fields.path;
    const linkText = Array.isArray(fields.linkText)
      ? fields.linkText[0]
      : fields.linkText;
    const scenarioName = Array.isArray(fields.scenarioName)
      ? fields.scenarioName[0]
      : fields.scenarioName;

    if (!owner || !repo || !filePath || !linkText || !scenarioName) {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }

    let htmlFile = files.htmlFile;
    if (Array.isArray(htmlFile)) htmlFile = htmlFile[0];
    const tempPath = htmlFile.filepath || htmlFile.path;
    if (!htmlFile || typeof tempPath !== "string") {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }
    const octokit = new Octokit({ auth: token });

    // 既存ファイルの有無をチェックし、存在する場合はエラーを返す
    try {
      await octokit.repos.getContent({ owner, repo, path: filePath });
      return res
        .status(400)
        .json({ ok: false, error: "同名のログが存在します" });
    } catch (err) {
      if (err.status !== 404) {
        throw err;
      }
      // status === 404 の場合は新規ファイルとして続行
    }

    // 1) アップロードされたログファイルを blob 化
    const buffer = fs.readFileSync(tempPath);
    const fileB64 = buffer.toString("base64");
    const { data: logBlob } = await octokit.git.createBlob({
      owner,
      repo,
      content: fileB64,
      encoding: "base64",
    });

    // 2) index.html を取得。なければエラー返却
    let html, indexSha;
    try {
      const idx = await octokit.repos.getContent({
        owner,
        repo,
        path: "index.html",
      });
      indexSha = idx.data.sha;
      html = Buffer.from(idx.data.content, "base64").toString("utf8");
    } catch (err) {
      if (err.status === 404) {
        // index.html がまだ存在しない場合は初期設定を促してクライアントにエラー返却
        return res.status(400).json({
          ok: false,
          error: "index.html が存在しません。まず初期設定を行ってください。",
        });
      }
      throw err;
    }

    // 3) クライアント設定＆loglist.js 読み込みを挿入
    if (!html.includes("window.CCU_CONFIG")) {
      const configScript = `<script>
    window.CCU_CONFIG = { owner: '${owner}', repo: '${repo}', apiBase: '${
        process.env.API_BASE_URL || "https://clu-dev.vercel.app"
      }' };
    </script>`;
      const loaderScript = `<script src="loglist.js"></script>`;
      html = html.replace(
        /(<script\s+src=["']norobot\.js["']><\/script>)/,
        `${configScript}\n${loaderScript}\n$1`
      );
    }

    // 4) 新規 <li> ブロックを組み立て
    const timestamp = new Date().toISOString();
    const newItem = `
<li class="list-group-item d-flex justify-content-between align-items-center"
    data-date="${timestamp}"
    data-path="${filePath}"
>
  <span>
    <a href="${filePath}" class="ms-2">${linkText}</a>
  </span>
  <button type="button" class="btn btn-sm btn-danger btn-delete">削除</button>
</li>
`.trim();

    // 5) <ul id="log-list"> の中に差し込む
    const hasLogList = /<ul[\s\S]*?\bid=["']log-list["'][\s\S]*?>/i.test(html);
    if (!hasLogList) {
      // デフォルト UL の一発挿入はこれまで通り
      html = html.replace(
        /(<h2[^>]*>ログ一覧<\/h2>)/i,
        `$1\n<ul id="log-list" class="list-group"></ul>`
      );
    }

    // ここで必ず「既存 UL がある or いま挿入したUL」に <li> マージをかける
    html = html.replace(
      /(<ul[^>]+id=["']log-list["'][^>]*>)([\s\S]*?)(<\/ul>)/i,
      (_, openTag, oldInner, closeTag) => {
        // oldInner にある既存の <li> を全部拾う
        const existingItems = oldInner.match(/<li[\s\S]*?<\/li>/g) || [];
        // newItem はアップロードされた分（定義済み）を追加
        const allItems = [...existingItems, newItem];

        // 必要なら日付順ソートする
        allItems.sort((a, b) => {
          const da = a.match(/data-date="([^"]+)"/)[1];
          const db = b.match(/data-date="([^"]+)"/)[1];
          return new Date(db) - new Date(da); // 新しい順
        });

        // join して戻す
        const combined = allItems.join("\n  ");
        return `${openTag}\n  ${combined}\n${closeTag}`;
      }
    );

    // 6) 更新後の index.html を blob 化
    const { data: idxBlob } = await octokit.git.createBlob({
      owner,
      repo,
      content: Buffer.from(html, "utf8").toString("base64"),
      encoding: "base64",
    });

    // 7) 単一コミットでまとめてプッシュ (tree→commit→ref update)
    const { data: repoInfo } = await octokit.repos.get({ owner, repo });
    const branch = repoInfo.default_branch;
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const baseCommitSha = refData.object.sha;
    const { data: baseCommit } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: baseCommitSha,
    });

    // tree アイテム配列
    const treeItems = [
      { path: filePath, mode: "100644", type: "blob", sha: logBlob.sha },
      { path: "index.html", mode: "100644", type: "blob", sha: idxBlob.sha },
    ];

    // norobot.js / loglist.js を必要に応じて追加
    for (const asset of ["norobot.js", "loglist.js"]) {
      try {
        await octokit.repos.getContent({ owner, repo, path: asset });
      } catch (e) {
        if (e.status === 404) {
          const blob = fs.readFileSync(
            path.join(process.cwd(), "public", asset)
          );
          const { data } = await octokit.git.createBlob({
            owner,
            repo,
            content: blob.toString("base64"),
            encoding: "base64",
          });
          treeItems.push({
            path: asset,
            mode: "100644",
            type: "blob",
            sha: data.sha,
          });
        }
      }
    }

    // tree→commit→ref update
    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: baseCommit.tree.sha,
      tree: treeItems,
    });
    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message: `Upload ${filePath}`,
      tree: newTree.sha,
      parents: [baseCommitSha],
    });
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
    });

    // 成功レスポンスにコミット SHA を含める
    return res.json({ ok: true, commit: newCommit.sha });
  } catch (err) {
    console.error("Upload API error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err.message || "Unknown error" });
  }
}
